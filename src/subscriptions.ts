/**
 * Claude Code subscription tracker.
 *
 * Data sources (all local, no API calls):
 *   ~/.claude-{name}/history.jsonl   — per-message timestamps for 5h/7d windows
 *   ~/.claude-{name}/.claude.json    — account metadata, subscriptionCreatedAt
 *   ~/.sweech/subscriptions.json     — user-configured plan labels
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

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
  configDir: string

  // From .claude.json
  displayName?: string
  emailAddress?: string
  billingType?: string
  subscriptionCreatedAt?: string

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
  }
}

function readClaudeJson(configDir: string): ClaudeJson {
  const file = path.join(configDir, '.claude.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as ClaudeJson
  } catch {
    return {}
  }
}

// ── history.jsonl reader ──────────────────────────────────────────────────────

interface HistoryEntry {
  timestamp?: number
  sessionId?: string
  display?: string
}

function readHistory(configDir: string): HistoryEntry[] {
  const file = path.join(configDir, 'history.jsonl')
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf-8')
  const entries: HistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line) as HistoryEntry) } catch { /* skip */ }
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

export function getAccountInfo(
  profiles: Array<{ name: string; commandName: string }>,
): AccountInfo[] {
  const allMeta = readMeta()

  return profiles.map(p => {
    const configDir = getConfigDir(p.commandName)
    const meta = allMeta[p.commandName] ?? {}
    const claude = readClaudeJson(configDir)
    const history = readHistory(configDir)
    const windows = computeWindows(history)

    const sub = claude.oauthAccount
    const weeklyReset = sub?.subscriptionCreatedAt
      ? computeWeeklyReset(sub.subscriptionCreatedAt)
      : undefined

    return {
      name: p.name,
      commandName: p.commandName,
      configDir,
      displayName: sub?.displayName,
      emailAddress: sub?.emailAddress,
      billingType: sub?.billingType,
      subscriptionCreatedAt: sub?.subscriptionCreatedAt,
      meta,
      ...windows,
      ...(weeklyReset ?? {}),
    }
  })
}
