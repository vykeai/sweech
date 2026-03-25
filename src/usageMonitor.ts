/**
 * Usage threshold monitor for sweech.
 *
 * Tracks per-account utilization state and emits events when thresholds are
 * crossed or limits change state:
 *
 *   - usage_threshold — utilization crosses 70% or 90%
 *   - limit_reached   — account hits 100% utilization (session or weekly)
 *   - limit_recovered — account drops back below 100% after being at limit
 */

import { sweechEvents } from './events';
import type { LiveRateLimitData } from './liveUsage';

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------

interface AccountState {
  /** Was the account at limit (>=100%) last time we checked? Keyed by window. */
  atLimit5h: boolean;
  atLimit7d: boolean;
  /** Which thresholds have already been fired for the current window?
   *  We only fire each threshold once per upward crossing. */
  firedThresholds5h: Set<number>;
  firedThresholds7d: Set<number>;
}

const stateMap = new Map<string, AccountState>();

const THRESHOLDS = [70, 90] as const;

function getState(account: string): AccountState {
  let state = stateMap.get(account);
  if (!state) {
    state = {
      atLimit5h: false,
      atLimit7d: false,
      firedThresholds5h: new Set(),
      firedThresholds7d: new Set(),
    };
    stateMap.set(account, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check live usage data for an account and emit events for threshold crossings,
 * limit reached, and limit recovery.
 *
 * Call this after fetching fresh live data (e.g. from refreshLiveUsage).
 */
export function checkUsageThresholds(account: string, live: LiveRateLimitData | undefined): void {
  if (!live?.buckets?.length) return;

  const state = getState(account);
  const now = new Date().toISOString();

  // We check the primary bucket (index 0) which represents overall utilization
  const primary = live.buckets[0];

  // --- Session (5h) window ---
  if (primary.session) {
    const pct = Math.round(primary.session.utilization * 100);
    checkWindow(account, '5h', pct, state, 'atLimit5h', 'firedThresholds5h', now);
  }

  // --- Weekly (7d) window ---
  if (primary.weekly) {
    const pct = Math.round(primary.weekly.utilization * 100);
    checkWindow(account, '7d', pct, state, 'atLimit7d', 'firedThresholds7d', now);
  }
}

function checkWindow(
  account: string,
  window: '5h' | '7d',
  pct: number,
  state: AccountState,
  atLimitKey: 'atLimit5h' | 'atLimit7d',
  firedKey: 'firedThresholds5h' | 'firedThresholds7d',
  now: string,
): void {
  const wasAtLimit = state[atLimitKey];
  const firedSet = state[firedKey];

  // Threshold events (70%, 90%)
  for (const threshold of THRESHOLDS) {
    if (pct >= threshold && !firedSet.has(threshold)) {
      firedSet.add(threshold);
      sweechEvents.emit('usage_threshold', {
        account,
        threshold,
        utilization: pct,
        window,
        timestamp: now,
      });
    }
    // Reset fired state when utilization drops back below a threshold
    if (pct < threshold && firedSet.has(threshold)) {
      firedSet.delete(threshold);
    }
  }

  // Limit reached (>=100%)
  if (pct >= 100 && !wasAtLimit) {
    state[atLimitKey] = true;
    sweechEvents.emit('limit_reached', {
      account,
      window,
      timestamp: now,
    });
  }

  // Limit recovered (<100% after being at limit)
  if (pct < 100 && wasAtLimit) {
    state[atLimitKey] = false;
    sweechEvents.emit('limit_recovered', {
      account,
      window,
      timestamp: now,
    });
  }
}

/**
 * Reset tracked state for an account. Useful for testing.
 */
export function resetAccountState(account: string): void {
  stateMap.delete(account);
}

/**
 * Clear all tracked state. Useful for testing.
 */
export function resetAllState(): void {
  stateMap.clear();
}
