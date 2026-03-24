/**
 * Tests for account scoring and recommendation (src/accountSelector.ts).
 */

import type { AccountInfo } from '../src/subscriptions';
import type { LiveRateLimitData } from '../src/liveUsage';

// Mock external dependencies before importing the module under test
jest.mock('fs');
jest.mock('child_process');
jest.mock('../src/config', () => ({
  ConfigManager: jest.fn().mockImplementation(() => ({
    getProfiles: jest.fn(() => []),
  })),
}));
jest.mock('../src/clis', () => ({
  SUPPORTED_CLIS: {},
  getCLI: jest.fn(),
}));
jest.mock('../src/subscriptions', () => ({
  getAccountInfo: jest.fn(async () => []),
  getKnownAccounts: jest.fn(() => []),
}));

import {
  accountScore,
  accountReason,
  suggestBestAccount,
  enumerateAccounts,
  getAvailableAccounts,
  type AccountEntry,
} from '../src/accountSelector';
import { getAccountInfo, getKnownAccounts } from '../src/subscriptions';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccountInfo(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    name: 'test',
    commandName: 'claude-test',
    cliType: 'claude',
    configDir: '/home/.claude-test',
    meta: {},
    messages5h: 0,
    messages7d: 0,
    totalMessages: 0,
    ...overrides,
  };
}

