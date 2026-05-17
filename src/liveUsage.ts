/**
 * Live rate limit data from the Claude API.
 *
 * Auth: reads OAuth tokens from macOS Keychain using the same service name
 * pattern as the Claude Code native binary, then calls /v1/messages with
 * anthropic-beta: oauth-2025-04-20 and reads response headers.
 *
 * Results are cached in ~/.sweech/rate-limit-cache.json with a 5-minute TTL
 * to avoid burning message quota on every poll.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync, execFileSync } from 'child_process'
import { isMacOS } from './platform'
import { readCredential, computeKeychainServiceName } from './credentialStore'
import { getAnthropicClientId } from './anthropicAuth'
import { atomicWriteFileSync } from './atomicWrite'
import {
  parseKimiRateLimitHeaders,
  parseQwenRateLimitHeaders,
  parseDeepSeekRateLimitHeaders,
  parseZaiRateLimitHeaders,
  PROVIDER_PROBE_URLS,
} from './providerRateLimitParsers'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RateLimitWindow {
  /** 0.0–1.0 */
  utilization: number
  /** Unix seconds */
  resetsAt?: number
}

export interface RateLimitBucket {
  /** Human-readable name, e.g. "All models", "Sonnet only", "GPT-5.3-Codex-Spark" */
  label: string
  session?: RateLimitWindow    // 5h rolling
  weekly?: RateLimitWindow     // 7d rolling
}

export interface LiveRateLimitData {
  buckets: RateLimitBucket[]
  /** "allowed" | "allowed_warning" | "rejected" | "limit_reached" | "org_disabled" | "forbidden" | "unauthorized" */
  status?: string
  /** Human-readable reason from the API when status is forbidden/org_disabled. */
  forbiddenReason?: string
  /** Plan type — "pro", "max", etc. */
  planType?: string
  /** When this snapshot was captured (ms) */
  capturedAt: number
  /** True when this is cached data returned because a fresh fetch failed */
  isStale?: boolean

  /** OAuth token status: "valid" | "refreshed" | "expired" | "no_token" */
  tokenStatus?: string
  /** When the token was last refreshed (ms epoch), if it was refreshed during this fetch */
  tokenRefreshedAt?: number
  /** Token expiry time (ms epoch), if known */
  tokenExpiresAt?: number

  /** Representative claim from anthropic-ratelimit-unified-representative-claim header. */
  representativeClaim?: string

  /**
   * Provider that produced this snapshot, when known. Optional for backwards
   * compatibility — cached entries written before this field existed simply
   * lack it. Values: 'anthropic' | 'kimi' | 'qwen' | 'deepseek' | 'zai' | 'codex'.
   */
  provider?: string
}

// ── Bucket accessors ──────────────────────────────────────────────────────────

/**
 * Read the session (5h) utilization (0.0–1.0) from the canonical first bucket.
 * Returns undefined when the bucket or window is absent.
 */
export function getSessionUtilization(live: LiveRateLimitData | null | undefined): number | undefined {
  return live?.buckets?.[0]?.session?.utilization
}

/**
 * Read the weekly (7d) utilization (0.0–1.0) from the canonical first bucket.
 * Returns undefined when the bucket or window is absent.
 */
export function getWeeklyUtilization(live: LiveRateLimitData | null | undefined): number | undefined {
  return live?.buckets?.[0]?.weekly?.utilization
}

/**
 * Read the session (5h) reset time (Unix seconds) from the canonical first bucket.
 * Returns undefined when the bucket or window is absent.
 */
export function getSessionResetsAt(live: LiveRateLimitData | null | undefined): number | undefined {
  return live?.buckets?.[0]?.session?.resetsAt
}

/**
 * Read the weekly (7d) reset time (Unix seconds) from the canonical first bucket.
 * Returns undefined when the bucket or window is absent.
 */
export function getWeeklyResetsAt(live: LiveRateLimitData | null | undefined): number | undefined {
  return live?.buckets?.[0]?.weekly?.resetsAt
}

// ── Shared scoring ───────────────────────────────────────────────────────────

