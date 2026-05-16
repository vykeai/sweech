/**
 * Quota projection — short-window burn-rate forecasting.
 *
 * Hourly sparkline history (usageHistory.ts) is too coarse to answer
 * "can I finish this PR?". This module keeps a separate fast-cadence
 * sample buffer per account and computes a linear burn rate plus an
 * ETA-to-full from the most recent samples.
 *
 * Persisted to ~/.sweech/quota-samples.json. Ring-buffered per account
 * (MAX_SAMPLES_PER_ACCOUNT). Three samples minimum before any projection
 * is emitted — single-point trends are lies dressed as data.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { AccountInfo } from './subscriptions'
import { atomicWriteFileSync } from './atomicWrite'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectionSample {
  /** Millisecond epoch the sample was captured */
  ts: number
  /** 5h-rolling utilization, 0..1 */
  u5h: number
  /** 7d weekly utilization, 0..1 */
  u7d: number
}

export interface ProjectionSamplesFile {
  /** Schema version — bump when shape changes */
  version: 1
  /** accountName (commandName) → samples (oldest first) */
  accounts: Record<string, ProjectionSample[]>
}

export interface Projection {
  /** Δutil/min over the active window, may be negative (utilization falling) */
  rateUtilPerMinute: number
  /** Minutes from latest sample until 100%, null if rate ≤ 0 or already saturated */
  etaToFullMinutes: number | null
  /** Number of samples that contributed to this fit */
  sampleCount: number
}

