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
  /** "allowed" | "allowed_warning" | "rejected" | "limit_reached" */
  status?: string
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

  // Legacy fields for backward compat with existing code
  /** @deprecated use buckets[0].session.utilization */
  utilization5h?: number
  /** @deprecated use buckets[0].weekly.utilization */
  utilization7d?: number
  /** @deprecated */
  utilizationSonnet7d?: number
  /** @deprecated */
  reset5hAt?: number
  /** @deprecated */
  reset7dAt?: number
  representativeClaim?: string
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_FILE = path.join(os.homedir(), '.sweech', 'rate-limit-cache.json')
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
  fs.mkdirSync(path.join(os.homedir(), '.sweech'), { recursive: true })
  fs.writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2))
}

function getCached(configDir: string): LiveRateLimitData | null {
  const store = readCache()
  const entry = store[configDir]
  if (!entry) return null
  if (Date.now() - entry.capturedAt > CACHE_TTL_MS) return null
  return entry
}

function getStaleCache(configDir: string): LiveRateLimitData | null {
  const store = readCache()
  const entry = store[configDir]
  if (!entry) return null
  return { ...entry, isStale: true }
}

function setCached(configDir: string, data: LiveRateLimitData): void {
  const store = readCache()
  store[configDir] = data
  writeCache(store)
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
        raw = execSync(
          `security find-generic-password -a "${username}" -s "${service}" -w 2>/dev/null`,
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim() || null
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
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
          refresh_token: token.refreshToken,
        })
        const res = await fetch('https://platform.claude.com/v1/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal: AbortSignal.timeout(8000),
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
      signal: AbortSignal.timeout(8000),
    })

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
      // Legacy
      utilization5h: u5h, utilization7d: u7d, utilizationSonnet7d: uSonnet7d,
      reset5hAt: r5h, reset7dAt: r7d,
      representativeClaim: get('anthropic-ratelimit-unified-representative-claim') ?? undefined,
    }
  } catch {
    return null
  }
}

// ── Codex app-server rate limits ──────────────────────────────────────────────

async function fetchCodexRateLimits(configDir: string): Promise<LiveRateLimitData | null> {
  const { spawn } = require('child_process')

  return new Promise<LiveRateLimitData | null>((resolve) => {
    const timeout = setTimeout(() => { proc.kill(); resolve(null) }, 10_000)

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
            // Legacy fields from the first (main) bucket
            let u5h: number | undefined, u7d: number | undefined, r5h: number | undefined, r7d: number | undefined

            for (const [id, limit] of Object.entries(byId) as [string, any][]) {
              const label = limit.limitName || 'All models'
              const bucket: RateLimitBucket = { label }
              if (limit.primary) {
                bucket.session = { utilization: limit.primary.usedPercent / 100, resetsAt: limit.primary.resetsAt }
              }
              if (limit.secondary) {
                bucket.weekly = { utilization: limit.secondary.usedPercent / 100, resetsAt: limit.secondary.resetsAt }
                if (limit.secondary.usedPercent >= 100) mainStatus = 'limit_reached'
              }
              if (limit.planType) mainPlanType = limit.planType
              buckets.push(bucket)

              // Legacy: use main (unnamed) limit for top-level fields
              if (!limit.limitName) {
                u5h = bucket.session?.utilization
                u7d = bucket.weekly?.utilization
                r5h = limit.primary?.resetsAt
                r7d = limit.secondary?.resetsAt
              }
            }

            resolve({
              buckets,
              status: mainStatus,
              planType: mainPlanType,
              capturedAt: Date.now(),
              utilization5h: u5h, utilization7d: u7d,
              reset5hAt: r5h, reset7dAt: r7d,
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