/** Account-level data needed for scoring (works with any surface) */
interface ScorableAccount {
  needsReauth?: boolean
  live?: LiveRateLimitData | null
}

/**
 * Smart priority score: higher = use this account first.
 * Uses the "All models" bucket when available. Identical logic for CLI, launcher, and SweechBar.
 */
export function computeSmartScore(account: ScorableAccount): number {
  if (account.needsReauth) return -2
  if (account.live?.status === 'limit_reached') return -1
  if (!account.live) return 0

  // Prefer "All models" bucket, fall back to first bucket
  const allModels = account.live.buckets.find(b => b.label === 'All models')
  const bucket = allModels || account.live.buckets[0]

  // If there's no weekly data at all, fall back to session data
  const hasWeekly = bucket?.weekly?.utilization !== undefined
  if (!hasWeekly) {
    const session = bucket?.session
    if (session) return (1 - session.utilization)
    return 0
  }

  const remaining7d = 1 - (bucket?.weekly?.utilization ?? 0)
  const reset7dAt = bucket?.weekly?.resetsAt
  if (!reset7dAt) return remaining7d / 7

  const hoursLeft = Math.max(0.5, (reset7dAt - Date.now() / 1000) / 3600)
  const daysLeft = hoursLeft / 24
  const baseScore = remaining7d / daysLeft
  if (hoursLeft < 72 && remaining7d > 0) return 100 + baseScore
  return baseScore
}

/**
 * Compute tier label for an account: "use_first", "use_next", or "normal".
 * The "urgent" flag is set when expiring <72h with ≥5% remaining.
 */
export function computeTier(account: ScorableAccount, isTopInGroup: boolean): { tier: string; urgent: boolean } {
  if (!isTopInGroup) return { tier: 'normal', urgent: false }
  const score = computeSmartScore(account)
  if (score < 0) return { tier: 'normal', urgent: false }
  const allModels = account.live?.buckets.find(b => b.label === 'All models')
  const reset7dAt = allModels?.weekly?.resetsAt
  const remaining7d = 1 - (allModels?.weekly?.utilization ?? 0)
  const urgent = !!(reset7dAt && ((reset7dAt - Date.now() / 1000) / 3600) < 72 && remaining7d >= 0.05)
  return { tier: 'use_first', urgent }
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const SWEECH_DIR = path.join(os.homedir(), '.sweech')
const CACHE_FILE = path.join(SWEECH_DIR, 'rate-limit-cache.json')
const CACHE_LOCK = path.join(SWEECH_DIR, 'rate-limit-cache.lock')
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes

interface CacheStore {
  [configDir: string]: LiveRateLimitData
}

function readCache(): CacheStore {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as CacheStore
  } catch {
    return {}
  }
}

function writeCache(store: CacheStore): void {
  fs.mkdirSync(SWEECH_DIR, { recursive: true, mode: 0o700 })
  // atomicWriteFileSync uses a temp file + rename, so readers always see a
  // complete file (either pre- or post-write), never a partial JSON. Closes
  // the codex MEDIUM where a kill mid-fs.writeFileSync produced empty cache.
  atomicWriteFileSync(CACHE_FILE, JSON.stringify(store, null, 2))
}

/**
 * O_EXCL flag-file lock for the cache's read-modify-write window. Unlike
 * the vault lock (which throws on timeout because data loss is unacceptable),
 * the cache lock degrades gracefully — if we can't get the lock in 2s we
 * fall through with a stderr warning rather than block. The cache has a
 * 5-min TTL and regenerates on miss, so worst case the next `usage --refresh`
 * does the work again. Hangs in the menu bar would be much worse.
 *
 * Codex (MEDIUM): without this, two concurrent `usage --refresh` invocations
 * (e.g. the menu bar's `forceRefresh()` racing with `sweech usage` from a
 * shell) interleave read→modify→write and the slower writer silently
 * overwrites the faster one's entry.
 */
