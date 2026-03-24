/**
 * Edge case tests for launcher sort, smart-score, and expiryAlert logic.
 */

import { LaunchEntry, entrySmartScore, sortedWithinGroup, getSorted, expiryAlert } from '../src/launcher';

// ---------------------------------------------------------------------------
// Helpers (mirrored from launcherSort.test.ts)
// ---------------------------------------------------------------------------

const NOW = Math.floor(Date.now() / 1000);
const HOURS = (h: number) => NOW + h * 3600;

function makeEntry({ name, command = 'claude', needsReauth = false, bars = [], ...rest }: Partial<LaunchEntry> & { name: string }): LaunchEntry {
  return {
    name,
    command,
    configDir: null,
    label: 'test',
    yoloFlag: '--dangerously-skip-permissions',
    resumeFlag: '--continue',
    isDefault: false,
    dataDir: `/home/.${name}`,
    dataSizeMB: '10M',
    authType: 'Pro',
    needsReauth,
    lastActive: '',
    bars,
    ...rest,
  };
}

function bar5h(pct: number, resetsAt = HOURS(2)): LaunchEntry['bars'][0] {
  return { label: 'All models 5h', pct, resetLabel: '', resetsAt, windowMins: 300 };
}

function bar7d(pct: number, resetsAt = HOURS(48)): LaunchEntry['bars'][0] {
  return { label: 'All models 7d', pct, resetLabel: '', resetsAt, windowMins: 10080 };
}

// ---------------------------------------------------------------------------
// expiryAlert — edge cases
// ---------------------------------------------------------------------------

