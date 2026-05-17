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
jest.mock('../src/auditLog', () => ({
  readAuditLog: jest.fn(() => []),
  logAudit: jest.fn(),
}));

import {
  accountScore,
  accountReason,
  suggestBestAccount,
  recommendRoute,
  enumerateAccounts,
  getAvailableAccounts,
} from '../src/accountSelector';
import { getAccountInfo, getKnownAccounts } from '../src/subscriptions';
import * as fs from 'fs';
import { getCLI, SUPPORTED_CLIS } from '../src/clis';
import { readAuditLog, logAudit } from '../src/auditLog';
import type { ProjectPinResolved } from '../src/projectConfig';

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

interface LiveOverrides extends Partial<LiveRateLimitData> {
  utilization5h?: number;
  utilization7d?: number;
  reset5hAt?: number;
  reset7dAt?: number;
}

function makeLive(overrides: LiveOverrides = {}): LiveRateLimitData {
  const {
    utilization5h,
    utilization7d,
    reset5hAt,
    reset7dAt,
    buckets,
    ...rest
  } = overrides;

  let allBuckets = buckets;
  if (!allBuckets) {
    const hasWindow = utilization5h !== undefined
      || utilization7d !== undefined
      || reset5hAt !== undefined
      || reset7dAt !== undefined;
    if (hasWindow) {
      allBuckets = [{
        label: 'All models',
        ...(utilization5h !== undefined || reset5hAt !== undefined
          ? { session: { utilization: utilization5h ?? 0, resetsAt: reset5hAt } }
          : {}),
        ...(utilization7d !== undefined || reset7dAt !== undefined
          ? { weekly: { utilization: utilization7d ?? 0, resetsAt: reset7dAt } }
          : {}),
      }];
    } else {
      allBuckets = [];
    }
  }

  return {
    buckets: allBuckets,
    capturedAt: Date.now(),
    ...rest,
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
    (fs.statSync as jest.Mock).mockReturnValue({ mode: 0o755 });
    (readAuditLog as jest.Mock).mockReturnValue([]);
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

// ---------------------------------------------------------------------------
// recommendRoute — machine-readable route contract
// ---------------------------------------------------------------------------

describe('recommendRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.statSync as jest.Mock).mockReturnValue({ mode: 0o755 });
    (readAuditLog as jest.Mock).mockReturnValue([]);
  });

  test('returns selected route with provider, model, account, and capabilities', async () => {
    const profiles = [
      {
        name: 'codex fast',
        commandName: 'codex-fast',
        cliType: 'codex' as const,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];

    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getCLI as jest.Mock).mockReturnValue({
      name: 'codex',
      command: 'codex',
      configDirEnvVar: 'CODEX_HOME',
      resumeFlag: 'resume --last',
      sessionsCommand: ['resume'],
    });
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'codex fast',
        commandName: 'codex-fast',
        cliType: 'codex',
        live: makeLive({ status: 'allowed', utilization7d: 0.3 }),
        hoursUntilWeeklyReset: 24,
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const result = await recommendRoute({
      taskType: 'api',
      repo: '/Users/luke/dev/coding-hq',
      requiredCapabilities: ['coding', 'provider:openai'],
      cliType: 'codex',
    }, profiles as any);

    expect(result.schemaVersion).toBe('sweech.route-recommendation.v1');
    expect(result.selected).toBeDefined();
    expect(result.selected!.route).toMatchObject({
      commandName: 'codex-fast',
      cliType: 'codex',
      provider: 'openai',
      model: 'gpt-5.4-mini',
    });
    expect(result.selected!.capabilities).toContain('coding');
    expect(result.selected!.capabilities).toContain('provider:openai');
    expect(result.selected!.capabilities).toContain('launch:sweech-wrapper');
    expect(result.selected!.route.launch).toMatchObject({
      mode: 'sweech-wrapper',
      status: 'available',
      wrapperRequired: true,
      nativeProfileUsable: false,
      failureClass: null,
    });
    expect(result.selected!.route.launch.command).toContain('/.sweech/bin/codex-fast');
    expect(result.selected!.route.launchCommand).toBe(result.selected!.route.launch.command);
    expect(result.selected!.route.health).toMatchObject({
      status: 'healthy',
      checkMode: 'cache-only',
      failureClass: null,
      checks: {
        launch: 'pass',
        auth: 'pass',
        quota: 'pass',
        capability: 'pass',
      },
    });
    expect(result.selected!.route.quota).toMatchObject({
      source: 'live-cache',
      status: 'allowed',
      messages5h: 0,
      messages7d: 0,
      totalMessages: 0,
      utilization7d: 0.3,
    });
    expect(result.selected!.route.metadata).toMatchObject({
      providerKey: 'openai',
      providerDisplayName: 'OpenAI',
      apiFormat: 'openai',
      supportedEngines: ['codex'],
      activeEngine: 'codex',
      toolUseMode: 'native-agent-cli',
      sessionSupport: {
        resume: true,
        list: true,
        named: false,
        resumeCommand: 'resume --last',
      },
      context: {
        model: 'gpt-5.4-mini',
        window: null,
        tokens: null,
        source: 'unknown',
      },
      costQuotaHints: {
        pricing: 'ChatGPT Plus/Pro subscription',
        quotaSource: 'live-cache',
        planType: null,
        planLabel: null,
      },
      headless: {
        suitable: true,
      },
      taskSuitability: {
        review: true,
        edit: true,
        proof: true,
        longRunningSupervision: true,
      },
      unsupportedCapabilities: [],
    });
    expect(result.rejected).toHaveLength(0);
  });

  test('returns rejected alternatives with reasons', async () => {
    const profiles = [
      { name: 'good', commandName: 'claude-good', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
      { name: 'limited', commandName: 'claude-limited', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
      { name: 'codex', commandName: 'codex-main', cliType: 'codex' as const, provider: 'openai', createdAt: '2025-01-01T00:00:00Z' },
    ];

    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getCLI as jest.Mock).mockReturnValue({
      name: 'claude',
      command: 'claude',
      configDirEnvVar: 'CLAUDE_CONFIG_DIR',
      resumeFlag: '--continue',
      sessionsCommand: ['--resume'],
      sessionNameFlag: '--name',
    });
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'good',
        commandName: 'claude-good',
        cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.4 }),
      }),
      makeAccountInfo({
        name: 'limited',
        commandName: 'claude-limited',
        cliType: 'claude',
        live: makeLive({ status: 'limit_reached', utilization7d: 0.9 }),
      }),
      makeAccountInfo({
        name: 'codex',
        commandName: 'codex-main',
        cliType: 'codex',
        live: makeLive({ status: 'allowed', utilization7d: 0.8 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const result = await recommendRoute({
      cliType: 'claude',
      requiredCapabilities: ['provider:anthropic'],
    }, profiles as any);

    expect(result.selected!.route.commandName).toBe('claude-good');
    const limited = result.rejected.find(candidate => candidate.route.commandName === 'claude-limited');
    const codex = result.rejected.find(candidate => candidate.route.commandName === 'codex-main');
    expect(limited!.reasons).toContain('availability:limit_reached');
    expect(limited!.route.health).toMatchObject({
      status: 'unavailable',
      failureClass: 'quota-exhausted',
      checks: {
        launch: 'pass',
        auth: 'pass',
        quota: 'fail',
        capability: 'pass',
      },
    });
    expect(limited!.route.quota).toMatchObject({
      source: 'live-cache',
      status: 'limit_reached',
      utilization7d: 0.9,
    });
    expect(codex!.reasons).toContain('cli-type-mismatch:codex');
    expect(codex!.reasons).toContain('missing-capability:provider:anthropic');
    expect(codex!.route.health.failureClass).toBe('unsupported-capability');
  });

  test('rejects wrapper-only managed profiles when the wrapper is missing', async () => {
    const profiles = [
      {
        name: 'codex missing',
        commandName: 'codex-missing',
        cliType: 'codex' as const,
        provider: 'openai',
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];

    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'codex missing',
        commandName: 'codex-missing',
        cliType: 'codex',
        live: makeLive({ status: 'allowed', utilization7d: 0.2 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockImplementation((value: string) => (
      value.endsWith('/.codex-missing')
    ));

    const result = await recommendRoute({
      preferredProfile: 'codex-missing',
    }, profiles as any);

    expect(result.selected).toBeNull();
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reasons).toContain('route-unavailable:missing-wrapper');
    expect(result.rejected[0].route.launch).toMatchObject({
      mode: 'sweech-wrapper',
      status: 'route-unavailable',
      wrapperRequired: true,
      nativeProfileUsable: false,
      failureClass: 'missing-wrapper',
      installGuidance: 'Run: sweech repair codex-missing',
    });
    expect(result.rejected[0].route.health).toMatchObject({
      status: 'unavailable',
      failureClass: 'missing-wrapper',
      checks: {
        launch: 'fail',
        auth: 'pass',
        quota: 'pass',
        capability: 'pass',
      },
    });
  });

  test('reports sanitized last failure metadata from audit log', async () => {
    const profiles = [
      {
        name: 'codex failed',
        commandName: 'codex-failed',
        cliType: 'codex' as const,
        provider: 'openai',
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];

    (readAuditLog as jest.Mock).mockReturnValue([
      {
        timestamp: '2026-05-15T12:00:00.000Z',
        action: 'route_failure',
        account: 'codex-failed',
        details: {
          failureClass: 'auth-required',
          error: 'API error 401 with sk-ant-api03-BADKEY123456789012345678901234',
        },
      },
    ]);
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'codex failed',
        commandName: 'codex-failed',
        cliType: 'codex',
        live: makeLive({ status: 'allowed', utilization7d: 0.2 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const result = await recommendRoute({ preferredProfile: 'codex-failed' }, profiles as any);

    expect(result.selected!.route.lastFailure).toMatchObject({
      at: '2026-05-15T12:00:00.000Z',
      action: 'route_failure',
      failureClass: 'auth-required',
    });
    expect(result.selected!.route.lastFailure!.message).toContain('[REDACTED]');
    expect(result.selected!.route.lastFailure!.message).not.toContain('sk-ant');
  });

  test('returns explicit unsupported capability reasons for unsuitable provider tasks', async () => {
    const profiles = [
      {
        name: 'deepseek',
        commandName: 'claude-deepseek',
        cliType: 'claude' as const,
        provider: 'deepseek',
        model: 'deepseek-chat',
        createdAt: '2025-01-01T00:00:00Z',
      },
    ];

    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'deepseek',
        commandName: 'claude-deepseek',
        cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.2 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const result = await recommendRoute({
      preferredProfile: 'claude-deepseek',
      requiredCapabilities: ['task:proof'],
    }, profiles as any);

    expect(result.selected).toBeNull();
    expect(result.rejected[0].reasons).toContain('missing-capability:task:proof');
    expect(result.rejected[0].route.health.failureClass).toBe('unsupported-capability');
    expect(result.rejected[0].route.metadata).toMatchObject({
      providerKey: 'deepseek',
      supportedEngines: ['claude'],
      activeEngine: 'claude',
      apiFormat: 'anthropic',
      context: {
        model: 'deepseek-chat',
        window: '128k',
        tokens: 128000,
        source: 'model-catalog',
      },
      taskSuitability: {
        review: true,
        edit: true,
        proof: false,
        longRunningSupervision: true,
      },
      unsupportedCapabilities: ['task:proof'],
    });
  });

  test('exposes native launch metadata for default CLI accounts', async () => {
    (SUPPORTED_CLIS as Record<string, any>).codex = {
      name: 'codex',
      command: 'codex',
      configDirEnvVar: 'CODEX_HOME',
    };
    (getCLI as jest.Mock).mockReturnValue({
      name: 'codex',
      command: 'codex',
      configDirEnvVar: 'CODEX_HOME',
    });

    (getKnownAccounts as jest.Mock).mockReturnValue([{
      name: 'codex',
      commandName: 'codex',
      cliType: 'codex',
      isDefault: true,
    }]);
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'codex',
        commandName: 'codex',
        cliType: 'codex',
        live: makeLive({ status: 'allowed', utilization7d: 0.1 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const result = await recommendRoute({ preferredProfile: 'codex' }, [] as any);

    expect(result.selected!.route.launch).toMatchObject({
      mode: 'native-cli-profile',
      status: 'available',
      command: 'codex',
      args: [],
      env: { CODEX_HOME: expect.stringContaining('/.codex') },
      wrapperRequired: false,
      wrapperPath: null,
      nativeProfileUsable: true,
      failureClass: null,
      installGuidance: null,
    });
    expect(result.selected!.capabilities).toContain('launch:native-cli-profile');
  });
});

// ---------------------------------------------------------------------------
// T-LU-009: project-pin integration with recommendRoute / suggestBestAccount
// ---------------------------------------------------------------------------

function makeResolvedPin(pin: ProjectPinResolved['pin']): ProjectPinResolved {
  return {
    pin,
    source: '/tmp/test-project/.sweech.json',
    projectRoot: '/tmp/test-project',
  };
}

describe('recommendRoute with projectPin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.statSync as jest.Mock).mockReturnValue({ mode: 0o755 });
    (readAuditLog as jest.Mock).mockReturnValue([]);
    (logAudit as jest.Mock).mockClear();
  });

  test('echoes pinApplied back on the response', async () => {
    const profiles = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'a', commandName: 'claude-a', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.2 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const pin = makeResolvedPin({ profile: 'claude-a' });
    const result = await recommendRoute({}, profiles as any, pin);

    expect(result.pinApplied).toEqual(pin);
    expect(result.selected!.route.commandName).toBe('claude-a');
  });

  test('pin.cliType overrides the request cliType', async () => {
    const profiles = [
      { name: 'c', commandName: 'claude-c', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
      { name: 'd', commandName: 'codex-d', cliType: 'codex' as const, provider: 'openai', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'c', commandName: 'claude-c', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.3 }),
      }),
      makeAccountInfo({
        name: 'd', commandName: 'codex-d', cliType: 'codex',
        live: makeLive({ status: 'allowed', utilization7d: 0.9 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    // Request asks for codex, pin says claude — pin wins.
    const pin = makeResolvedPin({ cliType: 'claude' });
    const result = await recommendRoute({ cliType: 'codex' }, profiles as any, pin);

    expect(result.selected!.route.cliType).toBe('claude');
    expect(result.selected!.route.commandName).toBe('claude-c');
  });

  test('pin.profile becomes preferredProfile (caller override wins)', async () => {
    const profiles = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
      { name: 'b', commandName: 'claude-b', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'a', commandName: 'claude-a', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.4 }),
      }),
      makeAccountInfo({
        name: 'b', commandName: 'claude-b', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.1 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    // Caller passed preferredProfile=claude-b — pin's profile=claude-a is overridden.
    const pin = makeResolvedPin({ profile: 'claude-a' });
    const result = await recommendRoute(
      { preferredProfile: 'claude-b' },
      profiles as any,
      pin,
    );
    // Caller wins: preferredProfile=claude-b => only claude-b is unrejected.
    expect(result.selected!.route.commandName).toBe('claude-b');
  });

  test('pin with profile that does not exist falls through to ranking (warn)', async () => {
    const profiles = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'a', commandName: 'claude-a', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.3 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const pin = makeResolvedPin({ profile: 'ghost-profile' });
    const result = await recommendRoute({}, profiles as any, pin);

    // The pin's profile doesn't match → preferredProfile filter rejects claude-a → selected is null.
    // Then the stderr warning informs the user.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("'ghost-profile'"));
    errSpy.mockRestore();
  });

  test('pin.maxTier filters out candidates whose tier exceeds the cap', async () => {
    const profiles = [
      { name: 'pro', commandName: 'claude-pro', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
      { name: 'max', commandName: 'claude-max', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'pro', commandName: 'claude-pro', cliType: 'claude',
        rateLimitTier: 'pro',
        live: makeLive({ status: 'allowed', utilization7d: 0.5 }),
      }),
      makeAccountInfo({
        name: 'max', commandName: 'claude-max', cliType: 'claude',
        rateLimitTier: 'default_claude_max_20x',
        live: makeLive({ status: 'allowed', utilization7d: 0.5 }),
        hoursUntilWeeklyReset: 1, // would otherwise win
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    // Cap at pro — claude-max should get the pin-max-tier-exceeded reason.
    const pin = makeResolvedPin({ maxTier: 'pro' });
    const result = await recommendRoute({}, profiles as any, pin);

    const maxCandidate = result.candidates.find(c => c.route.commandName === 'claude-max');
    expect(maxCandidate!.reasons.some(r => r.startsWith('pin-max-tier-exceeded'))).toBe(true);
    // pro candidate is the selected one.
    expect(result.selected!.route.commandName).toBe('claude-pro');
  });

  test('writes an audit log entry when a pin is applied and a route is selected', async () => {
    const profiles = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'a', commandName: 'claude-a', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.2 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const pin = makeResolvedPin({ profile: 'claude-a', cliType: 'claude' });
    await recommendRoute({}, profiles as any, pin);

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'route_pin_applied',
      account: 'claude-a',
      details: expect.objectContaining({
        source: pin.source,
        projectRoot: pin.projectRoot,
        pin: pin.pin,
      }),
    }));
  });

  test('does NOT write an audit entry when no pin is applied', async () => {
    const profiles = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'a', commandName: 'claude-a', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.2 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    await recommendRoute({}, profiles as any);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('pinApplied is null when no pin is passed', async () => {
    (getKnownAccounts as jest.Mock).mockReturnValue([]);
    (getAccountInfo as jest.Mock).mockResolvedValue([]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const result = await recommendRoute({}, [] as any);
    expect(result.pinApplied).toBeNull();
  });

  test('pin.model becomes preferredModel hint', async () => {
    const profiles = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude' as const, provider: 'anthropic', model: 'claude-opus-4-7', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'a', commandName: 'claude-a', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.2 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const pin = makeResolvedPin({ model: 'claude-opus-4-7' });
    const result = await recommendRoute({}, profiles as any, pin);
    // Score is bumped by 20 for preferred-model match (see requestedTaskBonus).
    // We can verify the merge happened by checking the request echo.
    expect(result.request.preferredModel).toBe('claude-opus-4-7');
  });
});

describe('suggestBestAccount with projectPin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.statSync as jest.Mock).mockReturnValue({ mode: 0o755 });
    (readAuditLog as jest.Mock).mockReturnValue([]);
    (logAudit as jest.Mock).mockClear();
  });

  test('echoes pinApplied on the AccountRecommendation', async () => {
    const profiles = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'a', commandName: 'claude-a', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.2 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const pin = makeResolvedPin({ profile: 'claude-a' });
    const result = await suggestBestAccount(undefined, profiles as any, pin);

    expect(result).toBeDefined();
    expect(result!.pinApplied).toEqual(pin);
    expect(result!.account.commandName).toBe('claude-a');
  });

  test('returns undefined when pinned profile is missing and only profile asked', async () => {
    const profiles = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude' as const, provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' },
    ];
    (getKnownAccounts as jest.Mock).mockReturnValue(profiles.map(p => ({ ...p, isDefault: false })));
    (getAccountInfo as jest.Mock).mockResolvedValue([
      makeAccountInfo({
        name: 'a', commandName: 'claude-a', cliType: 'claude',
        live: makeLive({ status: 'allowed', utilization7d: 0.2 }),
      }),
    ]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const pin = makeResolvedPin({ profile: 'ghost-profile' });
    const result = await suggestBestAccount(undefined, profiles as any, pin);
    // Pin says ghost-profile, no candidate matches preferredProfile=ghost-profile → unselected.
    expect(result).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("'ghost-profile'"));
    errSpy.mockRestore();
  });
});
