"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkUsageThresholds = checkUsageThresholds;
exports.resetAccountState = resetAccountState;
exports.resetAllState = resetAllState;
const events_1 = require("./events");
const stateMap = new Map();
const THRESHOLDS = [70, 90];
function getState(account) {
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
function checkUsageThresholds(account, live) {
    if (!live?.buckets?.length)
        return;
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
function checkWindow(account, window, pct, state, atLimitKey, firedKey, now) {
    const wasAtLimit = state[atLimitKey];
    const firedSet = state[firedKey];
    // Threshold events (70%, 90%)
    for (const threshold of THRESHOLDS) {
        if (pct >= threshold && !firedSet.has(threshold)) {
            firedSet.add(threshold);
            events_1.sweechEvents.emit('usage_threshold', {
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
        events_1.sweechEvents.emit('limit_reached', {
            account,
            window,
            timestamp: now,
        });
    }
    // Limit recovered (<100% after being at limit)
    if (pct < 100 && wasAtLimit) {
        state[atLimitKey] = false;
        events_1.sweechEvents.emit('limit_recovered', {
            account,
            window,
            timestamp: now,
        });
    }
}
/**
 * Reset tracked state for an account. Useful for testing.
 */
function resetAccountState(account) {
    stateMap.delete(account);
}
/**
 * Clear all tracked state. Useful for testing.
 */
function resetAllState() {
    stateMap.clear();
}