let __cacheLockDepth = 0
function withCacheLock<T>(fn: () => T): T {
  if (__cacheLockDepth > 0) {
    __cacheLockDepth++
    try { return fn() } finally { __cacheLockDepth-- }
  }
  fs.mkdirSync(SWEECH_DIR, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 2000
  let fd: number | null = null
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(CACHE_LOCK, 'wx', 0o600)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          const st = fs.statSync(CACHE_LOCK)
          if (Date.now() - st.mtimeMs > 10_000) {
            // Stale lock from a crashed process — reclaim.
            fs.unlinkSync(CACHE_LOCK)
            continue
          }
        } catch { /* lock disappeared mid-stat, retry */ }
        const until = Date.now() + 25
        while (Date.now() < until) { /* short spin */ }
        continue
      }
      throw err
    }
  }
  if (fd === null) {
    // Cache is non-critical — degrade gracefully rather than hang the bar.
    process.stderr.write('[sweech] WARN: rate-limit-cache lock timeout after 2s — proceeding unlocked\n')
    return fn()
  }
  __cacheLockDepth = 1
  try {
    return fn()
  } finally {
    __cacheLockDepth = 0
    try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(CACHE_LOCK) } catch {}
  }
}

export function getCached(configDir: string): LiveRateLimitData | null {
  // Readers don't need the lock: atomicWriteFileSync guarantees the file
  // is either pre- or post-write, never partial — so JSON.parse can't
  // observe a half-written state. The 5-min TTL bounds staleness.
  const store = readCache()
  const entry = store[configDir]
  if (!entry) return null
  if (Date.now() - entry.capturedAt > CACHE_TTL_MS) return null
  return entry
}

export function getStaleCache(configDir: string): LiveRateLimitData | null {
  const store = readCache()
  const entry = store[configDir]
  if (!entry) return null
  return { ...entry, isStale: true }
}

function setCached(configDir: string, data: LiveRateLimitData): void {
  withCacheLock(() => {
    const store = readCache()
    store[configDir] = data
    writeCache(store)
  })
}

// ── Keychain ──────────────────────────────────────────────────────────────────

/**
 * Compute the Keychain service name for a given config dir.
 *
 * Matches the native binary's ZF() function:
 *   - Default profile (no CLAUDE_CONFIG_DIR): "Claude Code-credentials"
 *   - Custom profile: "Claude Code-credentials-{sha256(configDir).slice(0,8)}"
 *
 * The default config dir is ~/.claude; for it the binary doesn't set
 * CLAUDE_CONFIG_DIR, so there's no hash suffix.
 */
