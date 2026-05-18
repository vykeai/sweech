/**
 * Tests for src/freshness.ts — FreshnessStamp helper used by the upcoming
 * dashboard to classify on-disk cache age uniformly across data sources.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  freshnessFromTimestamp,
  freshnessFromFileMtime,
  fileMtimeMs,
  FRESH_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
} from '../src/freshness'

describe('freshnessFromTimestamp', () => {
  const NOW = 1_780_000_000_000

  test('returns "never" for null', () => {
    const s = freshnessFromTimestamp(null, NOW)
    expect(s).toEqual({ fetchedAt: null, ageMs: null, state: 'never' })
  })

  test('returns "never" for undefined', () => {
    const s = freshnessFromTimestamp(undefined, NOW)
    expect(s.state).toBe('never')
    expect(s.fetchedAt).toBeNull()
    expect(s.ageMs).toBeNull()
  })

  test('returns "never" for 0, negative, NaN, Infinity', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(freshnessFromTimestamp(bad, NOW).state).toBe('never')
    }
  })

  test('returns "fresh" when within FRESH_THRESHOLD_MS', () => {
    const s = freshnessFromTimestamp(NOW - 60_000, NOW) // 1 min
    expect(s.state).toBe('fresh')
    expect(s.ageMs).toBe(60_000)
    expect(s.fetchedAt).toBe(NOW - 60_000)
  })

  test('boundary: just under FRESH_THRESHOLD_MS is "fresh"', () => {
    const s = freshnessFromTimestamp(NOW - (FRESH_THRESHOLD_MS - 1), NOW)
    expect(s.state).toBe('fresh')
  })

  test('boundary: exactly FRESH_THRESHOLD_MS is "stale"', () => {
    const s = freshnessFromTimestamp(NOW - FRESH_THRESHOLD_MS, NOW)
    expect(s.state).toBe('stale')
  })

  test('returns "stale" between FRESH and STALE thresholds', () => {
    const s = freshnessFromTimestamp(NOW - 10 * 60_000, NOW) // 10 min
    expect(s.state).toBe('stale')
  })

  test('boundary: exactly STALE_THRESHOLD_MS is "very-stale"', () => {
    const s = freshnessFromTimestamp(NOW - STALE_THRESHOLD_MS, NOW)
    expect(s.state).toBe('very-stale')
  })

  test('returns "very-stale" past STALE_THRESHOLD_MS', () => {
    const s = freshnessFromTimestamp(NOW - 60 * 60_000, NOW) // 1 hour
    expect(s.state).toBe('very-stale')
    expect(s.ageMs).toBe(60 * 60_000)
  })

  test('future timestamp (clock skew) clamps ageMs to 0 and is "fresh"', () => {
    const s = freshnessFromTimestamp(NOW + 30_000, NOW)
    expect(s.state).toBe('fresh')
    expect(s.ageMs).toBe(0)
  })

  test('uses Date.now() when nowMs omitted', () => {
    const s = freshnessFromTimestamp(Date.now() - 1000)
    expect(s.state).toBe('fresh')
    expect(s.ageMs).toBeGreaterThanOrEqual(0)
    expect(s.ageMs!).toBeLessThan(5000)
  })
})

describe('freshnessFromFileMtime', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-freshness-'))
  })
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  })

  test('returns "never" when file does not exist', () => {
    const s = freshnessFromFileMtime(path.join(tmp, 'missing.json'))
    expect(s.state).toBe('never')
    expect(s.fetchedAt).toBeNull()
  })

  test('returns "fresh" when file mtime is recent', () => {
    const p = path.join(tmp, 'recent.json')
    fs.writeFileSync(p, '{}')
    const s = freshnessFromFileMtime(p)
    expect(s.state).toBe('fresh')
    expect(s.fetchedAt).toBeGreaterThan(0)
  })

  test('returns "very-stale" when file mtime is old', () => {
    const p = path.join(tmp, 'old.json')
    fs.writeFileSync(p, '{}')
    const past = (Date.now() - 60 * 60_000) / 1000 // 1 hour ago in seconds
    fs.utimesSync(p, past, past)
    const s = freshnessFromFileMtime(p)
    expect(s.state).toBe('very-stale')
  })
})

describe('fileMtimeMs', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-freshness-')) })
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

  test('returns null when file missing', () => {
    expect(fileMtimeMs(path.join(tmp, 'nope'))).toBeNull()
  })

  test('returns positive number when file exists', () => {
    const p = path.join(tmp, 'x')
    fs.writeFileSync(p, 'x')
    const m = fileMtimeMs(p)
    expect(typeof m).toBe('number')
    expect(m!).toBeGreaterThan(0)
  })
})
