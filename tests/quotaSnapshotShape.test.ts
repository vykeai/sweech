/**
 * T-057: locks the canonical QuotaSnapshot shape exposed via
 * `sweech usage --json` / `sweech list --json`.
 *
 * SwiftBar, the engine, widgets, and external scripts all consume this
 * exact shape. The deprecated mirror fields
 * (utilization5h / utilization7d / utilizationSonnet7d / reset5hAt / reset7dAt)
 * have been dropped; only the bucket form remains.
 */

import * as fs from 'fs';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

jest.mock('child_process', () => ({
  execSync: jest.fn().mockImplementation(() => { throw new Error('no keychain'); }),
  execFileSync: jest.fn().mockImplementation(() => { throw new Error('no keychain'); }),
  spawn: jest.fn(),
}));

(global as any).fetch = jest.fn();

import { getLiveUsage, LiveRateLimitData } from '../src/liveUsage';

describe('JSON contract — canonical QuotaSnapshot shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('LiveRateLimitData exposes bucket-only utilization (no legacy mirror fields)', async () => {
    const cached: LiveRateLimitData = {
      buckets: [
        {
          label: 'All models',
          session: { utilization: 0.3, resetsAt: Date.now() / 1000 + 3600 },
          weekly:  { utilization: 0.5, resetsAt: Date.now() / 1000 + 7 * 86400 },
        },
      ],
      status: 'allowed',
      capturedAt: Date.now() - 60_000,
    };
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ '/mock/.claude': cached }));

    const result = await getLiveUsage('/mock/.claude');
    expect(result).toBeDefined();

    // Canonical shape — buckets[0].session/weekly is the source of truth
    expect(result!.buckets?.[0]?.session?.utilization).toBe(0.3);
    expect(result!.buckets?.[0]?.weekly?.utilization).toBe(0.5);

    // Legacy mirror fields removed (T-057)
    const payload = result as unknown as Record<string, unknown>;
    expect(payload).not.toHaveProperty('utilization5h');
    expect(payload).not.toHaveProperty('utilization7d');
    expect(payload).not.toHaveProperty('utilizationSonnet7d');
    expect(payload).not.toHaveProperty('reset5hAt');
    expect(payload).not.toHaveProperty('reset7dAt');
  });

  test('LiveRateLimitData TypeScript type forbids legacy mirror fields', () => {
    // This is a compile-time assertion — if any of the legacy fields
    // come back as a typed property, this test won't compile and the
    // jest run will fail at tsc. Pure type-level check.
    const sample: LiveRateLimitData = {
      buckets: [],
      capturedAt: 0,
    };

    // @ts-expect-error — utilization5h is no longer on the type
    sample.utilization5h;
    // @ts-expect-error — utilization7d is no longer on the type
    sample.utilization7d;
    // @ts-expect-error — utilizationSonnet7d is no longer on the type
    sample.utilizationSonnet7d;
    // @ts-expect-error — reset5hAt is no longer on the type
    sample.reset5hAt;
    // @ts-expect-error — reset7dAt is no longer on the type
    sample.reset7dAt;

    expect(sample.buckets).toEqual([]);
  });
});
