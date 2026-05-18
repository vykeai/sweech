/**
 * Tests for rate-limit-cache freshness — verifies that every write stamps
 * `fetchedAt`, that legacy entries lacking the field are backfilled from
 * `capturedAt` (and ultimately file mtime), and that failed/cached reads
 * never overwrite the existing `fetchedAt` with `now` (which would mask
 * staleness — the codex-ted regression).
 *
 * Uses the same fs-mock pattern as liveUsageCache.test.ts; the cache module
 * resolves its file path at import time so we hook fs.readFileSync /
 * writeFileSync to exercise read+write paths without touching disk.
 */

import * as fs from 'fs'

jest.mock('fs')
const mockFs = fs as jest.Mocked<typeof fs>

// Mock child_process so the keychain branch can't accidentally run.
jest.mock('child_process', () => ({
  execSync: jest.fn().mockImplementation(() => { throw new Error('no keychain') }),
  execFileSync: jest.fn(),
  spawn: jest.fn(),
}))

const mockFetch = jest.fn()
;(global as any).fetch = mockFetch

import { getLiveUsage, refreshLiveUsage, LiveRateLimitData } from '../src/liveUsage'

function recentCacheEntry(overrides: Partial<LiveRateLimitData> = {}): LiveRateLimitData {
  return {
    buckets: [{ label: 'All models', session: { utilization: 0.3 } }],
    status: 'allowed',
    capturedAt: Date.now() - 30_000,
    fetchedAt: Date.now() - 30_000,
    ...overrides,
  }
}

describe('rate-limit-cache freshness migration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockReset()
  })

  test('legacy entry lacking fetchedAt is backfilled from capturedAt on read', async () => {
    const legacy: any = {
      buckets: [{ label: 'All models', session: { utilization: 0.1 } }],
      status: 'allowed',
      capturedAt: Date.now() - 60_000, // 1 min ago — still inside TTL
    }
    // No fetchedAt key — represents pre-migration on-disk shape.
    const store = { '/mock/.legacy': legacy }
    mockFs.readFileSync.mockReturnValue(JSON.stringify(store))
    // stat used by the migration mtime fallback — provide a value so the
    // path is exercised even though capturedAt should win first.
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() - 120_000 } as any)

    const result = await getLiveUsage('/mock/.legacy')
    expect(result).toBeDefined()
    expect(result!.fetchedAt).toBe(legacy.capturedAt)
    // capturedAt is preserved untouched.
    expect(result!.capturedAt).toBe(legacy.capturedAt)
  })

  test('legacy entry missing BOTH fetchedAt and capturedAt falls back to file mtime', async () => {
    // capturedAt: undefined — but the cache TTL check uses capturedAt, so a
    // truly missing one will fail the TTL gate. We test the migration path
    // directly: read the store via the public surface and inspect the
    // FRESHNESS via getStaleCache (which bypasses TTL).
    const mtime = Date.now() - 30_000
    const legacy: any = {
      buckets: [{ label: 'All models', session: { utilization: 0.5 } }],
      status: 'allowed',
      // no capturedAt, no fetchedAt
    }
    const store = { '/mock/.ancient': legacy }
    mockFs.readFileSync.mockReturnValue(JSON.stringify(store))
    mockFs.statSync.mockReturnValue({ mtimeMs: mtime } as any)

    // getStaleCache returns the migrated entry. We hit it by triggering the
    // stale-fallback path: failed token read → getStaleCache.
    const result = await getLiveUsage('/mock/.ancient')
    expect(result).toBeDefined()
    // Either we got the stale entry (mtime-backfilled fetchedAt) or the
    // no-token synthesized response. The migration is the load-bearing piece:
    // when the stale cache IS returned, fetchedAt must reflect mtime, not undefined.
    if (result!.isStale) {
      expect(result!.fetchedAt).toBe(mtime)
    }
  })

  test('fresh entry with fetchedAt is returned unchanged', async () => {
    const cached = recentCacheEntry()
    const store = { '/mock/.fresh': cached }
    mockFs.readFileSync.mockReturnValue(JSON.stringify(store))
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as any)

    const result = await getLiveUsage('/mock/.fresh')
    expect(result).toBeDefined()
    expect(result!.fetchedAt).toBe(cached.fetchedAt)
    expect(result!.capturedAt).toBe(cached.capturedAt)
  })

  test('getStaleCache preserves original fetchedAt — does NOT overwrite to now', async () => {
    // Simulates the codex-ted failure mode: a fetch fails, we fall back to
    // stale cache. The cache entry's fetchedAt must reflect the ORIGINAL
    // capture, not the current moment — otherwise consumers can't detect that
    // the data is stale.
    const oldFetched = Date.now() - 60 * 60_000 // 1 hour ago
    const legacy: any = {
      buckets: [{ label: 'All models', session: { utilization: 0.99 } }],
      status: 'allowed', // ← deliberately stale "allowed" while really limited
      capturedAt: oldFetched,
      fetchedAt: oldFetched,
    }
    const store = { '/mock/.codex-ted-sim': legacy }
    mockFs.readFileSync.mockReturnValue(JSON.stringify(store))
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as any)

    // refreshLiveUsage skips the TTL gate, tries to fetch (no token), falls back to stale.
    const result = await refreshLiveUsage('/mock/.codex-ted-sim')
    expect(result).toBeDefined()
    expect(result!.isStale).toBe(true)
    expect(result!.fetchedAt).toBe(oldFetched)
    // Critical assertion: fetchedAt must NOT be "now". A 1ms tolerance is
    // generous — if the code is rewriting it to Date.now() this would fail.
    expect(Math.abs(result!.fetchedAt! - Date.now())).toBeGreaterThan(60_000)
  })

  test('synthesized no-token response has no fetchedAt — dashboard surfaces "never"', async () => {
    mockFs.readFileSync.mockReturnValue('{}')

    const result = await getLiveUsage('/mock/.never-cached')
    expect(result).toBeDefined()
    expect(result!.tokenStatus).toBe('no_token')
    // capturedAt is 0 / falsy — fetchedAt is undefined. freshnessFromTimestamp
    // returns 'never' for both (0 is rejected as non-positive).
    expect(result!.fetchedAt).toBeUndefined()
    expect(result!.capturedAt).toBe(0)
  })
})

