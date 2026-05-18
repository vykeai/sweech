/**
 * Regression for the codex bucket-order bug: codex's rate-limit API
 * returns buckets in arbitrary order. SweechBar / dashboard / CLI all
 * read `buckets[0]` and got 0% utilization for accounts where Spark
 * (always 0% on non-Spark plans) was listed first.
 *
 * The fix: every getter routes through pickPrimaryBucket() which
 * always prefers "All models" when present.
 */

import {
  pickPrimaryBucket,
  getSessionUtilization,
  getWeeklyUtilization,
  getSessionResetsAt,
  getWeeklyResetsAt,
} from '../src/liveUsage';

const sparkFirst = {
  status: 'normal',
  buckets: [
    { label: 'GPT-5.3-Codex-Spark', session: { utilization: 0, resetsAt: 100 }, weekly: { utilization: 0, resetsAt: 200 } },
    { label: 'All models',          session: { utilization: 0.34, resetsAt: 300 }, weekly: { utilization: 0.44, resetsAt: 400 } },
  ],
} as any;

const allModelsFirst = {
  status: 'normal',
  buckets: [
    { label: 'All models',          session: { utilization: 0.45, resetsAt: 500 }, weekly: { utilization: 0.79, resetsAt: 600 } },
    { label: 'GPT-5.3-Codex-Spark', session: { utilization: 0, resetsAt: 700 }, weekly: { utilization: 0, resetsAt: 800 } },
  ],
} as any;

const noAllModels = {
  status: 'normal',
  buckets: [
    { label: 'Default', session: { utilization: 0.12 }, weekly: { utilization: 0.21 } },
  ],
} as any;

describe('pickPrimaryBucket', () => {
  test('prefers "All models" when it appears second (codex-pole/codex bug)', () => {
    const pick = pickPrimaryBucket(sparkFirst);
    expect(pick?.label).toBe('All models');
    expect(pick?.session?.utilization).toBe(0.34);
    expect(pick?.weekly?.utilization).toBe(0.44);
  });

  test('prefers "All models" when it appears first (codex-ted)', () => {
    const pick = pickPrimaryBucket(allModelsFirst);
    expect(pick?.label).toBe('All models');
    expect(pick?.session?.utilization).toBe(0.45);
  });

  test('falls back to buckets[0] when no "All models" entry exists', () => {
    const pick = pickPrimaryBucket(noAllModels);
    expect(pick?.label).toBe('Default');
  });

  test('returns undefined for null/empty live data', () => {
    expect(pickPrimaryBucket(null)).toBeUndefined();
    expect(pickPrimaryBucket(undefined)).toBeUndefined();
    expect(pickPrimaryBucket({ status: 'normal', buckets: [] } as any)).toBeUndefined();
  });
});

describe('getter functions route through pickPrimaryBucket', () => {
  test('getSessionUtilization picks All models (non-zero) over Spark (zero)', () => {
    expect(getSessionUtilization(sparkFirst)).toBe(0.34);
    expect(getSessionUtilization(allModelsFirst)).toBe(0.45);
  });

  test('getWeeklyUtilization picks All models over Spark', () => {
    expect(getWeeklyUtilization(sparkFirst)).toBe(0.44);
    expect(getWeeklyUtilization(allModelsFirst)).toBe(0.79);
  });

  test('reset accessors also use All models bucket', () => {
    expect(getSessionResetsAt(sparkFirst)).toBe(300);
    expect(getWeeklyResetsAt(sparkFirst)).toBe(400);
  });
});