function keychainServiceName(configDir: string): string {
  const defaultDir = path.join(os.homedir(), '.claude')
  if (configDir === defaultDir) {
    return 'Claude Code-credentials'
  }
  const hash = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${hash}`
}

interface OAuthEntry {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

interface OAuthReadResult {
  token: OAuthEntry | null
  /** "valid" | "refreshed" | "expired" | "no_token" */
  tokenStatus: string
  /** Set when status is "refreshed" — the moment the refresh completed */
  tokenRefreshedAt?: number
  /** Token expiry timestamp (ms), if known */
  tokenExpiresAt?: number
}

async function readOAuthToken(configDir: string): Promise<OAuthReadResult> {
  const service = keychainServiceName(configDir)
  const profileName = path.basename(configDir)

  try {
    // Use cross-platform credential store for reading
    const username = process.env.USER || os.userInfo().username
    let raw: string | null = null

    if (isMacOS()) {
      // macOS: use Keychain directly (existing path — preserves refresh flow)
      try {
        raw = execFileSync('security', [
          'find-generic-password', '-a', username, '-s', service, '-w',
        ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
          .trim() || null
      } catch {
        raw = null
      }
    } else {
      // Linux/Windows: use cross-platform credential store
      raw = await readCredential(service, username)
    }

    if (!raw) return { token: null, tokenStatus: 'no_token' }

    const payload = JSON.parse(raw) as Record<string, unknown>
    const token = payload.claudeAiOauth as OAuthEntry | undefined
    if (!token?.accessToken) return { token: null, tokenStatus: 'no_token' }

    // Token still valid
    if (!token.expiresAt || token.expiresAt >= Date.now() + 60_000) {
      return { token, tokenStatus: 'valid', tokenExpiresAt: token.expiresAt }
    }

    // Token expired — try to refresh silently using the stored refresh token
    if (token.refreshToken) {
      try {
        const params = new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: getAnthropicClientId(),
          refresh_token: token.refreshToken,
        })
        const res = await fetch('https://platform.claude.com/v1/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) throw new Error('refresh failed')
        const data = await res.json() as any
        const updatedPayload = {
          ...payload,
          claudeAiOauth: {
            ...(payload.claudeAiOauth as object),
            accessToken: data.access_token,
            refreshToken: data.refresh_token ?? token.refreshToken,
            expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
          },
        }

        // Write updated token back using platform-appropriate method
        if (isMacOS()) {
          execFileSync('security', [
            'add-generic-password', '-U',
            '-a', username,
            '-s', service,
            '-w', JSON.stringify(updatedPayload),
          ], { stdio: 'ignore' })
        } else {
          const { getCredentialStore } = require('./credentialStore')
          const store = getCredentialStore()
          await store.set(service, username, JSON.stringify(updatedPayload))
        }

        const refreshed = updatedPayload.claudeAiOauth as OAuthEntry
        return {
          token: refreshed,
          tokenStatus: 'refreshed',
          tokenRefreshedAt: Date.now(),
          tokenExpiresAt: refreshed.expiresAt,
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sweech] token refresh failed for ${profileName}:`, msg)
        return { token: null, tokenStatus: 'expired' }
      }
    }

    return { token: null, tokenStatus: 'expired' } // expired with no refresh token
  } catch {
    return { token: null, tokenStatus: 'no_token' }
  }
}

// ── API call ──────────────────────────────────────────────────────────────────

async function fetchRateLimitHeaders(accessToken: string): Promise<LiveRateLimitData | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'quota' }],
      }),
      signal: AbortSignal.timeout(5000),
    })

    // Permission/org-level errors return a stable error body and no rate-limit
    // headers. Surface them as authoritative status so display code can stop
    // trusting the stale keychain `rateLimitTier` for these accounts.
    if (res.status === 401 || res.status === 403) {
      let errMsg = ''
      try { const body = await res.json() as any; errMsg = body?.error?.message ?? '' } catch {}
      const isOrgDisabled = /oauth.*not allowed for this organization/i.test(errMsg)
      return {
        buckets: [],
        capturedAt: Date.now(),
        status: isOrgDisabled ? 'org_disabled' : (res.status === 401 ? 'unauthorized' : 'forbidden'),
        tokenStatus: res.status === 401 ? 'expired' : 'valid',
        forbiddenReason: errMsg || undefined,
        provider: 'anthropic',
      }
    }

    const get = (k: string) => res.headers.get(k)
    const num = (k: string) => { const v = get(k); return v !== null ? Number(v) : undefined }

    const u5h = num('anthropic-ratelimit-unified-5h-utilization')
    const u7d = num('anthropic-ratelimit-unified-7d-utilization')
    const uSonnet7d = num('anthropic-ratelimit-sonnet-7d-utilization')
    const r5h = num('anthropic-ratelimit-unified-5h-reset')
    const r7d = num('anthropic-ratelimit-unified-7d-reset')

    const buckets: RateLimitBucket[] = [
      {
        label: 'All models',
        session: u5h !== undefined ? { utilization: u5h, resetsAt: r5h } : undefined,
        weekly: u7d !== undefined ? { utilization: u7d, resetsAt: r7d } : undefined,
      },
    ]
    if (uSonnet7d !== undefined) {
      buckets.push({
        label: 'Sonnet only',
        weekly: { utilization: uSonnet7d, resetsAt: r7d },
      })
    }

    return {
      buckets,
      status: get('anthropic-ratelimit-unified-status') ?? undefined,
      capturedAt: Date.now(),
      representativeClaim: get('anthropic-ratelimit-unified-representative-claim') ?? undefined,
      provider: 'anthropic',
    }
  } catch {
    return null
  }
}

