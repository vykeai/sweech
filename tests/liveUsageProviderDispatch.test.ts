/**
 * Integration test for getLiveUsage / refreshLiveUsage provider dispatch.
 *
 * Closes the wiring gap surfaced by the wave-1 integration audit: the
 * provider-specific fetchers exist (fetchKimiRateLimit, fetchQwenRateLimit,
 * fetchDeepSeekRateLimit, fetchZaiRateLimit) but were never reachable from
 * the public API path. These tests prove that:
 *
 *   - `getLiveUsage(configDir, undefined, 'kimi')` reads the API key from
 *     the profile's settings.json and dispatches to fetchKimiRateLimit
 *   - Each supported provider id (and its aliases) routes correctly
 *   - Missing API key short-circuits without an upstream call
 *   - Unsupported provider names fall through to the Anthropic OAuth path
 *     (preserves backward compatibility)
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-livedispatch-'))

// Mock fetch so no network calls happen.
const mockFetch = jest.fn()
;(global as any).fetch = mockFetch

afterAll(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  jest.resetModules()
  mockFetch.mockReset()

  // Sandbox homedir so the rate-limit cache path
  // (~/.sweech/rate-limit-cache.json) stays inside TMP_HOME and tests
  // don't poison the real user cache.
  jest.doMock('os', () => {
    const real = jest.requireActual('os')
    return { ...real, homedir: () => TMP_HOME }
  })
  jest.doMock('node:os', () => {
    const real = jest.requireActual('node:os')
    return { ...real, homedir: () => TMP_HOME }
  })
})

function writeSettingsForProfile(commandName: string, env: Record<string, string>): string {
  const configDir = path.join(TMP_HOME, `.${commandName}`)
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ env }, null, 2))
  return configDir
}

function makeOkHeadersResponse(): any {
  // OpenAI-compat headers — limit=100, remaining=30 → 70% util.
  const headers = new Map<string, string>([
    ['x-ratelimit-limit-requests', '100'],
    ['x-ratelimit-remaining-requests', '30'],
    ['x-ratelimit-reset-requests', '60s'],
  ])
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => '',
    json: async () => ({}),
  }
}

describe('getLiveUsage provider dispatch', () => {
  test('kimi provider routes to fetchKimiRateLimit with the settings.env api key', async () => {
    const configDir = writeSettingsForProfile('claude-kimi-work', { KIMI_API_KEY: 'kimi-secret-123' })
    mockFetch.mockResolvedValueOnce(makeOkHeadersResponse())

    const liveUsage = require('../src/liveUsage')
    const data = await liveUsage.getLiveUsage(configDir, undefined, 'kimi')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(String(url)).toMatch(/moonshot|kimi/i)
    expect(opts.headers.Authorization).toBe('Bearer kimi-secret-123')
    expect(data).not.toBeNull()
    expect(data.provider).toBe('kimi')
    // 1 - 30/100 = 0.7 utilization → 'allowed' (under 0.8)
    expect(data.status).toBe('allowed')
    expect(data.buckets[0].session?.utilization).toBeCloseTo(0.7, 5)
  })

  test('kimi-coding alias maps to the same kimi fetcher', async () => {
    const configDir = writeSettingsForProfile('codex-kimi', { KIMI_CODING_API_KEY: 'coding-secret' })
    mockFetch.mockResolvedValueOnce(makeOkHeadersResponse())

    const liveUsage = require('../src/liveUsage')
    await liveUsage.getLiveUsage(configDir, undefined, 'kimi-coding')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(String(url)).toMatch(/moonshot|kimi/i)
    expect(opts.headers.Authorization).toBe('Bearer coding-secret')
  })

  test('glm provider routes to fetchZaiRateLimit with GLM_API_KEY', async () => {
    const configDir = writeSettingsForProfile('claude-glm', { GLM_API_KEY: 'glm-key-xyz' })
    mockFetch.mockResolvedValueOnce(makeOkHeadersResponse())

    const liveUsage = require('../src/liveUsage')
    const data = await liveUsage.getLiveUsage(configDir, undefined, 'glm')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(String(url)).toMatch(/zhipu|z\.ai|bigmodel/i)
    expect(opts.headers.Authorization).toBe('Bearer glm-key-xyz')
    expect(data?.provider).toBe('zai')
  })

  test('deepseek provider routes to fetchDeepSeekRateLimit', async () => {
    const configDir = writeSettingsForProfile('claude-deepseek', { DEEPSEEK_API_KEY: 'ds-key' })
    mockFetch.mockResolvedValueOnce(makeOkHeadersResponse())

    const liveUsage = require('../src/liveUsage')
    const data = await liveUsage.getLiveUsage(configDir, undefined, 'deepseek')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(String(url)).toMatch(/deepseek/i)
    expect(opts.headers.Authorization).toBe('Bearer ds-key')
    expect(data?.provider).toBe('deepseek')
  })

  test('dashscope provider routes to fetchQwenRateLimit', async () => {
    const configDir = writeSettingsForProfile('claude-qwen', { DASHSCOPE_API_KEY: 'ds-qwen-key' })
    mockFetch.mockResolvedValueOnce(makeOkHeadersResponse())

    const liveUsage = require('../src/liveUsage')
    const data = await liveUsage.getLiveUsage(configDir, undefined, 'dashscope')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(String(url)).toMatch(/dashscope|aliyun|qwen/i)
    expect(opts.headers.Authorization).toBe('Bearer ds-qwen-key')
    expect(data?.provider).toBe('qwen')
  })

  test('qwen alias also routes to fetchQwenRateLimit', async () => {
    const configDir = writeSettingsForProfile('claude-qwen2', { QWEN_API_KEY: 'qwen-alias-key' })
    mockFetch.mockResolvedValueOnce(makeOkHeadersResponse())

    const liveUsage = require('../src/liveUsage')
    await liveUsage.getLiveUsage(configDir, undefined, 'qwen')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer qwen-alias-key')
  })

  test('missing api key short-circuits without an upstream fetch', async () => {
    const configDir = writeSettingsForProfile('claude-bad-kimi', { /* no KIMI_API_KEY */ })

    const liveUsage = require('../src/liveUsage')
    const data = await liveUsage.getLiveUsage(configDir, undefined, 'kimi')

    expect(mockFetch).not.toHaveBeenCalled()
    expect(data).toBeNull()
  })

  test('unsupported provider name falls through to Anthropic OAuth path (no dispatch)', async () => {
    const configDir = writeSettingsForProfile('claude-unknown', { OPENAI_API_KEY: 'whatever' })

    const liveUsage = require('../src/liveUsage')
    // 'openai' isn't in PROVIDER_DISPATCH; on macOS this would attempt
    // Keychain read for the Anthropic OAuth path, which returns no_token
    // in this sandboxed env. Crucially: the new provider dispatch does
    // NOT fire, so mockFetch stays untouched by *us* (the OAuth path may
    // call fetch separately, but we're asserting no provider-fetch route).
    const result = await liveUsage.getLiveUsage(configDir, undefined, 'openai')

    // Either null/empty buckets — point is the dispatch was skipped.
    expect(result).toBeDefined()
    // None of our provider URLs should have been hit.
    for (const call of mockFetch.mock.calls) {
      const url = String(call[0])
      expect(url).not.toMatch(/moonshot|deepseek|zhipu|dashscope/i)
    }
  })

  test('codex cliType wins over provider — uses fetchCodexRateLimits, never the provider dispatch', async () => {
    // A codex profile pointed at a kimi provider should still go through
    // the codex app-server path (which the existing cliType check handles)
    // — not the new provider dispatch — because the cliType branch comes
    // first in getLiveUsage.
    const configDir = writeSettingsForProfile('codex-kimi-wrapped', { KIMI_API_KEY: 'shouldnt-be-used' })

    const liveUsage = require('../src/liveUsage')
    // configDir is `.codex-kimi-wrapped`, not `.codex` — fetchCodexRateLimits
    // short-circuits non-codex dirs and returns null. We just need to
    // assert mockFetch wasn't called via the provider path.
    await liveUsage.getLiveUsage(configDir, 'codex', 'kimi')

    for (const call of mockFetch.mock.calls) {
      const url = String(call[0])
      expect(url).not.toMatch(/moonshot/i)
    }
  })
})
