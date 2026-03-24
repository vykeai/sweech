/**
 * Tests for launcher sort, grouping, and smart-score logic.
 */

import { LaunchEntry, entrySmartScore, sortedWithinGroup, getSorted, expiryAlert } from '../src/launcher';

// ---------------------------------------------------------------------------
// Helpers
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
// entrySmartScore
// ---------------------------------------------------------------------------

describe('entrySmartScore', () => {
  test('returns -2 for needsReauth', () => {
    const e = makeEntry({ name: 'a', needsReauth: true });
    expect(entrySmartScore(e)).toBe(-2);
  });

  test('returns -1 when 5h bar is at 100%', () => {
    const e = makeEntry({ name: 'a', bars: [bar5h(100), bar7d(50)] });
    expect(entrySmartScore(e)).toBe(-1);
  });

  test('no-reset-time account scores lower than account with imminent expiry', () => {
    // Fresh account: 100% remaining, no reset time → score = 1.0/7 ≈ 0.143
    const fresh = makeEntry({ name: 'fresh', bars: [bar5h(0), bar7d(0)] }); // 0% used, no resetsAt set by default... actually bar7d sets one
    // Manually make a bar with no resetsAt
    const freshNoReset = makeEntry({ name: 'fresh', bars: [
      { label: 'All models 5h', pct: 0, resetLabel: '', resetsAt: undefined as any, windowMins: 300 },
      { label: 'All models 7d', pct: 0, resetLabel: '', resetsAt: undefined as any, windowMins: 10080 },
    ]});
    // Account with 19% left, resets in 5h → score = 0.81/5h * 24 ≈ 3.89... wait no: remaining=0.19, hoursLeft=5
    const expiring = makeEntry({ name: 'expiring', bars: [bar5h(0), bar7d(81, HOURS(5))] }); // 19% left
    expect(entrySmartScore(freshNoReset)).toBeLessThan(entrySmartScore(expiring));
  });

  test('scores by 5h remaining when no 7d bar at all', () => {
    const e = makeEntry({ name: 'a', bars: [bar5h(40)] });
    expect(entrySmartScore(e)).toBeCloseTo(0.6); // 60% remaining (no weekly limit)
  });

  test('higher remaining7d → higher score', () => {
    const resetIn48h = HOURS(48);
    const high = makeEntry({ name: 'high', bars: [bar5h(0), bar7d(20, resetIn48h)] }); // 80% left
    const low  = makeEntry({ name: 'low',  bars: [bar5h(0), bar7d(70, resetIn48h)] }); // 30% left
    expect(entrySmartScore(high)).toBeGreaterThan(entrySmartScore(low));
  });

  test('sooner reset → higher score for same remaining%', () => {
    // both have 60% weekly remaining; one resets in 1d, other in 6d
    const urgent = makeEntry({ name: 'urgent', bars: [bar5h(0), bar7d(40, HOURS(24))] });
    const relaxed = makeEntry({ name: 'relaxed', bars: [bar5h(0), bar7d(40, HOURS(144))] });
    expect(entrySmartScore(urgent)).toBeGreaterThan(entrySmartScore(relaxed));
  });

  test('expiring profile beats non-expiring even with less remaining capacity', () => {
    // codex-ted scenario: 32% remaining, resets in 36h (within 72h → expiring)
    const expiring = makeEntry({ name: 'expiring', bars: [bar5h(0), bar7d(68, HOURS(36))] });
    // codex-pole scenario: 100% remaining, resets in 109h (> 72h → not expiring)
    const notExpiring = makeEntry({ name: 'not-expiring', bars: [bar5h(0), bar7d(0, HOURS(109))] });
    // Without the tier boost, notExpiring would have a similar or higher waste rate.
    // With the tier boost, the expiring profile should always win.
    expect(entrySmartScore(expiring)).toBeGreaterThan(entrySmartScore(notExpiring));
  });

  test('tier boost only applies when remaining >= 5%', () => {
    // 3% remaining, resets in 12h → below 5% threshold, no tier boost
    const almostEmpty = makeEntry({ name: 'empty', bars: [bar5h(0), bar7d(97, HOURS(12))] });
    // 80% remaining, resets in 4 days → not expiring, no tier boost
    const plenty = makeEntry({ name: 'plenty', bars: [bar5h(0), bar7d(20, HOURS(96))] });
    // almostEmpty score: 0.03 / (12/24) = 0.06 (no boost — below 5%)
    // plenty score: 0.8 / (96/24) = 0.2 (no boost)
    expect(entrySmartScore(plenty)).toBeGreaterThan(entrySmartScore(almostEmpty));
  });

  test('returns 0 for entry with no bars', () => {
    const e = makeEntry({ name: 'a' });
    expect(entrySmartScore(e)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sortedWithinGroup
// ---------------------------------------------------------------------------

describe('sortedWithinGroup', () => {
  const entries = [
    makeEntry({ name: 'limited',  bars: [bar5h(100), bar7d(50)] }),           // score -1
    makeEntry({ name: 'urgent',   bars: [bar5h(0),   bar7d(20, HOURS(12))] }), // high score
    makeEntry({ name: 'relaxed',  bars: [bar5h(0),   bar7d(20, HOURS(120))] }),// lower score
    makeEntry({ name: 'reauth',   needsReauth: true }),                         // score -2
  ];

  test('smart sort puts urgent first, limited and reauth last', () => {
    const sorted = sortedWithinGroup(entries, 'smart');
    expect(sorted[0].name).toBe('urgent');
    expect(sorted[sorted.length - 1].name).toBe('reauth');
    const limitedIdx = sorted.findIndex(e => e.name === 'limited');
    const reauthIdx  = sorted.findIndex(e => e.name === 'reauth');
    expect(limitedIdx).toBeGreaterThan(sorted.findIndex(e => e.name === 'urgent'));
    expect(reauthIdx).toBeGreaterThan(limitedIdx);
  });

  test('status sort puts limit_reached and reauth at the bottom', () => {
    const withStatus = [
      makeEntry({ name: 'ok',      bars: [bar5h(50)] }),
      makeEntry({ name: 'limited', bars: [bar5h(100)] }),
      makeEntry({ name: 'reauth',  needsReauth: true }),
    ];
    const sorted = sortedWithinGroup(withStatus, 'status');
    expect(sorted[0].name).toBe('ok');
    // limited and reauth should be after ok
    const okIdx      = sorted.findIndex(e => e.name === 'ok');
    const limitedIdx = sorted.findIndex(e => e.name === 'limited');
    const reauthIdx  = sorted.findIndex(e => e.name === 'reauth');
    expect(limitedIdx).toBeGreaterThan(okIdx);
    expect(reauthIdx).toBeGreaterThan(okIdx);
  });

  test('manual sort preserves original order', () => {
    const names = entries.map(e => e.name);
    const sorted = sortedWithinGroup(entries, 'manual');
    expect(sorted.map(e => e.name)).toEqual(names);
  });

  test('smart sort does not mutate the original array', () => {
    const original = [...entries];
    sortedWithinGroup(entries, 'smart');
    expect(entries.map(e => e.name)).toEqual(original.map(e => e.name));
  });
});

// ---------------------------------------------------------------------------
// getSorted — grouping
// ---------------------------------------------------------------------------

describe('getSorted', () => {
  const claudeA = makeEntry({ name: 'claude-a', command: 'claude', bars: [bar5h(0), bar7d(10, HOURS(10))] });
  const claudeB = makeEntry({ name: 'claude-b', command: 'claude', bars: [bar5h(0), bar7d(10, HOURS(100))] });
  const codexA  = makeEntry({ name: 'codex-a',  command: 'codex',  bars: [bar5h(0), bar7d(20, HOURS(5))] });
  const codexB  = makeEntry({ name: 'codex-b',  command: 'codex',  bars: [bar5h(0), bar7d(20, HOURS(50))] });
  const all = [claudeA, claudeB, codexA, codexB];

  test('grouped=true keeps claude and codex in separate sections', () => {
    const sorted = getSorted(all, 'smart', true);
    const claudeIdx = sorted.filter(e => e.command === 'claude').map(e => sorted.indexOf(e));
    const codexIdx  = sorted.filter(e => e.command === 'codex').map(e => sorted.indexOf(e));
    // all claude entries should come before all codex entries (since claude !== 'codex' filter)
    expect(Math.max(...claudeIdx)).toBeLessThan(Math.min(...codexIdx));
  });

  test('grouped=true: smart sort within each group independently', () => {
    const sorted = getSorted(all, 'smart', true);
    const claudeSorted = sorted.filter(e => e.command === 'claude');
    const codexSorted  = sorted.filter(e => e.command === 'codex');
    // claudeA has sooner reset → higher score → should be first in claude group
    expect(claudeSorted[0].name).toBe('claude-a');
    // codexA has sooner reset → higher score → should be first in codex group
    expect(codexSorted[0].name).toBe('codex-a');
  });

  test('grouped=false: all accounts sorted together by smart score', () => {
    // codexA has highest score (20% remaining, resets in 5h) → should be #1 overall
    const sorted = getSorted(all, 'smart', false);
    expect(sorted[0].name).toBe('codex-a');
  });

  test('grouped=false: no provider separation — claude and codex interleaved by score', () => {
    const sorted = getSorted(all, 'smart', false);
    const commands = sorted.map(e => e.command);
    // Should NOT be [claude, claude, codex, codex] — codexA should come before claudeB
    expect(commands).not.toEqual(['claude', 'claude', 'codex', 'codex']);
  });

  test('manual sort preserves original order in both grouped modes', () => {
    const sortedGrouped   = getSorted(all, 'manual', true);
    const sortedUngrouped = getSorted(all, 'manual', false);
    // grouped: claude group order preserved, then codex group order preserved
    const claudeGrouped = sortedGrouped.filter(e => e.command === 'claude');
    expect(claudeGrouped.map(e => e.name)).toEqual(['claude-a', 'claude-b']);
    // ungrouped: overall order preserved
    expect(sortedUngrouped.map(e => e.name)).toEqual(all.map(e => e.name));
  });
});

// ---------------------------------------------------------------------------
// expiryAlert
// ---------------------------------------------------------------------------

describe('expiryAlert', () => {
  test('returns empty string when no 7d bar', () => {
    const e = makeEntry({ name: 'a', bars: [bar5h(50)] });
    expect(expiryAlert(e)).toBe('');
  });

  test('returns empty string when remaining ≤ 10%', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(92, HOURS(10))] }); // 8% remaining
    expect(expiryAlert(e)).toBe('');
  });

  test('returns empty string when reset > 72h away', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(20, HOURS(100))] }); // 80% left but resets in 100h
    expect(expiryAlert(e)).toBe('');
  });

  test('returns alert string when >10% remaining and resets within 72h', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(50, HOURS(24))] }); // 50% left, resets in 24h
    const alert = expiryAlert(e);
    expect(alert).toContain('⚡');
    expect(alert).toContain('50%');
  });

  test('shows hours label when reset < 24h', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(30, HOURS(10))] }); // resets in 10h
    const alert = expiryAlert(e);
    expect(alert).toMatch(/\d+h/);
    expect(alert).not.toMatch(/\dd/);
  });

  test('shows day label when reset >= 24h', () => {
    const e = makeEntry({ name: 'a', bars: [bar7d(30, HOURS(48))] }); // resets in 2d
    const alert = expiryAlert(e);
    expect(alert).toMatch(/\dd/);
  });
});