// ── OpenAI-compat provider fetchers ──────────────────────────────────────────

/**
 * Generic OpenAI-compat fetcher. Issues a GET against the provider's cheapest
 * probe endpoint (`/v1/models` or equivalent) using the supplied API key,
 * then hands the response to the supplied parser.
 *
 * Returns `null` on transport failure (DNS, timeout, etc.) so callers can
 * fall through to the stale cache, mirroring `fetchRateLimitHeaders`.
 */
async function fetchOpenAICompatProbe(
  url: string,
  apiKey: string,
  parser: (h: Headers, status: number, errMsg?: string) => LiveRateLimitData,
): Promise<LiveRateLimitData | null> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    })

    let errMsg: string | undefined
    if (!res.ok && (res.status === 401 || res.status === 403)) {
      try {
        const body = await res.json() as any
        errMsg = body?.error?.message ?? body?.message ?? undefined
      } catch { /* body parse failure is fine */ }
    }

    return parser(res.headers, res.status, errMsg)
  } catch {
    return null
  }
}

/** Probe Moonshot Kimi for rate-limit headers. */
export async function fetchKimiRateLimit(apiKey: string): Promise<LiveRateLimitData | null> {
  return fetchOpenAICompatProbe(PROVIDER_PROBE_URLS.kimi, apiKey, parseKimiRateLimitHeaders)
}

/** Probe Alibaba DashScope (Qwen) for rate-limit headers. */
export async function fetchQwenRateLimit(apiKey: string): Promise<LiveRateLimitData | null> {
  return fetchOpenAICompatProbe(PROVIDER_PROBE_URLS.qwen, apiKey, parseQwenRateLimitHeaders)
}

/** Probe DeepSeek for rate-limit headers. */
export async function fetchDeepSeekRateLimit(apiKey: string): Promise<LiveRateLimitData | null> {
  return fetchOpenAICompatProbe(PROVIDER_PROBE_URLS.deepseek, apiKey, parseDeepSeekRateLimitHeaders)
}

/** Probe Z.ai (Zhipu GLM) for rate-limit headers. */
export async function fetchZaiRateLimit(apiKey: string): Promise<LiveRateLimitData | null> {
  return fetchOpenAICompatProbe(PROVIDER_PROBE_URLS.zai, apiKey, parseZaiRateLimitHeaders)
}

// Re-export parsers for callers that already have headers in hand.
export {
  parseKimiRateLimitHeaders,
  parseQwenRateLimitHeaders,
  parseDeepSeekRateLimitHeaders,
  parseZaiRateLimitHeaders,
  parseProviderRateLimitHeaders,
} from './providerRateLimitParsers'

// ── Codex app-server rate limits ──────────────────────────────────────────────

