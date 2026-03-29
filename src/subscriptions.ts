/**
 * Claude Code subscription tracker.
 *
 * Data sources:
 *   ~/.claude-{name}/history.jsonl   — per-message timestamps for 5h/7d windows
 *   ~/.claude-{name}/.claude.json    — account metadata, subscriptionCreatedAt
 *   ~/.sweech/subscriptions.json     — user-configured plan labels
 *   macOS Keychain (live)            — OAuth token → API call → rate-limit headers
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getLiveUsage, refreshLiveUsage, type LiveRateLimitData } from './liveUsage'
import { SUPPORTED_CLIS } from './clis'
import { checkUsageThresholds } from './usageMonitor'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubscriptionMeta {
  /** User-set plan label, e.g. "Max 5x", "Max 20x", "Pro" */
  plan?: string
  /** Known message limits for reference (user-configured). e.g. { window5h: 225, window7d: 2000 } */
  limits?: { window5h?: number; window7d?: number }
}

export interface AccountInfo {
  name: string
  commandName: string
  cliType: string
  configDir: string

  /** Provider key from sweech config (e.g. 'anthropic', 'dashscope', 'minimax') */
  provider?: string

  // From .claude.json or .credentials.json
  displayName?: string
  emailAddress?: string
  billingType?: string
  rateLimitTier?: string
  subscriptionCreatedAt?: string
  /** True if OAuth token is expired and needs re-auth */
  needsReauth?: boolean

  // From ~/.sweech/subscriptions.json
  meta: SubscriptionMeta

  // Computed from history.jsonl
  messages5h: number          // messages sent in last 5 hours
  messages7d: number          // messages sent in last 7 days
  totalMessages: number       // all-time messages in history.jsonl

  /** Timestamp of oldest message in the current 5h window (when first capacity opens) */
  oldest5hMessageAt?: string
  /** Last message timestamp */
  lastActive?: string

  // Computed reset times
  /** Next weekly reset ISO timestamp (based on subscriptionCreatedAt weekday) */
  weeklyResetAt?: string
  /** Hours until next weekly reset */
  hoursUntilWeeklyReset?: number
  /** Minutes until the oldest message in 5h window exits (i.e. window expands) */
  minutesUntilFirstCapacity?: number

  // Live data from API (requires Keychain token)
  live?: LiveRateLimitData

  /** OAuth token status: "valid" | "refreshed" | "expired" | "no_token" */
  tokenStatus?: string
  /** When the token was last refreshed (ms epoch), if refreshed during this fetch */
  tokenRefreshedAt?: number
  /** Token expiry time (ms epoch), if known */
  tokenExpiresAt?: number
}

export interface AccountRef {
  name: string
  commandName: string
  cliType?: string
  provider?: string
  isDefault?: boolean
}

// ── Storage ───────────────────────────────────────────────────────────────────

const SUBSCRIPTIONS_FILE = path.join(os.homedir(), '.sweech', 'subscriptions.json')