export interface AccountProjection {
  projection5h: Projection | null
  projection7d: Projection | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SAMPLES_FILE = path.join(os.homedir(), '.sweech', 'quota-samples.json')

/** Discard samples older than this when computing projection. 60 min window keeps the trend recent. */
const PROJECTION_WINDOW_MS = 60 * 60 * 1000

/** Cap stored samples per account; recordSample drops the oldest beyond this. */
const MAX_SAMPLES_PER_ACCOUNT = 24

/** Minimum samples (within the projection window) before we emit any forecast. */
const MIN_SAMPLES_FOR_PROJECTION = 3

// ── Test seam: path override ──────────────────────────────────────────────────

let _samplesFilePath = SAMPLES_FILE

export function _setSamplesFilePath(p: string): void {
  _samplesFilePath = p
}

export function _resetSamplesFilePath(): void {
  _samplesFilePath = SAMPLES_FILE
}

// ── I/O ───────────────────────────────────────────────────────────────────────

/// Schema-validate samples on every read. A locally-corrupt or manually-edited
/// file could otherwise feed NaN/Infinity into computeProjection, which then
/// propagates into the JSON contract emitted to SweechBar (formatEta(NaN)
/// renders "NaN m"). We also cap the per-account series length on read so a
/// poisoned file with a million entries can't DoS the render loop.
function isValidSample(s: unknown): s is ProjectionSample {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  return (
    Number.isFinite(o.ts) &&
    Number.isFinite(o.u5h) &&
    Number.isFinite(o.u7d) &&
    (o.u5h as number) >= 0 && (o.u5h as number) <= 1 &&
    (o.u7d as number) >= 0 && (o.u7d as number) <= 1
  )
}

function readSamplesFile(): ProjectionSamplesFile {
  try {
    const raw = fs.readFileSync(_samplesFilePath, 'utf-8')
    const data = JSON.parse(raw)
    if (!data || data.version !== 1 || !data.accounts || typeof data.accounts !== 'object') {
      return { version: 1, accounts: {} }
    }
    const accounts: Record<string, ProjectionSample[]> = {}
    for (const [name, series] of Object.entries(data.accounts)) {
      if (!Array.isArray(series)) continue
      const clean = series.filter(isValidSample).slice(-MAX_SAMPLES_PER_ACCOUNT)
      accounts[name] = clean
    }
    return { version: 1, accounts }
  } catch {
    return { version: 1, accounts: {} }
  }
}

function writeSamplesFile(file: ProjectionSamplesFile): void {
  const dir = path.dirname(_samplesFilePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  atomicWriteFileSync(_samplesFilePath, JSON.stringify(file, null, 2))
  // Match the project's existing pattern (vaultAssign.ts:218/260/270) — the
  // file holds per-workspace utilization patterns; not credentials, but worth
  // 0o600 so a co-resident user can't infer activity windows.
  try { fs.chmodSync(_samplesFilePath, 0o600) } catch {}
}

// ── Recording ─────────────────────────────────────────────────────────────────

/**
 * Append one sample per account from a fresh live-usage fetch. Caps each
 * account's series at MAX_SAMPLES_PER_ACCOUNT, dropping oldest first.
 * Skips accounts with no live data or utilization undefined on both windows.
 */
export function recordProjectionSamples(accounts: AccountInfo[], now?: number): void {
  const ts = now ?? Date.now()
  const file = readSamplesFile()
  let mutated = false

  for (const a of accounts) {
    const u5h = a.live?.buckets?.[0]?.session?.utilization
    const u7d = a.live?.buckets?.[0]?.weekly?.utilization
    if (u5h === undefined && u7d === undefined) continue

    const sample: ProjectionSample = {
      ts,
      u5h: u5h ?? 0,
      u7d: u7d ?? 0,
    }

    const series = file.accounts[a.commandName] ?? []
    series.push(sample)
    while (series.length > MAX_SAMPLES_PER_ACCOUNT) series.shift()
    file.accounts[a.commandName] = series
    mutated = true
  }

  if (mutated) writeSamplesFile(file)
}

// ── Compute ───────────────────────────────────────────────────────────────────

/**
 * Linear burn-rate fit over the recent window. Returns null when fewer
 * than MIN_SAMPLES_FOR_PROJECTION samples lie within the window — we
 * deliberately refuse to project on insufficient data.
 *
 * The fit is intentionally simple: (latest - earliest) / Δt across the
 * window. Robust to noise that a least-squares fit would overfit to.
 */
export function computeProjection(
  samples: ProjectionSample[],
  field: 'u5h' | 'u7d',
  now?: number,
): Projection | null {
  if (!samples || samples.length < MIN_SAMPLES_FOR_PROJECTION) return null
  const ts = now ?? Date.now()
  const cutoff = ts - PROJECTION_WINDOW_MS
  const recent = samples.filter(s => s.ts >= cutoff)
  if (recent.length < MIN_SAMPLES_FOR_PROJECTION) return null

  const first = recent[0]
  const last = recent[recent.length - 1]
  const deltaMin = (last.ts - first.ts) / 60000
  if (deltaMin <= 0) return null

  const rateUtilPerMinute = (last[field] - first[field]) / deltaMin

  // Already saturated OR rate non-positive → no forward-looking ETA. Both
  // states return null so JSON consumers have one canonical "no projection"
  // shape; the rate field still tells callers WHY (positive = at cap, zero
  // = flat, negative = falling).
  if (last[field] >= 1 || rateUtilPerMinute <= 0) {
    return { rateUtilPerMinute, etaToFullMinutes: null, sampleCount: recent.length }
  }

  const etaToFullMinutes = (1 - last[field]) / rateUtilPerMinute
  return {
    rateUtilPerMinute,
    etaToFullMinutes,
    sampleCount: recent.length,
  }
}

/**
 * Convenience: read samples file and emit { projection5h, projection7d }
 * for one account. Returns null projections when no samples exist.
 */
export function getAccountProjection(accountName: string, now?: number): AccountProjection {
  const file = readSamplesFile()
  const samples = file.accounts[accountName] ?? []
  return {
    projection5h: computeProjection(samples, 'u5h', now),
    projection7d: computeProjection(samples, 'u7d', now),
  }
}

/**
 * Format minutes as a compact label: "47m", "2h", "3d", "full" (0).
 * Clamps boundary rounding so 59.6 doesn't render "60m" — same defence the
 * sibling expiryFormat module uses.
 */
export function formatEta(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return ''
  if (minutes <= 0) return 'full'
  if (minutes < 60) {
    const m = Math.round(minutes)
    return `${m >= 60 ? 59 : m}m`
  }
  if (minutes < 60 * 24) {
    const h = Math.round(minutes / 60)
    return `${h >= 24 ? 23 : h}h`
  }
  return `${Math.round(minutes / (60 * 24))}d`
}
