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
import { execSync } from 'child_process'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LiveRateLimitData {
  /** 0.0–1.0 */
  utilization5h?: number
  /** 0.0–1.0 */
  utilization7d?: number
  /** Unix seconds */
  reset5hAt?: number
  /** Unix seconds */
  reset7dAt?: number
  /** "allowed" | "allowed_warning" | "rejected" */
  status?: string
  /** "five_hour" | "seven_day" etc */
  representativeClaim?: string
  /** When this snapshot was captured (ms) */
  capturedAt: number
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

function readOAuthToken(configDir: string): OAuthEntry | null {
  if (process.platform !== 'darwin') return null
  const service = keychainServiceName(configDir)
  try {
    const username = process.env.USER || os.userInfo().username
    const raw = execSync(
      `security find-generic-password -a "${username}" -s "${service}" -w 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as { claudeAiOauth?: OAuthEntry }
    const token = parsed.claudeAiOauth
    if (!token?.accessToken) return null
    if (token.expiresAt && token.expiresAt < Date.now() + 60_000) return null  // expires in < 1m
    return token
  } catch {
    return null
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

    return {
      utilization5h: num('anthropic-ratelimit-unified-5h-utilization'),
      utilization7d: num('anthropic-ratelimit-unified-7d-utilization'),
      reset5hAt: num('anthropic-ratelimit-unified-5h-reset'),
      reset7dAt: num('anthropic-ratelimit-unified-7d-reset'),
      status: get('anthropic-ratelimit-unified-status') ?? undefined,
      representativeClaim: get('anthropic-ratelimit-unified-representative-claim') ?? undefined,
      capturedAt: Date.now(),
    }
  } catch {
    return null
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get live rate limit data for a profile. Returns cached data if fresh,
 * otherwise fetches from the API (requires Keychain access on macOS).
 *
 * Returns null if no valid token is available or on any error.
 */
export async function getLiveUsage(configDir: string): Promise<LiveRateLimitData | null> {
  const cached = getCached(configDir)
  if (cached) return cached

  const token = readOAuthToken(configDir)
  if (!token) return null

  const data = await fetchRateLimitHeaders(token.accessToken)
  if (!data) return null

  setCached(configDir, data)
  return data
}

/**
 * Force-refresh live rate limit data, bypassing the cache.
 */
export async function refreshLiveUsage(configDir: string): Promise<LiveRateLimitData | null> {
  const token = readOAuthToken(configDir)
  if (!token) return null

  const data = await fetchRateLimitHeaders(token.accessToken)
  if (!data) return null

  setCached(configDir, data)
  return data
}
