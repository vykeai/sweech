/**
 * Shared freshness/staleness helper for on-disk data sources.
 *
 * Every cache, snapshot, and history file under ~/.sweech/ records when its
 * contents were last successfully refreshed. The upcoming dashboard reads
 * those files and needs to render the same "fresh / stale / very-stale / never"
 * tri-state regardless of which subsystem wrote the file. This module is the
 * single source of truth for that classification.
 *
 * The thresholds match the rate-limit cache's existing 5-minute TTL
 * (liveUsage.ts:192). Anything younger than 5 min is treated as fresh,
 * younger than 15 min is stale-but-usable, and anything older is very-stale —
 * the UI should warn loudly that the underlying source has not been refreshed
 * recently (the same condition that produced the codex-ted "OK but actually
 * rate-limited" regression).
 *
 * When a timestamp is null/undefined we return 'never' rather than treating it
 * as ancient — the distinction matters during the on-disk migration where
 * legacy files lack a `fetchedAt` field and we want to surface that explicitly
 * instead of pretending the data is hours old.
 */

import * as fs from 'fs'

/** Anything younger than this is fresh. */
export const FRESH_THRESHOLD_MS = 5 * 60 * 1000

/** Anything between FRESH_THRESHOLD_MS and this is stale. Beyond this is very-stale. */
export const STALE_THRESHOLD_MS = 15 * 60 * 1000

export type FreshnessState = 'fresh' | 'stale' | 'very-stale' | 'never'

export interface FreshnessStamp {
  /** Unix ms when the source was last refreshed. `null` when never stamped. */
  fetchedAt: number | null
  /** now - fetchedAt. `null` when fetchedAt is null. */
  ageMs: number | null
  /** Tri-state classification. */
  state: FreshnessState
}

/**
 * Classify a timestamp into a {@link FreshnessStamp}. Accepts `number | null |
 * undefined` so callers can pass raw JSON fields without pre-checking.
 *
 * `nowMs` is injectable for tests — production callers should leave it
 * undefined so we use the real clock.
 */
export function freshnessFromTimestamp(
  ts: number | null | undefined,
  nowMs?: number,
): FreshnessStamp {
  // Treat NaN/Infinity/non-numbers the same as missing — a corrupted file
  // should surface 'never' rather than mislabelling itself as ancient.
  if (ts == null || !Number.isFinite(ts) || ts <= 0) {
    return { fetchedAt: null, ageMs: null, state: 'never' }
  }
  const now = nowMs ?? Date.now()
  const ageMs = Math.max(0, now - ts)
  let state: FreshnessState
  if (ageMs < FRESH_THRESHOLD_MS) state = 'fresh'
  else if (ageMs < STALE_THRESHOLD_MS) state = 'stale'
  else state = 'very-stale'
  return { fetchedAt: ts, ageMs, state }
}

/**
 * Classify by file mtime. Used by the on-disk migration: a file that exists
 * but lacks an in-band `fetchedAt` is best-effort dated by its last write
 * time so the dashboard doesn't have to special-case the pre-upgrade era.
 *
 * Returns 'never' when the path doesn't exist or the stat fails.
 */
export function freshnessFromFileMtime(path: string, nowMs?: number): FreshnessStamp {
  try {
    const st = fs.statSync(path)
    return freshnessFromTimestamp(st.mtimeMs, nowMs)
  } catch {
    return { fetchedAt: null, ageMs: null, state: 'never' }
  }
}

/**
 * Read a file's mtime as a unix ms timestamp, or `null` when the file is
 * missing/unreadable. Helper for the one-shot migration that backfills
 * `fetchedAt` from mtime when the JSON payload lacks it.
 */
export function fileMtimeMs(path: string): number | null {
  try {
    return fs.statSync(path).mtimeMs
  } catch {
    return null
  }
}