function makeLive(overrides: Partial<LiveRateLimitData> = {}): LiveRateLimitData {
  return {
    buckets: [],
    capturedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// accountScore
// ---------------------------------------------------------------------------

describe('accountScore', () => {
  test('returns -Infinity for rejected status', () => {
    const info = makeAccountInfo({ live: makeLive({ status: 'rejected' }) });
    expect(accountScore(info)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('returns -Infinity for limit_reached status', () => {
    const info = makeAccountInfo({ live: makeLive({ status: 'limit_reached' }) });
    expect(accountScore(info)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('allowed status returns a finite score', () => {
    const info = makeAccountInfo({
      live: makeLive({ status: 'allowed', utilization7d: 0.5, utilization5h: 0.3 }),
      hoursUntilWeeklyReset: 48,
    });
    const score = accountScore(info);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });

  test('no live data yields score based on defaults (zero utilization)', () => {
    const info = makeAccountInfo();
    const score = accountScore(info);
    // weeklyUtil=0, sessionUtil=0, resetHours=24*365, capacityPenalty=0
    // score = 0 + 0 + (1/(24*365))*50 - 0 ≈ 0.0057
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  test('higher weekly utilization increases score', () => {
    const low = makeAccountInfo({
      live: makeLive({ utilization7d: 0.2, utilization5h: 0 }),
      hoursUntilWeeklyReset: 48,
    });
    const high = makeAccountInfo({
      live: makeLive({ utilization7d: 0.8, utilization5h: 0 }),
      hoursUntilWeeklyReset: 48,
    });
    expect(accountScore(high)).toBeGreaterThan(accountScore(low));
  });

  test('higher session utilization increases score', () => {
    const low = makeAccountInfo({
      live: makeLive({ utilization7d: 0.5, utilization5h: 0.1 }),
      hoursUntilWeeklyReset: 48,
    });
    const high = makeAccountInfo({
      live: makeLive({ utilization7d: 0.5, utilization5h: 0.9 }),
      hoursUntilWeeklyReset: 48,
    });
    expect(accountScore(high)).toBeGreaterThan(accountScore(low));
  });

  test('sooner weekly reset increases score (higher urgency)', () => {
    const soon = makeAccountInfo({
      live: makeLive({ utilization7d: 0.5, utilization5h: 0.3 }),
      hoursUntilWeeklyReset: 6,
    });
    const late = makeAccountInfo({
      live: makeLive({ utilization7d: 0.5, utilization5h: 0.3 }),
      hoursUntilWeeklyReset: 120,
    });
    expect(accountScore(soon)).toBeGreaterThan(accountScore(late));
  });

  test('zero hoursUntilWeeklyReset gives maximum urgency', () => {
    const info = makeAccountInfo({
      live: makeLive({ utilization7d: 0.5, utilization5h: 0 }),
      hoursUntilWeeklyReset: 0,
    });
    // resetUrgency = 10 when resetHours <= 0
    const score = accountScore(info);
    // 0.5*100 + 0 + 10*50 - 0 = 550
    expect(score).toBe(550);
  });

  test('capacity penalty reduces score when minutes > 0', () => {
    const noPenalty = makeAccountInfo({
      live: makeLive({ utilization7d: 0.5, utilization5h: 0 }),
      hoursUntilWeeklyReset: 48,
      minutesUntilFirstCapacity: 0,
    });
    const withPenalty = makeAccountInfo({
      live: makeLive({ utilization7d: 0.5, utilization5h: 0 }),
      hoursUntilWeeklyReset: 48,
      minutesUntilFirstCapacity: 300,
    });
    expect(accountScore(withPenalty)).toBeLessThan(accountScore(noPenalty));
  });

  test('capacity penalty is capped at 1.0 (minutes/600)', () => {
    const moderate = makeAccountInfo({
      live: makeLive({ utilization7d: 0, utilization5h: 0 }),
      hoursUntilWeeklyReset: 48,
      minutesUntilFirstCapacity: 600,
    });
    const extreme = makeAccountInfo({
      live: makeLive({ utilization7d: 0, utilization5h: 0 }),
      hoursUntilWeeklyReset: 48,
      minutesUntilFirstCapacity: 6000,
    });
    // Both should have capacityPenalty capped at 1.0 → same score
    expect(accountScore(moderate)).toBe(accountScore(extreme));
  });
});

// ---------------------------------------------------------------------------
// accountReason
// ---------------------------------------------------------------------------

describe('accountReason', () => {
  test('returns "fallback order" when no live data', () => {
    const info = makeAccountInfo();
    expect(accountReason(info)).toBe('fallback order');
  });

  test('includes status when present', () => {
    const info = makeAccountInfo({ live: makeLive({ status: 'allowed' }) });
    expect(accountReason(info)).toContain('status=allowed');
  });

  test('includes weekly reset hours', () => {
    const info = makeAccountInfo({ hoursUntilWeeklyReset: 12.5 });
    expect(accountReason(info)).toContain('weekly-reset=12.5h');
  });

  test('includes 7d utilization as percentage', () => {
    const info = makeAccountInfo({ live: makeLive({ utilization7d: 0.73 }) });
    expect(accountReason(info)).toContain('7d=73%');
  });

  test('includes 5h utilization as percentage', () => {
    const info = makeAccountInfo({ live: makeLive({ utilization5h: 0.456 }) });
    expect(accountReason(info)).toContain('5h=46%');
  });

  test('combines all pieces with comma separator', () => {
    const info = makeAccountInfo({
      hoursUntilWeeklyReset: 24,
      live: makeLive({ status: 'allowed', utilization7d: 0.5, utilization5h: 0.2 }),
    });
    const reason = accountReason(info);
    expect(reason).toBe('status=allowed, weekly-reset=24.0h, 7d=50%, 5h=20%');
  });
});

// ---------------------------------------------------------------------------
// suggestBestAccount — integration with mocked dependencies
// ---------------------------------------------------------------------------

describe('suggestBestAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns undefined when no accounts available', async () => {
    (getKnownAccounts as jest.Mock).mockReturnValue([]);
    (getAccountInfo as jest.Mock).mockResolvedValue([]);
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    const result = await suggestBestAccount(undefined, []);
    expect(result).toBeUndefined();
  });

  test('returns undefined when infos exist but no matching available accounts', async () => {
    (getKnownAccounts as jest.Mock).mockReturnValue([
      { name: 'ghost', commandName: 'ghost', cliType: 'claude' },
    ]);
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({ commandName: 'ghost', live: makeLive({ utilization7d: 0.5 }) }),
    ]);
    // No config dir exists on disk
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    const result = await suggestBestAccount(undefined, []);
    expect(result).toBeUndefined();
  });

  test('returns the highest scoring account', async () => {
    const profiles = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude' as const },
      { name: 'b', commandName: 'claude-b', cliType: 'claude' as const },
    ];

    (getKnownAccounts as jest.Mock).mockReturnValue(
      profiles.map(p => ({ ...p, isDefault: false })),
    );
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'a',
        commandName: 'claude-a',
        cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.8, utilization5h: 0 }),
        hoursUntilWeeklyReset: 6,
      }),
      makeAccountInfo({
        name: 'b',
        commandName: 'claude-b',
        cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.2, utilization5h: 0 }),
        hoursUntilWeeklyReset: 120,
      }),
    ]);
    // Both config dirs exist
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const result = await suggestBestAccount(undefined, profiles as any);
    expect(result).toBeDefined();
    expect(result!.account.commandName).toBe('claude-a');
    expect(result!.score).toBeGreaterThan(0);
    expect(result!.reason).toContain('status=allowed');
  });

  test('filters by cliType when provided', async () => {
    const profiles = [
      { name: 'c', commandName: 'claude-c', cliType: 'claude' as const },
      { name: 'd', commandName: 'codex-d', cliType: 'codex' as const },
    ];

    (getKnownAccounts as jest.Mock).mockReturnValue(
      profiles.map(p => ({ ...p, isDefault: false })),
    );
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'c',
        commandName: 'claude-c',
        cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.3 }),
        hoursUntilWeeklyReset: 48,
      }),
      makeAccountInfo({
        name: 'd',
        commandName: 'codex-d',
        cliType: 'codex',
        live: makeLive({ status: 'allowed', utilization7d: 0.9 }),
        hoursUntilWeeklyReset: 6,
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    // Request only codex accounts
    const result = await suggestBestAccount('codex', profiles as any);
    expect(result).toBeDefined();
    expect(result!.account.cliType).toBe('codex');
  });

  test('excludes rejected accounts from recommendation', async () => {
    const profiles = [
      { name: 'good', commandName: 'claude-good', cliType: 'claude' as const },
      { name: 'bad', commandName: 'claude-bad', cliType: 'claude' as const },
    ];

    (getKnownAccounts as jest.Mock).mockReturnValue(
      profiles.map(p => ({ ...p, isDefault: false })),
    );
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'good',
        commandName: 'claude-good',
        cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.1 }),
        hoursUntilWeeklyReset: 100,
      }),
      makeAccountInfo({
        name: 'bad',
        commandName: 'claude-bad',
        cliType: 'claude',
        live: makeLive({ status: 'rejected' }),
        hoursUntilWeeklyReset: 1,
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const result = await suggestBestAccount(undefined, profiles as any);
    expect(result).toBeDefined();
    // The rejected account should score -Infinity, so good wins
    expect(result!.account.commandName).toBe('claude-good');
  });
});