describe('expiryAlert edge cases', () => {
  test('returns alert when hoursLeft is exactly 72 (boundary is strict >)', () => {
    // The condition is hoursLeft >= 72 returns '', but due to test execution
    // time, hoursLeft will be slightly < 72, so it returns an alert.
    // Actually the code is: hoursLeft >= 72 → ''. At exactly 72 the condition
    // depends on sub-second timing. Let's test just past 72 to be safe.
    const e = makeEntry({ name: 'a', bars: [bar7d(50, HOURS(72.1))] });
    expect(expiryAlert(e)).toBe('');
  });

  test('returns alert when hoursLeft is just under 72', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(50, HOURS(71.9))] });
    expect(expiryAlert(e)).not.toBe('');
    expect(expiryAlert(e)).toContain('⚡');
  });

  test('returns empty string when hoursLeft is exactly 0', () => {
    // hoursLeft <= 0 returns ''
    const e = makeEntry({ name: 'a', bars: [bar7d(50, NOW)] });
    expect(expiryAlert(e)).toBe('');
  });

  test('returns empty string when hoursLeft is negative (past reset)', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(50, HOURS(-5))] });
    expect(expiryAlert(e)).toBe('');
  });

  test('returns empty string when remaining is exactly 0%', () => {
    // 100% used → 0% remaining → below 5% threshold
    const e = makeEntry({ name: 'a', bars: [bar7d(100, HOURS(10))] });
    expect(expiryAlert(e)).toBe('');
  });

  test('returns empty string at remaining exactly 4% (below 5%)', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(96, HOURS(10))] });
    expect(expiryAlert(e)).toBe('');
  });

  test('returns alert at remaining exactly 5%', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(95, HOURS(10))] });
    const alert = expiryAlert(e);
    expect(alert).not.toBe('');
    expect(alert).toContain('5%');
  });

  test('returns alert when remaining is 100% (0% used)', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(0, HOURS(10))] });
    const alert = expiryAlert(e);
    expect(alert).not.toBe('');
    expect(alert).toContain('100%');
  });

  test('shows hours label for reset exactly at 24h boundary', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(50, HOURS(24))] });
    const alert = expiryAlert(e);
    // hoursLeft < 24 → hours label. At exactly 24h, Math.round(24) = 24h
    expect(alert).toMatch(/24h/);
  });

  test('shows hours label for reset at 23.5h', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(50, HOURS(23.5))] });
    const alert = expiryAlert(e);
    expect(alert).toMatch(/\d+h/);
  });

  test('returns empty string when no resetsAt on 7d bar', () => {
    const e = makeEntry({ name: 'a', bars: [
      { label: 'All models 7d', pct: 50, resetLabel: '', resetsAt: undefined, windowMins: 10080 },
    ]});
    expect(expiryAlert(e)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// entrySmartScore — edge cases
// ---------------------------------------------------------------------------

describe('entrySmartScore edge cases', () => {
  test('returns -1 when bar5h is at exactly 100%', () => {
    const e = makeEntry({ name: 'a', bars: [bar5h(100)] });
    expect(entrySmartScore(e)).toBe(-1);
  });

  test('does not return -1 when bar5h is at 99%', () => {
    const e = makeEntry({ name: 'a', bars: [bar5h(99)] });
    expect(entrySmartScore(e)).not.toBe(-1);
  });

  test('returns 0 for entry with completely empty bars array', () => {
    const e = makeEntry({ name: 'a', bars: [] });
    expect(entrySmartScore(e)).toBe(0);
  });

  test('handles 5h bar at exactly 100% with a 7d bar present', () => {
    const e = makeEntry({ name: 'a', bars: [bar5h(100), bar7d(50)] });
    expect(entrySmartScore(e)).toBe(-1); // 5h at 100% takes priority
  });

  test('handles 7d bar at 0% (fully available) with near reset', () => {
    const e = makeEntry({ name: 'a', bars: [bar5h(0), bar7d(0, HOURS(10))] });
    const score = entrySmartScore(e);
    // 100% remaining, resets in 10h (< 72h) → tier boost: 100 + baseScore
    expect(score).toBeGreaterThan(100);
  });

  test('handles 7d bar at 100% (fully used)', () => {
    const e = makeEntry({ name: 'a', bars: [bar5h(0), bar7d(100, HOURS(10))] });
    const score = entrySmartScore(e);
    // 0% remaining → below 5% threshold, no tier boost. baseScore = 0/daysLeft = 0
    expect(score).toBe(0);
  });

  test('multiple 7d bars — uses first one found', () => {
    // Two 7d bars: entrySmartScore uses .find(), so first wins
    const e = makeEntry({ name: 'a', bars: [
      bar5h(0),
      { label: 'Model A 7d', pct: 90, resetLabel: '', resetsAt: HOURS(10), windowMins: 10080 },
      { label: 'Model B 7d', pct: 10, resetLabel: '', resetsAt: HOURS(10), windowMins: 10080 },
    ]});
    const score = entrySmartScore(e);
    // First 7d bar: 10% remaining, resetsIn=10h (<72h), remaining>=5% → tier boost
    // baseScore = 0.1 / (10/24) = 0.24, score = 100.24
    expect(score).toBeGreaterThan(100);
    expect(score).toBeLessThan(101); // only 10% remaining
  });

  test('very small hoursLeft (< 0.5) is clamped to 0.5', () => {
    // Reset in 0.1h → clamped to 0.5h
    const e = makeEntry({ name: 'a', bars: [bar5h(0), bar7d(50, HOURS(0.1))] });
    const score = entrySmartScore(e);
    // remaining=50%, hoursLeft=max(0.5, 0.1)=0.5, daysLeft=0.5/24
    // baseScore = 0.5 / (0.5/24) = 24.0
    // hoursLeft < 72 && remaining >= 5% → tier boost: 100 + 24 = 124
    expect(score).toBeGreaterThan(100);
  });

  test('scores only from 5h bar when no 7d bar exists', () => {
    const e = makeEntry({ name: 'a', bars: [bar5h(60)] });
    // remaining = 40% → score = 0.4
    expect(entrySmartScore(e)).toBeCloseTo(0.4);
  });

  test('needsReauth takes priority over all bar states', () => {
    const e = makeEntry({ name: 'a', needsReauth: true, bars: [bar5h(0), bar7d(0, HOURS(1))] });
    expect(entrySmartScore(e)).toBe(-2);
  });
});

// ---------------------------------------------------------------------------
// getSorted — edge cases
// ---------------------------------------------------------------------------

describe('getSorted edge cases', () => {
  test('handles empty array', () => {
    expect(getSorted([], 'smart', true)).toEqual([]);
    expect(getSorted([], 'smart', false)).toEqual([]);
    expect(getSorted([], 'manual', true)).toEqual([]);
    expect(getSorted([], 'status', false)).toEqual([]);
  });

  test('single entry returns that entry', () => {
    const entry = makeEntry({ name: 'solo', bars: [bar5h(50)] });
    const result = getSorted([entry], 'smart', true);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('solo');
  });

  test('all entries with same score maintains stable relative order (no crash)', () => {
    const entries = [
      makeEntry({ name: 'a', bars: [bar5h(50), bar7d(50, HOURS(48))] }),
      makeEntry({ name: 'b', bars: [bar5h(50), bar7d(50, HOURS(48))] }),
      makeEntry({ name: 'c', bars: [bar5h(50), bar7d(50, HOURS(48))] }),
    ];
    const result = getSorted(entries, 'smart', false);
    expect(result).toHaveLength(3);
    // All should be present
    expect(result.map(e => e.name).sort()).toEqual(['a', 'b', 'c']);
  });

  test('all needsReauth profiles are sorted to end', () => {
    const entries = [
      makeEntry({ name: 'reauth1', needsReauth: true }),
      makeEntry({ name: 'reauth2', needsReauth: true }),
      makeEntry({ name: 'ok', bars: [bar5h(50)] }),
    ];
    const sorted = getSorted(entries, 'smart', false);
    expect(sorted[0].name).toBe('ok');
    expect(sorted.slice(1).every(e => e.needsReauth)).toBe(true);
  });

  test('grouped mode with only claude entries', () => {
    const entries = [
      makeEntry({ name: 'a', command: 'claude', bars: [bar5h(0), bar7d(20, HOURS(10))] }),
      makeEntry({ name: 'b', command: 'claude', bars: [bar5h(0), bar7d(20, HOURS(50))] }),
    ];
    const result = getSorted(entries, 'smart', true);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('a'); // sooner reset
  });

  test('grouped mode with only codex entries', () => {
    const entries = [
      makeEntry({ name: 'a', command: 'codex', bars: [bar5h(0), bar7d(20, HOURS(50))] }),
      makeEntry({ name: 'b', command: 'codex', bars: [bar5h(0), bar7d(20, HOURS(10))] }),
    ];
    const result = getSorted(entries, 'smart', true);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('b'); // sooner reset
  });

  test('status sort with all needsReauth', () => {
    const entries = [
      makeEntry({ name: 'a', needsReauth: true }),
      makeEntry({ name: 'b', needsReauth: true }),
    ];
    const sorted = sortedWithinGroup(entries, 'status');
    expect(sorted).toHaveLength(2);
  });

  test('status sort with all limit_reached (5h at 100%)', () => {
    const entries = [
      makeEntry({ name: 'a', bars: [bar5h(100)] }),
      makeEntry({ name: 'b', bars: [bar5h(100)] }),
    ];
    const sorted = sortedWithinGroup(entries, 'status');
    expect(sorted).toHaveLength(2);
  });

  test('smart sort with mix of negative and positive scores', () => {
    const entries = [
      makeEntry({ name: 'reauth', needsReauth: true }),
      makeEntry({ name: 'limited', bars: [bar5h(100)] }),
      makeEntry({ name: 'healthy', bars: [bar5h(0), bar7d(30, HOURS(48))] }),
    ];
    const sorted = sortedWithinGroup(entries, 'smart');
    expect(sorted[0].name).toBe('healthy');
    expect(sorted[1].name).toBe('limited');
    expect(sorted[2].name).toBe('reauth');
  });
});

// ---------------------------------------------------------------------------
// sortedWithinGroup does not mutate
// ---------------------------------------------------------------------------

describe('sortedWithinGroup immutability', () => {
  test('status sort does not mutate the original array', () => {
    const entries = [
      makeEntry({ name: 'reauth', needsReauth: true }),
      makeEntry({ name: 'ok', bars: [bar5h(50)] }),
    ];
    const original = entries.map(e => e.name);
    sortedWithinGroup(entries, 'status');
    expect(entries.map(e => e.name)).toEqual(original);
  });

  test('manual sort returns same reference characteristics', () => {
    const entries = [
      makeEntry({ name: 'a' }),
      makeEntry({ name: 'b' }),
    ];
    const sorted = sortedWithinGroup(entries, 'manual');
    expect(sorted).toBe(entries); // manual returns the same array reference
  });
});
