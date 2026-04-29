import { describe, it, expect, afterEach, vi } from 'vitest';
import { QuotaTracker } from '../../daemon/quota.js';
import type { Estate } from '../../estate.js';
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeEstate(overrides?: Partial<Record<string, unknown>>): Estate {
  return {
    version: 1,
    accounts: {
      'free-acct': {
        provider: 'openai',
        engine: 'gpt-4o',
        type: 'free-tier',
        quota: { period: 'daily', limit: 5 },
      },
      'sub-acct': {
        provider: 'anthropic',
        engine: 'claude-sonnet',
        type: 'subscription',
        quota: { period: 'monthly', softLimit: 100 },
      },
      'api-acct': {
        provider: 'openai',
        engine: 'gpt-4o',
        type: 'api-key',
        apiKeyEnv: 'OPENAI_API_KEY',
        quota: { period: 'monthly', limit: 50 },
      },
      'no-quota': {
        provider: 'local',
        engine: 'llama',
        type: 'api-key',
      },
    },
    failoverOrder: ['sub-acct', 'api-acct', 'free-acct'],
  };
}

function tmpStatePath(): string {
  return join(tmpdir(), `omnai-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('QuotaTracker', () => {
  const trackers: QuotaTracker[] = [];

  function createTracker(estate?: Estate, statePath?: string, now?: () => Date): QuotaTracker {
    const t = new QuotaTracker(estate ?? makeEstate(), statePath ?? tmpStatePath(), { now });
    trackers.push(t);
    return t;
  }

  afterEach(() => {
    for (const t of trackers) t.destroy();
    trackers.length = 0;
  });

  it('canUse returns true when under limit', () => {
    const tracker = createTracker();
    expect(tracker.canUse('free-acct')).toBe(true);
  });

  it('canUse returns false when free-tier limit exceeded', () => {
    const tracker = createTracker();
    for (let i = 0; i < 5; i++) {
      tracker.recordUsage('free-acct', 100, 0.01);
    }
    expect(tracker.canUse('free-acct')).toBe(false);
  });

  it('canUse returns false when api-key cost limit exceeded', () => {
    const tracker = createTracker();
    tracker.recordUsage('api-acct', 10000, 51);
    expect(tracker.canUse('api-acct')).toBe(false);
  });

  it('canUse returns true for api-key under cost limit', () => {
    const tracker = createTracker();
    tracker.recordUsage('api-acct', 10000, 10);
    expect(tracker.canUse('api-acct')).toBe(true);
  });

  it('subscription accounts always canUse (soft limit)', () => {
    const tracker = createTracker();
    for (let i = 0; i < 200; i++) {
      tracker.recordUsage('sub-acct', 1000, 1);
    }
    expect(tracker.canUse('sub-acct')).toBe(true);
  });

  it('canUse returns true for accounts with no quota', () => {
    const tracker = createTracker();
    tracker.recordUsage('no-quota', 5000, 100);
    expect(tracker.canUse('no-quota')).toBe(true);
  });

  it('canUse returns false for unknown accounts', () => {
    const tracker = createTracker();
    expect(tracker.canUse('nonexistent')).toBe(false);
  });

  it('recordUsage increments counters', () => {
    const tracker = createTracker();
    tracker.recordUsage('free-acct', 100, 0.01);
    tracker.recordUsage('free-acct', 200, 0.02);
    const state = tracker.getState();
    expect(state.accounts['free-acct'].requestCount).toBe(2);
    expect(state.accounts['free-acct'].tokenCount).toBe(300);
    expect(state.accounts['free-acct'].costUsd).toBeCloseTo(0.03);
  });

  it('period reset works when time advances past boundary', () => {
    const monday = new Date('2026-03-09T10:00:00Z');
    const nextMonday = new Date('2026-03-16T10:00:00Z');
    let currentTime = monday;

    const estate: Estate = {
      version: 1,
      accounts: {
        weekly: {
          provider: 'openai',
          engine: 'gpt-4o',
          type: 'free-tier',
          quota: { period: 'weekly', limit: 3 },
        },
      },
      failoverOrder: ['weekly'],
    };

    const tracker = createTracker(estate, undefined, () => currentTime);
    tracker.recordUsage('weekly', 100, 0.01);
    tracker.recordUsage('weekly', 100, 0.01);
    tracker.recordUsage('weekly', 100, 0.01);
    expect(tracker.canUse('weekly')).toBe(false);

    currentTime = nextMonday;
    expect(tracker.canUse('weekly')).toBe(true);
    const state = tracker.getState();
    expect(state.accounts['weekly'].requestCount).toBe(0);
  });

  it('monthly period reset works', () => {
    const jan15 = new Date('2026-01-15T10:00:00Z');
    const feb1 = new Date('2026-02-01T00:00:00Z');
    let currentTime = jan15;

    const estate: Estate = {
      version: 1,
      accounts: {
        m: {
          provider: 'openai',
          engine: 'gpt-4o',
          type: 'free-tier',
          quota: { period: 'monthly', limit: 2 },
        },
      },
      failoverOrder: ['m'],
    };

    const tracker = createTracker(estate, undefined, () => currentTime);
    tracker.recordUsage('m', 100, 0.01);
    tracker.recordUsage('m', 100, 0.01);
    expect(tracker.canUse('m')).toBe(false);

    currentTime = feb1;
    expect(tracker.canUse('m')).toBe(true);
  });

  it('flush and load round-trips state', async () => {
    const path = tmpStatePath();
    const tracker = createTracker(undefined, path);
    tracker.recordUsage('free-acct', 150, 0.05);
    tracker.recordUsage('sub-acct', 300, 0.10);
    await tracker.flush();

    const tracker2 = createTracker(undefined, path);
    await tracker2.load();
    const state = tracker2.getState();
    expect(state.accounts['free-acct'].requestCount).toBe(1);
    expect(state.accounts['free-acct'].tokenCount).toBe(150);
    expect(state.accounts['sub-acct'].costUsd).toBeCloseTo(0.10);

    await rm(path, { force: true });
  });

  it('load handles missing file gracefully', async () => {
    const tracker = createTracker(undefined, '/tmp/omnai-nonexistent-file.json');
    await tracker.load();
    expect(tracker.getState().accounts).toEqual({});
  });

  it('getAccountStatus returns correct utilization percentage for free-tier', () => {
    const tracker = createTracker();
    tracker.recordUsage('free-acct', 100, 0.01);
    tracker.recordUsage('free-acct', 100, 0.01);
    const status = tracker.getAccountStatus('free-acct');
    expect(status.canUse).toBe(true);
    expect(status.usage.requestCount).toBe(2);
    expect(status.quota).toEqual({ period: 'daily', limit: 5 });
    expect(status.utilizationPct).toBeCloseTo(40);
  });

  it('getAccountStatus returns correct utilization for api-key (cost-based)', () => {
    const tracker = createTracker();
    tracker.recordUsage('api-acct', 5000, 25);
    const status = tracker.getAccountStatus('api-acct');
    expect(status.canUse).toBe(true);
    expect(status.utilizationPct).toBeCloseTo(50);
  });

  it('getAccountStatus returns no utilization when no quota defined', () => {
    const tracker = createTracker();
    const status = tracker.getAccountStatus('no-quota');
    expect(status.canUse).toBe(true);
    expect(status.utilizationPct).toBeUndefined();
    expect(status.quota).toBeUndefined();
  });
});
