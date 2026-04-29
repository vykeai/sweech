// Claude Code usage stats — ported from sweech liveUsage.ts + subscriptions.ts.
// Data sources:
//   ~/.claude[- suffix]/history.jsonl  — per-message timestamps for 5h/7d windows
//   ~/.claude[- suffix]/.claude.json   — account metadata, subscriptionCreatedAt
//   macOS Keychain (live)              — OAuth token -> API call -> rate-limit headers
// Cache: ~/.omnai/rate-limit-cache.json, 5-minute TTL.

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'

// ── Types ──────────────────────────────────────────────────────────────────────

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

export interface ClaudeAccountInfo {
  /** e.g. "claude", "claude-pole" */
  commandName: string
  /** Absolute path to config dir */
  configDir: string

  displayName?: string
  emailAddress?: string
  billingType?: string
  subscriptionCreatedAt?: string

  /** Messages sent in last 5 hours (from history.jsonl) */
  messages5h: number
  /** Messages sent in last 7 days (from history.jsonl) */
  messages7d: number
  /** All-time messages in history.jsonl */
  totalMessages: number

  /** Timestamp of oldest message in current 5h window */
  oldest5hMessageAt?: string
  /** Last message timestamp */
  lastActive?: string

  /** Next weekly reset ISO timestamp */
  weeklyResetAt?: string
  /** Hours until next weekly reset */
  hoursUntilWeeklyReset?: number
  /** Minutes until oldest 5h message exits the window */
  minutesUntilFirstCapacity?: number

  /** Live data from Anthropic API (macOS only, requires Keychain token) */
  live?: LiveRateLimitData
}

// ── Cache ──────────────────────────────────────────────────────────────────────

const HOME = os.homedir()
const CACHE_FILE = path.join(HOME, '.omnai', 'rate-limit-cache.json')

function validateConfigDir(configDir: string): string {
  const resolved = fs.realpathSync(path.resolve(configDir))
  if (!resolved.startsWith(HOME)) throw new Error(`configDir escapes home: ${configDir}`)
  return resolved
}
const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheStore {
  [configDir: string]: LiveRateLimitData
}

function cacheScope(configDir: string, service: string, username: string): string {
  return `${username}::${service}::${configDir}`
}

function getUser(): string {
  return process.env.USER || os.userInfo().username
}

function readCache(): CacheStore {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as CacheStore
  } catch {
    return {}
  }
}

function writeCache(store: CacheStore): void {
  fs.mkdirSync(path.join(os.homedir(), '.omnai'), { recursive: true })
  fs.writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2))
}

function getCached(configDir: string): LiveRateLimitData | null {
  const service = keychainServiceName(configDir)
  const user = getUser()
  const store = readCache()
  const scopedKey = cacheScope(configDir, service, user)
  const entry = store[scopedKey] ?? store[configDir]
  if (!entry) return null
  if (Date.now() - entry.capturedAt > CACHE_TTL_MS) {
    if (store[scopedKey]) delete store[scopedKey]
    if (store[configDir]) delete store[configDir]
    writeCache(store)
    return null
  }
  return entry
}

function setCached(configDir: string, data: LiveRateLimitData): void {
  const service = keychainServiceName(configDir)
  const user = getUser()
  const scopedKey = cacheScope(configDir, service, user)

  const store = readCache()
  if (store[configDir]) {
    delete store[configDir]
  }
  store[scopedKey] = data
  writeCache(store)
}

// ── Keychain ───────────────────────────────────────────────────────────────────

function keychainServiceName(configDir: string): string {
  const defaultDir = path.join(os.homedir(), '.claude')
  if (configDir === defaultDir) return 'Claude Code-credentials'
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
    const username = getUser()
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-a', username, '-s', service, '-w'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as { claudeAiOauth?: OAuthEntry }
    const token = parsed.claudeAiOauth
    if (!token?.accessToken) return null
    if (token.expiresAt && token.expiresAt < Date.now() + 60_000) return null
    return token
  } catch {
    return null
  }
}

// ── API call ───────────────────────────────────────────────────────────────────

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

// ── history.jsonl ──────────────────────────────────────────────────────────────

interface HistoryEntry {
  timestamp?: number
}

function readHistory(configDir: string): HistoryEntry[] {
  const file = path.join(configDir, 'history.jsonl')
  if (!fs.existsSync(file)) return []
  const entries: HistoryEntry[] = []
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line) as HistoryEntry) } catch { /* skip */ }
  }
  return entries
}