async function fetchCodexRateLimits(configDir: string): Promise<LiveRateLimitData | null> {
  // Only profiles with a real codex auth (under ~/.codex* dirs) have a
  // meaningful rateLimits endpoint. Claude-named profiles routed through
  // the codex CLI for third-party providers (groq, gemini, openrouter, etc.)
  // have no openai auth, so the app-server returns an empty byId after
  // ~5s — wasting a slot and contending with real codex profiles.
  const path = require('path')
  const dirName = path.basename(configDir)
  if (!/^\.codex(-.*)?$/.test(dirName)) return null

  const { spawn } = require('child_process')

  return new Promise<LiveRateLimitData | null>((resolve) => {
    const timeout = setTimeout(() => { proc.kill(); resolve(null) }, 5_000)

    const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, CODEX_HOME: configDir },
    })

    let buffer = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1) {
            // Init response — now request rate limits
            const req = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} })
            proc.stdin.write(req + '\n')
          } else if (msg.id === 2) {
            clearTimeout(timeout)
            proc.kill()

            const byId = msg.result?.rateLimitsByLimitId || {}
            if (!Object.keys(byId).length) { resolve(null); return }

            // Build one bucket per limit ID, each with 5h + 7d
            const buckets: RateLimitBucket[] = []
            let mainStatus = 'allowed'
            let mainPlanType: string | undefined

            // Assign primary/secondary to session (5h) vs weekly (7d) by
            // their windowDurationMins, NOT by position. The free plan only
            // returns a single weekly window in `primary` — assuming
            // primary=session previously surfaced a 100% 5h bar with a 6-day
            // reset, which is the weekly limit mislabeled.
            const isWeeklyWindow = (m: number | undefined) => m !== undefined && m >= 24 * 60; // >=1 day
            const assignWindow = (bucket: RateLimitBucket, win: any) => {
              if (!win) return false;
              const data = { utilization: win.usedPercent / 100, resetsAt: win.resetsAt };
              if (isWeeklyWindow(win.windowDurationMins)) bucket.weekly = data;
              else bucket.session = data;
              return win.usedPercent >= 100;
            };

            for (const [, limit] of Object.entries(byId) as [string, any][]) {
              const label = limit.limitName || 'All models'
              const bucket: RateLimitBucket = { label }
              const primaryHit = assignWindow(bucket, limit.primary);
              const secondaryHit = assignWindow(bucket, limit.secondary);
              if (primaryHit || secondaryHit) mainStatus = 'limit_reached'
              if (limit.planType) mainPlanType = limit.planType
              buckets.push(bucket)
            }

            resolve({
              buckets,
              status: mainStatus,
              planType: mainPlanType,
              capturedAt: Date.now(),
              provider: 'codex',
            })
          }
        } catch {}
      }
    })

    proc.on('error', () => { clearTimeout(timeout); resolve(null) })

    // Send initialize
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'sweech', version: '0.1' } } })
    proc.stdin.write(init + '\n')
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get live rate limit data for a profile. Returns cached data if fresh,
 * otherwise fetches from the API (requires Keychain access on macOS).
 *
 * Returns null if no valid token is available or on any error.
 */
export async function getLiveUsage(configDir: string, cliType?: string): Promise<LiveRateLimitData | null> {
  const cached = getCached(configDir)
  if (cached) return cached

  // Codex: use app-server JSON-RPC
  if (cliType === 'codex') {
    const data = await fetchCodexRateLimits(configDir)
    if (data) { setCached(configDir, data); return data }
    return getStaleCache(configDir)
  }

  // Claude: use OAuth token + Anthropic API headers
  const result = await readOAuthToken(configDir)
  if (!result.token) {
    const stale = getStaleCache(configDir)
    if (stale) { stale.tokenStatus = result.tokenStatus; return stale }
    return { buckets: [], capturedAt: Date.now(), tokenStatus: result.tokenStatus }
  }

  const data = await fetchRateLimitHeaders(result.token.accessToken)
  if (data) {
    data.tokenStatus = result.tokenStatus
    data.tokenRefreshedAt = result.tokenRefreshedAt
    data.tokenExpiresAt = result.tokenExpiresAt
    setCached(configDir, data)
    return data
  }

  return getStaleCache(configDir)
}

/**
 * Force-refresh live rate limit data, bypassing the cache.
 */
export async function refreshLiveUsage(configDir: string, cliType?: string): Promise<LiveRateLimitData | null> {
  if (cliType === 'codex') {
    const data = await fetchCodexRateLimits(configDir)
    if (data) { setCached(configDir, data); return data }
    return getStaleCache(configDir)
  }

  const result = await readOAuthToken(configDir)
  if (!result.token) {
    const stale = getStaleCache(configDir)
    if (stale) { stale.tokenStatus = result.tokenStatus; return stale }
    return { buckets: [], capturedAt: Date.now(), tokenStatus: result.tokenStatus }
  }

  const data = await fetchRateLimitHeaders(result.token.accessToken)
  if (data) {
    data.tokenStatus = result.tokenStatus
    data.tokenRefreshedAt = result.tokenRefreshedAt
    data.tokenExpiresAt = result.tokenExpiresAt
    setCached(configDir, data)
    return data
  }

  return getStaleCache(configDir)
}