function readMeta(): Record<string, SubscriptionMeta> {
  try {
    return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function writeMeta(data: Record<string, SubscriptionMeta>): void {
  fs.mkdirSync(path.join(os.homedir(), '.sweech'), { recursive: true })
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(data, null, 2))
}

export function setMeta(commandName: string, config: Partial<SubscriptionMeta>): void {
  const meta = readMeta()
  meta[commandName] = { ...(meta[commandName] ?? {}), ...config }
  writeMeta(meta)
}

// ── Config dir resolution ─────────────────────────────────────────────────────

export function getConfigDir(commandName: string): string {
  // commandName is the full dir suffix: 'claude' → ~/.claude, 'claude-pole' → ~/.claude-pole
  return path.join(os.homedir(), `.${commandName}`)
}

// ── .claude.json reader ───────────────────────────────────────────────────────

interface ClaudeJson {
  oauthAccount?: {
    accountUuid?: string
    emailAddress?: string
    displayName?: string
    billingType?: string
    subscriptionCreatedAt?: string
    organizationName?: string
    rateLimitTier?: string
  }
}

function readClaudeJson(configDir: string): ClaudeJson {
  let result: ClaudeJson = {}

  // Try .claude.json first (sweech-managed profiles)
  const file = path.join(configDir, '.claude.json')
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as ClaudeJson
    if (data.oauthAccount) result = data
  } catch {}

  // Fallback: .credentials.json (default claude account stores auth here)
  if (!result.oauthAccount) {
    const credFile = path.join(configDir, '.credentials.json')
    try {
      const cred = JSON.parse(fs.readFileSync(credFile, 'utf-8')) as any
      const oauth = cred.claudeAiOauth
      if (oauth) {
        result = {
          oauthAccount: {
            subscriptionCreatedAt: undefined,
            billingType: oauth.subscriptionType || undefined,
            rateLimitTier: oauth.rateLimitTier,
          }
        }
      }
    } catch {}
  }

  // Enrich with Keychain data (has rateLimitTier even when files don't)
  if (process.platform === 'darwin' && result.oauthAccount && !result.oauthAccount.rateLimitTier) {
    try {
      const crypto = require('crypto')
      const defaultDir = path.join(os.homedir(), '.claude')
      const service = configDir === defaultDir
        ? 'Claude Code-credentials'
        : `Claude Code-credentials-${crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
      const { execSync } = require('child_process')
      const username = process.env.USER || os.userInfo().username
      const raw = execSync(
        `security find-generic-password -a "${username}" -s "${service}" -w 2>/dev/null`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      if (raw) {
        const parsed = JSON.parse(raw)
        const token = parsed.claudeAiOauth
        if (token?.rateLimitTier) {
          result.oauthAccount.rateLimitTier = token.rateLimitTier
        }
        if (token?.subscriptionType && !result.oauthAccount.billingType) {
          result.oauthAccount.billingType = token.subscriptionType
        }
      }
    } catch {}
  }

  return result
}

// ── history.jsonl reader ──────────────────────────────────────────────────────

interface HistoryEntry {
  timestamp?: number
  ts?: number        // codex uses `ts` instead of `timestamp`
  sessionId?: string
  session_id?: string // codex uses snake_case
  display?: string
}

function readHistory(configDir: string): HistoryEntry[] {
  const file = path.join(configDir, 'history.jsonl')
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf-8')
  const entries: HistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as HistoryEntry
      // Normalise codex `ts` (epoch seconds) to `timestamp` (epoch millis)
      if (!parsed.timestamp && parsed.ts) {
        parsed.timestamp = parsed.ts * 1000
      }
      entries.push(parsed)
    } catch { /* skip */ }
  }
  return entries
}

// ── Window calculations ───────────────────────────────────────────────────────

function computeWindows(entries: HistoryEntry[]): {
  messages5h: number
  messages7d: number
  totalMessages: number
  oldest5hMessageAt?: string
  lastActive?: string
  minutesUntilFirstCapacity?: number
} {
  const now = Date.now()
  const cutoff5h = now - 5 * 60 * 60 * 1000
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000

  let messages5h = 0
  let messages7d = 0
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

/**
 * Compute the next weekly reset based on the subscription's creation weekday + time-of-day.
 * e.g. if sub was created on a Tuesday at 17:42 UTC, it resets every Tuesday at 17:42.
 */
function computeWeeklyReset(subscriptionCreatedAt: string): { weeklyResetAt: string; hoursUntilWeeklyReset: number } {
  const created = new Date(subscriptionCreatedAt)
  const now = new Date()

  // Anchor: day-of-week + time-of-day from creation
  const anchorDow = created.getUTCDay()        // 0=Sun..6=Sat
  const anchorMs = (
    created.getUTCHours() * 3600 +
    created.getUTCMinutes() * 60 +
    created.getUTCSeconds()
  ) * 1000

  // Find next occurrence of that weekday+time after now
  const nowMs = now.getTime()
  const nowDow = now.getUTCDay()
  const nowDayMs = (
    now.getUTCHours() * 3600 +
    now.getUTCMinutes() * 60 +
    now.getUTCSeconds()
  ) * 1000

  let daysAhead = (anchorDow - nowDow + 7) % 7
  if (daysAhead === 0 && nowDayMs >= anchorMs) daysAhead = 7  // same weekday but already past time

  const resetMs = nowMs + daysAhead * 86_400_000 + (anchorMs - nowDayMs)
  const reset = new Date(resetMs)

  const hoursUntilWeeklyReset = Math.round((resetMs - nowMs) / 3_600_000)

  return {
    weeklyResetAt: reset.toISOString(),
    hoursUntilWeeklyReset,
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export function getKnownAccounts(
  profiles: Array<{ name: string; commandName: string; cliType?: string; provider?: string }>,
): AccountRef[] {
  const seen = new Set<string>()
  const accounts: AccountRef[] = []

  for (const cli of Object.values(SUPPORTED_CLIS)) {
    if (seen.has(cli.name)) continue
    seen.add(cli.name)
    accounts.push({
      name: cli.command,
      commandName: cli.name,
      cliType: cli.name,
      provider: cli.name === 'claude' ? 'anthropic' : 'openai',
      isDefault: true,
    })
  }

  for (const profile of profiles) {
    if (seen.has(profile.commandName)) continue
    seen.add(profile.commandName)
    accounts.push({
      name: profile.name,
      commandName: profile.commandName,
      cliType: profile.cliType,
      provider: profile.provider,
      isDefault: false,
    })
  }

  return accounts
}

export async function getAccountInfo(
  profiles: Array<{ name: string; commandName: string; cliType?: string; provider?: string }>,
  options: { refresh?: boolean } = {},
): Promise<AccountInfo[]> {
  const allMeta = readMeta()

  return Promise.all(profiles.map(async p => {
    const configDir = getConfigDir(p.commandName)
    const cliType = p.cliType || (p.commandName.startsWith('codex') ? 'codex' : 'claude')
    const meta = allMeta[p.commandName] ?? {}
    const claude = readClaudeJson(configDir)
    const history = readHistory(configDir)
    const windows = computeWindows(history)

    const sub = claude.oauthAccount
    const weeklyReset = sub?.subscriptionCreatedAt
      ? computeWeeklyReset(sub.subscriptionCreatedAt)
      : undefined

    const usageFn = options.refresh ? refreshLiveUsage : getLiveUsage
    const live = await usageFn(configDir, cliType).catch(() => undefined) ?? undefined

    // Check for usage threshold crossings and emit events
    if (live) {
      checkUsageThresholds(p.name, live)
    }

    // Only flag reauth if the Keychain token is actually expired (not just a transient fetch failure)
    let needsReauth = false
    if (process.platform === 'darwin' && cliType === 'claude' && !live) {
      try {
        const crypto = require('crypto')
        const defaultDir = path.join(os.homedir(), '.claude')
        const service = configDir === defaultDir
          ? 'Claude Code-credentials'
          : `Claude Code-credentials-${crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
        const { execSync } = require('child_process')
        const username = process.env.USER || os.userInfo().username
        const raw = execSync(
          `security find-generic-password -a "${username}" -s "${service}" -w 2>/dev/null`,
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim()
        if (raw) {
          const token = JSON.parse(raw).claudeAiOauth
          // Expired access token is fine when a refresh token exists — Claude Code renews it automatically.
          // Only flag reauth when there's truly no valid credential (no access token, or expired with no refresh path).
          if (!token?.accessToken || (token.expiresAt && token.expiresAt < Date.now() && !token.refreshToken)) {
            needsReauth = true
          }
        } else {
          needsReauth = true // no token at all
        }
      } catch {
        needsReauth = true
      }
    }

    // Derive tokenStatus from live data or from needsReauth
    let tokenStatus: string | undefined = live?.tokenStatus
    if (!tokenStatus) {
      if (cliType === 'codex') tokenStatus = undefined  // codex doesn't use OAuth tokens this way
      else if (needsReauth) tokenStatus = 'expired'
      else if (live) tokenStatus = 'valid'
      else tokenStatus = 'no_token'
    }

    return {
      name: p.name,
      commandName: p.commandName,
      cliType,
      configDir,
      provider: p.provider,
      displayName: sub?.displayName,
      emailAddress: sub?.emailAddress,
      billingType: sub?.billingType,
      rateLimitTier: sub?.rateLimitTier,
      subscriptionCreatedAt: sub?.subscriptionCreatedAt,
      needsReauth,
      meta,
      ...windows,
      ...(weeklyReset ?? {}),
      live,
      tokenStatus,
      tokenRefreshedAt: live?.tokenRefreshedAt,
      tokenExpiresAt: live?.tokenExpiresAt,
    }
  }))
}