function computeWindows(entries: HistoryEntry[]) {
  const now = Date.now()
  const cutoff5h = now - 5 * 60 * 60 * 1000
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000

  let messages5h = 0, messages7d = 0
  let lastTs: number | null = null
  let oldest5hTs: number | null = null

  for (const e of entries) {
    if (!e.timestamp) continue
    if (e.timestamp > (lastTs ?? 0)) lastTs = e.timestamp
    if (e.timestamp >= cutoff7d) messages7d++
    if (e.timestamp >= cutoff5h) {
      messages5h++
      if (!oldest5hTs || e.timestamp < oldest5hTs) oldest5hTs = e.timestamp
    }
  }

  const minutesUntilFirstCapacity = oldest5hTs
    ? Math.max(0, Math.round(((oldest5hTs + 5 * 60 * 60 * 1000) - now) / 60000))
    : undefined

  return {
    messages5h,
    messages7d,
    totalMessages: entries.length,
    oldest5hMessageAt: oldest5hTs ? new Date(oldest5hTs).toISOString() : undefined,
    lastActive: lastTs ? new Date(lastTs).toISOString() : undefined,
    minutesUntilFirstCapacity,
  }
}

function computeWeeklyReset(subscriptionCreatedAt: string) {
  const created = new Date(subscriptionCreatedAt)
  const now = new Date()

  const anchorDow = created.getUTCDay()
  const anchorMs = (created.getUTCHours() * 3600 + created.getUTCMinutes() * 60 + created.getUTCSeconds()) * 1000

  const nowMs = now.getTime()
  const nowDow = now.getUTCDay()
  const nowDayMs = (now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds()) * 1000

  let daysAhead = (anchorDow - nowDow + 7) % 7
  if (daysAhead === 0 && nowDayMs >= anchorMs) daysAhead = 7

  const resetMs = nowMs + daysAhead * 86_400_000 + (anchorMs - nowDayMs)

  return {
    weeklyResetAt: new Date(resetMs).toISOString(),
    hoursUntilWeeklyReset: Math.round((resetMs - nowMs) / 3_600_000),
  }
}

// ── Config dir discovery ───────────────────────────────────────────────────────

/** Find all ~/.claude* directories that look like Claude Code profiles */
function findClaudeConfigDirs(): string[] {
  const home = os.homedir()
  const dirs: string[] = []
  try {
    for (const entry of fs.readdirSync(home)) {
      if (!entry.startsWith('.claude')) continue
      const full = path.join(home, entry)
      if (!fs.statSync(full).isDirectory()) continue
      // Must have .claude.json or history.jsonl to count
      if (
        fs.existsSync(path.join(full, '.claude.json')) ||
        fs.existsSync(path.join(full, 'history.jsonl'))
      ) {
        dirs.push(full)
      }
    }
  } catch { /* ignore */ }
  return dirs.sort()
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get live usage data for a single Claude config dir.
 * Returns cached data if fresh (5-min TTL), else fetches from API.
 */
export async function getLiveUsage(configDir: string): Promise<LiveRateLimitData | null> {
  configDir = validateConfigDir(configDir)
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
 * Force-refresh live usage, bypassing the cache.
 */
export async function refreshLiveUsage(configDir: string): Promise<LiveRateLimitData | null> {
  configDir = validateConfigDir(configDir)
  const token = readOAuthToken(configDir)
  if (!token) return null

  const data = await fetchRateLimitHeaders(token.accessToken)
  if (!data) return null

  setCached(configDir, data)
  return data
}

/**
 * Get full account info for a specific config dir.
 */
export async function getAccountInfo(configDir: string): Promise<ClaudeAccountInfo> {
  configDir = validateConfigDir(configDir)
  const commandName = path.basename(configDir).replace(/^\./, '') // .claude-pole → claude-pole

  interface ClaudeJson {
    oauthAccount?: {
      displayName?: string
      emailAddress?: string
      billingType?: string
      subscriptionCreatedAt?: string
    }
  }

  let clauJson: ClaudeJson = {}
  try {
    clauJson = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf-8')) as ClaudeJson
  } catch { /* ignore */ }

  const sub = clauJson.oauthAccount
  const history = readHistory(configDir)
  const windows = computeWindows(history)
  const weeklyReset = sub?.subscriptionCreatedAt
    ? computeWeeklyReset(sub.subscriptionCreatedAt)
    : undefined
  const live = await getLiveUsage(configDir).catch(() => null) ?? undefined

  return {
    commandName,
    configDir,
    displayName: sub?.displayName,
    emailAddress: sub?.emailAddress,
    billingType: sub?.billingType,
    subscriptionCreatedAt: sub?.subscriptionCreatedAt,
    ...windows,
    ...(weeklyReset ?? {}),
    live,
  }
}

/**
 * Get account info for all detected Claude profiles on this machine.
 */
export async function getAllAccountInfo(): Promise<ClaudeAccountInfo[]> {
  const dirs = findClaudeConfigDirs()
  return Promise.all(dirs.map(getAccountInfo))
}
