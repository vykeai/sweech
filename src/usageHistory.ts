/**
 * Usage history — hourly utilization snapshots for sparkline rendering.
 *
 * Stores snapshots in ~/.sweech/history.json with a max-once-per-hour dedup
 * and auto-prunes entries older than 7 days.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { AccountInfo } from './subscriptions'
import { sparkline } from './charts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  /** Millisecond epoch when this snapshot was taken */
  timestamp: number
  /** Per-account utilization data keyed by commandName */
  accounts: Record<string, { u5h: number; u7d: number }>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const HISTORY_FILE = path.join(os.homedir(), '.sweech', 'history.json')
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000   // 7 days
const MIN_INTERVAL_MS = 60 * 60 * 1000         // 1 hour
const MAX_ENTRIES = 168                         // 7 days * 24 hours

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Exposed for testing: override the history file path. */
export let _historyFilePath = HISTORY_FILE

export function _setHistoryFilePath(p: string): void {
  _historyFilePath = p
}

export function _resetHistoryFilePath(): void {
  _historyFilePath = HISTORY_FILE
}

function readHistoryFile(): HistoryEntry[] {
  try {
    const raw = fs.readFileSync(_historyFilePath, 'utf-8')
    const data = JSON.parse(raw)
    if (Array.isArray(data)) return data as HistoryEntry[]
    return []
  } catch {
    return []
  }
}

function writeHistoryFile(entries: HistoryEntry[]): void {
  const dir = path.dirname(_historyFilePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(_historyFilePath, JSON.stringify(entries, null, 2))
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Prune history entries older than 7 days from the given array.
 * Returns the pruned array (does NOT write to disk).
 */
export function pruneOldEntries(entries: HistoryEntry[], now?: number): HistoryEntry[] {
  const cutoff = (now ?? Date.now()) - MAX_AGE_MS
  return entries.filter(e => e.timestamp >= cutoff)
}

/**
 * Append a utilization snapshot from the given account data.
 *
 * Deduplicates: skips if the last entry was recorded less than 1 hour ago.
 * Auto-prunes entries older than 7 days.
 */
export function appendSnapshot(accounts: AccountInfo[], now?: number): void {
  const ts = now ?? Date.now()
  let entries = readHistoryFile()

  // Dedup: skip if last entry is less than MIN_INTERVAL_MS ago
  if (entries.length > 0) {
    const last = entries[entries.length - 1]
    if (ts - last.timestamp < MIN_INTERVAL_MS) return
  }

  // Build accounts map from live data
  const accountsMap: Record<string, { u5h: number; u7d: number }> = {}
  for (const a of accounts) {
    const u5h = a.live?.utilization5h ?? a.live?.buckets?.[0]?.session?.utilization
    const u7d = a.live?.utilization7d ?? a.live?.buckets?.[0]?.weekly?.utilization
    if (u5h !== undefined || u7d !== undefined) {
      accountsMap[a.commandName] = {
        u5h: u5h ?? 0,
        u7d: u7d ?? 0,
      }
    }
  }

  // Only append if there's meaningful data
  if (Object.keys(accountsMap).length === 0) return

  entries.push({ timestamp: ts, accounts: accountsMap })

  // Prune old + enforce max
  entries = pruneOldEntries(entries, ts)
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES)
  }

  writeHistoryFile(entries)
}

/**
 * Get history entries for the last N hours (default 24).
 */
export function getHistory(hours = 24): HistoryEntry[] {
  const entries = readHistoryFile()
  const cutoff = Date.now() - hours * 60 * 60 * 1000
  return entries.filter(e => e.timestamp >= cutoff)
}

/**
 * Build a sparkline string for a given account over the last N hours.
 * Uses the 7d utilization values by default.
 *
 * @param accountName - The commandName of the account
 * @param hours - Number of hours of history to show (default 24)
 * @param field - Which utilization field to chart: 'u5h' or 'u7d' (default 'u7d')
 * @returns The sparkline string, or empty string if no data
 */
export function accountSparkline(
  accountName: string,
  hours = 24,
  field: 'u5h' | 'u7d' = 'u7d',
): string {
  const entries = getHistory(hours)
  const values = entries
    .map(e => e.accounts[accountName]?.[field])
    .filter((v): v is number => v !== undefined)
  return sparkline(values)
}

/**
 * Get sparkline data for all accounts found in the history.
 * Returns a map of commandName -> sparkline string.
 */
export function allAccountSparklines(
  hours = 24,
  field: 'u5h' | 'u7d' = 'u7d',
): Map<string, string> {
  const entries = getHistory(hours)
  const accountNames = new Set<string>()
  for (const e of entries) {
    for (const name of Object.keys(e.accounts)) {
      accountNames.add(name)
    }
  }
  const result = new Map<string, string>()
  for (const name of accountNames) {
    const values = entries
      .map(e => e.accounts[name]?.[field])
      .filter((v): v is number => v !== undefined)
    if (values.length > 0) {
      result.set(name, sparkline(values))
    }
  }
  return result
}