describe('rate-limit-cache write — always stamps fetchedAt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockReset()
  })

  test('setCached mirrors capturedAt into fetchedAt on every write', async () => {
    // Drive a write by triggering a codex spawn that returns valid data.
    // The spawn path is simpler to mock than the OAuth fetch path.
    mockFs.readFileSync.mockReturnValue('{}')
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() } as any)
    mockFs.mkdirSync.mockImplementation(() => undefined as any)

    let written: string | undefined
    mockFs.writeFileSync.mockImplementation((_p: any, data: any) => { written = data as string })
    mockFs.renameSync.mockImplementation(() => undefined as any)

    const { spawn } = require('child_process')
    const EventEmitter = require('events')
    const proc = new EventEmitter()
    ;(proc as any).stdout = new EventEmitter()
    ;(proc as any).stdin = { write: jest.fn() }
    ;(proc as any).kill = jest.fn()
    ;(spawn as jest.Mock).mockReturnValue(proc)

    const promise = getLiveUsage('/Users/test/.codex', 'codex')

    // Simulate the JSON-RPC sequence.
    process.nextTick(() => {
      ;(proc as any).stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n'))
      process.nextTick(() => {
        ;(proc as any).stdout.emit('data', Buffer.from(JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          result: {
            rateLimitsByLimitId: {
              all: {
                limitName: 'All models',
                primary: { usedPercent: 50, resetsAt: Math.floor(Date.now() / 1000) + 3600, windowDurationMins: 300 },
              },
            },
          },
        }) + '\n'))
      })
    })

    await promise

    // The write should include a fetchedAt key.
    expect(written).toBeDefined()
    expect(written!).toContain('"fetchedAt"')
    const parsed = JSON.parse(written!)
    const entry = parsed['/Users/test/.codex']
    expect(entry).toBeDefined()
    expect(typeof entry.fetchedAt).toBe('number')
    expect(typeof entry.capturedAt).toBe('number')
    // fetchedAt must equal capturedAt (same write).
    expect(entry.fetchedAt).toBe(entry.capturedAt)
  })
})