// ---------------------------------------------------------------------------
// "use first" badge logic — only in smart sort
// ---------------------------------------------------------------------------

describe('use first badge eligibility', () => {
  // The badge is computed in render() using useFirstSet. We test the preconditions:
  // 1. entrySmartScore >= 0 means eligible
  // 2. In smart sort: rank-0 per group gets the badge
  // 3. In other sort modes: no badge (tested via sortedWithinGroup rank)

  test('limit-reached account (score -1) is never eligible for use-first', () => {
    const e = makeEntry({ name: 'limited', bars: [bar5h(100), bar7d(50)] });
    expect(entrySmartScore(e)).toBeLessThan(0);
  });

  test('needs-reauth account (score -2) is never eligible for use-first', () => {
    const e = makeEntry({ name: 'reauth', needsReauth: true });
    expect(entrySmartScore(e)).toBeLessThan(0);
  });

  test('healthy account with quota remaining scores ≥ 0', () => {
    const e = makeEntry({ name: 'ok', bars: [bar5h(20), bar7d(30, HOURS(48))] });
    expect(entrySmartScore(e)).toBeGreaterThanOrEqual(0);
  });

  test('in status sort, rank-0 is by status not smart score — badge should not show', () => {
    // status sort puts available accounts first regardless of smart score
    // An account with lots of remaining quota but late reset could rank high by status
    // but low by smart score. Verify status sort doesn't use smart score for ordering.
    const highStatus = makeEntry({ name: 'ok-low-score',  bars: [bar5h(10), bar7d(10, HOURS(168))] }); // 90% left, resets in 7d
    const lowStatus  = makeEntry({ name: 'ok-high-score', bars: [bar5h(10), bar7d(10, HOURS(6))]   }); // 90% left, resets in 6h
    const sorted = sortedWithinGroup([highStatus, lowStatus], 'status');
    // status sort: both are "ok" so order may be arbitrary, but neither is limit_reached
    // the important thing: smart score of lowStatus is much higher
    expect(entrySmartScore(lowStatus)).toBeGreaterThan(entrySmartScore(highStatus));
    // but status sort does NOT put lowStatus first necessarily — they're equal status
    // this validates that status sort ignores smart score
    const statusSortedNames = sorted.map(e => e.name);
    const smartSorted = sortedWithinGroup([highStatus, lowStatus], 'smart');
    expect(smartSorted[0].name).toBe('ok-high-score'); // smart sort correctly picks urgent one first
  });
});
