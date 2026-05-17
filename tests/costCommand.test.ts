/**
 * Tests for src/costCommand.ts — pure builders used by `sweech cost`.
 *
 * Heavy deps (ConfigManager, recommendRoute, enumerateAccounts,
 * readAuditLog) are mocked so the table/JSON shape and filter logic
 * can be exercised without touching disk or the rate-limit cache.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RouteCandidate } from '../src/accountSelector';

jest.mock('../src/accountSelector', () => ({
  enumerateAccounts: jest.fn(),
  recommendRoute: jest.fn(),
}));
jest.mock('../src/config', () => ({
  ConfigManager: jest.fn().mockImplementation(() => ({
    getProfiles: jest.fn(() => []),
  })),
}));
jest.mock('../src/auditLog', () => ({
  readAuditLog: jest.fn(() => []),
}));

import {
  buildRowFromCandidate,
  applyFilters,
  buildCostTable,
  buildProfileDetail,
  computeSpend7d,
  formatPerMillion,
  formatSpend,
} from '../src/costCommand';
import { enumerateAccounts, recommendRoute } from '../src/accountSelector';
import { readAuditLog } from '../src/auditLog';
import type { ProfileSpend } from '../src/costCommand';

const enumerateAccountsMock = enumerateAccounts as jest.Mock;
const recommendRouteMock = recommendRoute as jest.Mock;
const readAuditLogMock = readAuditLog as jest.Mock;

function rc(overrides: {
  account: string;
  cliType?: string;
  model?: string;
  provider?: string;
}): any {
  return {
    account: {
      name: overrides.account,
      commandName: overrides.account,
      isDefault: false,
      isManaged: true,
      needsReauth: false,
      liveStatus: 'allowed',
    },
    route: {
      commandName: overrides.account,
      account: overrides.account,
      cliType: overrides.cliType ?? 'claude',
      provider: overrides.provider ?? 'anthropic',
      model: overrides.model ?? 'claude-sonnet-4-5',
      profile: overrides.account,
      configDir: `/.${overrides.account}`,
      quota: { source: 'unknown' } as any,
      metadata: {} as any,
      launch: { status: 'available' } as any,
      health: { status: 'healthy' } as any,
      lastFailure: null,
    },
    capabilities: [],
    score: 100,
    selected: false,
    scoreReason: '',
    reasons: [],
  };
}

beforeEach(() => {
  enumerateAccountsMock.mockReset();
  recommendRouteMock.mockReset();
  readAuditLogMock.mockReset();
  readAuditLogMock.mockReturnValue([]);
});

// ─────────────────────────────────────────────────────────────────────
// buildRowFromCandidate — row shape per candidate
// ─────────────────────────────────────────────────────────────────────

describe('buildRowFromCandidate', () => {
  test('includes profile, cli, provider, model, rates, cost', () => {
    const candidate = rc({ account: 'a', model: 'claude-sonnet-4-5' });
    const spend = new Map<string, ProfileSpend>();
    const row = buildRowFromCandidate(candidate, spend, 5_000, 1_500);
    expect(row).toEqual(expect.objectContaining({
      profile: 'a',
      cliType: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputUsdPerMillion: 3.00,
      outputUsdPerMillion: 15.00,
      cacheReadUsdPerMillion: 0.30,
      cacheWriteUsdPerMillion: 3.75,
      spent7dUsd: 0,
      lastUseTs: null,
    }));
    expect(row.estCostPerCallUsd).toBeCloseTo(0.0375, 4);
  });

  test('unknown model produces null rates + null estCost', () => {
    const candidate = rc({ account: 'a', model: 'unknown-model' });
    const row = buildRowFromCandidate(candidate, new Map(), 5_000, 1_500);
    expect(row.inputUsdPerMillion).toBeNull();
    expect(row.outputUsdPerMillion).toBeNull();
    expect(row.estCostPerCallUsd).toBeNull();
  });

  test('spend map values appear in the row', () => {
    const candidate = rc({ account: 'a', model: 'claude-sonnet-4-5' });
    const spend = new Map<string, ProfileSpend>([
      ['a', { profile: 'a', spent_7d_usd: 5.5, last_use_ts: 1_700_000_000_000 }],
    ]);
    const row = buildRowFromCandidate(candidate, spend, 5_000, 1_500);
    expect(row.spent7dUsd).toBe(5.5);
    expect(row.lastUseTs).toBe(1_700_000_000_000);
  });

  test('haiku is cheaper than sonnet', () => {
    const sonnetRow = buildRowFromCandidate(rc({ account: 's', model: 'claude-sonnet-4-5' }), new Map(), 5_000, 1_500);
    const haikuRow = buildRowFromCandidate(rc({ account: 'h', model: 'claude-haiku-4-5' }), new Map(), 5_000, 1_500);
    expect(haikuRow.estCostPerCallUsd!).toBeLessThan(sonnetRow.estCostPerCallUsd!);
  });
});

// ─────────────────────────────────────────────────────────────────────
// applyFilters
// ─────────────────────────────────────────────────────────────────────

describe('applyFilters', () => {
  const rows = [
    { profile: 'opus', cliType: 'claude', provider: 'anthropic', model: 'claude-opus-4-5', inputUsdPerMillion: 15, outputUsdPerMillion: 75, cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, estCostPerCallUsd: 0.1875, spent7dUsd: 0, lastUseTs: null },
    { profile: 'sonnet', cliType: 'claude', provider: 'anthropic', model: 'claude-sonnet-4-5', inputUsdPerMillion: 3, outputUsdPerMillion: 15, cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, estCostPerCallUsd: 0.0375, spent7dUsd: 0, lastUseTs: null },
    { profile: 'haiku', cliType: 'claude', provider: 'anthropic', model: 'claude-haiku-4-5', inputUsdPerMillion: 1, outputUsdPerMillion: 5, cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, estCostPerCallUsd: 0.0125, spent7dUsd: 0, lastUseTs: null },
    { profile: 'codex', cliType: 'codex', provider: 'openai', model: 'gpt-5', inputUsdPerMillion: 5, outputUsdPerMillion: 15, cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, estCostPerCallUsd: 0.0475, spent7dUsd: 0, lastUseTs: null },
    { profile: 'mystery', cliType: 'claude', provider: 'mystery', model: 'unknown', inputUsdPerMillion: null, outputUsdPerMillion: null, cacheReadUsdPerMillion: null, cacheWriteUsdPerMillion: null, estCostPerCallUsd: null, spent7dUsd: 0, lastUseTs: null },
  ];

  test('no filter returns all rows', () => {
    expect(applyFilters(rows, {})).toHaveLength(5);
  });

  test('budgetUsd filters rows under the ceiling', () => {
    const filtered = applyFilters(rows, { budgetUsd: 0.05 });
    expect(filtered.map(r => r.profile).sort()).toEqual(['codex', 'haiku', 'sonnet']);
  });

  test('budgetUsd 0 filters out everything (no row has estCost ≤ 0 except mysteries which are null)', () => {
    expect(applyFilters(rows, { budgetUsd: 0 })).toHaveLength(0);
  });

  test('budgetUsd excludes null-cost rows (cannot evaluate budget)', () => {
    const filtered = applyFilters(rows, { budgetUsd: 100 });
    expect(filtered.find(r => r.profile === 'mystery')).toBeUndefined();
  });

  test('profile filter narrows to one row', () => {
    const filtered = applyFilters(rows, { profile: 'sonnet' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].profile).toBe('sonnet');
  });

  test('cliType filter narrows by cli', () => {
    const filtered = applyFilters(rows, { cliType: 'codex' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].profile).toBe('codex');
  });

  test('budget + cli filters combine', () => {
    const filtered = applyFilters(rows, { cliType: 'claude', budgetUsd: 0.05 });
    expect(filtered.map(r => r.profile).sort()).toEqual(['haiku', 'sonnet']);
  });

  test('unknown profile filter → empty result', () => {
    expect(applyFilters(rows, { profile: 'does-not-exist' })).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildCostTable — integration with mocked recommendRoute
// ─────────────────────────────────────────────────────────────────────

describe('buildCostTable', () => {
  beforeEach(() => {
    enumerateAccountsMock.mockReturnValue([
      { name: 'opus', commandName: 'opus', cliType: 'claude', configDir: '/.opus', isDefault: false, isManaged: true },
      { name: 'sonnet', commandName: 'sonnet', cliType: 'claude', configDir: '/.sonnet', isDefault: false, isManaged: true },
    ]);
    recommendRouteMock.mockResolvedValue({
      candidates: [
        rc({ account: 'opus', model: 'claude-opus-4-5' }),
        rc({ account: 'sonnet', model: 'claude-sonnet-4-5' }),
      ],
    });
  });

  test('returns one row per enumerated account', async () => {
    const table = await buildCostTable({});
    expect(table.rows).toHaveLength(2);
    expect(table.rows.map(r => r.profile).sort()).toEqual(['opus', 'sonnet']);
  });

  test('estInputTokens / estOutputTokens default to 5000 / 1500', async () => {
    const table = await buildCostTable({});
    expect(table.estInputTokens).toBe(5000);
    expect(table.estOutputTokens).toBe(1500);
  });

  test('budgetUsd in the table metadata + filters rows', async () => {
    const table = await buildCostTable({ budgetUsd: 0.05 });
    expect(table.budgetUsd).toBe(0.05);
    expect(table.rows.map(r => r.profile)).toEqual(['sonnet']);
  });

  test('profile filter returns matching profile only', async () => {
    const table = await buildCostTable({ profile: 'sonnet' });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].profile).toBe('sonnet');
  });

  test('cliType filter narrows by cli', async () => {
    enumerateAccountsMock.mockReturnValue([
      { name: 'codex', commandName: 'codex', cliType: 'codex', configDir: '/.codex', isDefault: true, isManaged: false },
      { name: 'sonnet', commandName: 'sonnet', cliType: 'claude', configDir: '/.sonnet', isDefault: false, isManaged: true },
    ]);
    recommendRouteMock.mockResolvedValue({
      candidates: [
        rc({ account: 'codex', model: 'gpt-5', cliType: 'codex', provider: 'openai' }),
        rc({ account: 'sonnet', model: 'claude-sonnet-4-5' }),
      ],
    });
    const table = await buildCostTable({ cliType: 'codex' });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].profile).toBe('codex');
  });

  test('custom token estimates propagate', async () => {
    const table = await buildCostTable({ estInputTokens: 10_000, estOutputTokens: 3_000 });
    expect(table.estInputTokens).toBe(10_000);
    expect(table.estOutputTokens).toBe(3_000);
    const sonnet = table.rows.find(r => r.profile === 'sonnet')!;
    // 10k×$3/M + 3k×$15/M = 0.030 + 0.045 = 0.075
    expect(sonnet.estCostPerCallUsd!).toBeCloseTo(0.075, 4);
  });

  test('generatedAt is an ISO timestamp', async () => {
    const table = await buildCostTable({});
    expect(table.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('JSON shape is stable (snapshot of keys)', async () => {
    const table = await buildCostTable({});
    expect(Object.keys(table).sort()).toEqual([
      'budgetUsd', 'estInputTokens', 'estOutputTokens', 'generatedAt', 'rows',
    ]);
    expect(Object.keys(table.rows[0]).sort()).toEqual([
      'cacheReadUsdPerMillion',
      'cacheWriteUsdPerMillion',
      'cliType',
      'estCostPerCallUsd',
      'inputUsdPerMillion',
      'lastUseTs',
      'model',
      'outputUsdPerMillion',
      'profile',
      'provider',
      'spent7dUsd',
    ]);
  });

  test('accounts with no recommendRoute candidate still produce a row (fallback path)', async () => {
    enumerateAccountsMock.mockReturnValue([
      { name: 'a', commandName: 'a', cliType: 'claude', configDir: '/.a', isDefault: false, isManaged: true },
    ]);
    recommendRouteMock.mockResolvedValue({ candidates: [] });
    const table = await buildCostTable({});
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].profile).toBe('a');
  });
});

// ─────────────────────────────────────────────────────────────────────
// computeSpend7d
// ─────────────────────────────────────────────────────────────────────

describe('computeSpend7d', () => {
  test('returns 0 spend for profiles with no audit history', () => {
    readAuditLogMock.mockReturnValue([]);
    const rows = computeSpend7d([{ commandName: 'a' }, { commandName: 'b' }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ profile: 'a', spent_7d_usd: 0, last_use_ts: null });
  });

  test('sums token_usage events within the 7d window', () => {
    const now = Date.now();
    readAuditLogMock.mockReturnValue([
      {
        timestamp: new Date(now - 24 * 3600 * 1000).toISOString(),
        action: 'token_usage',
        account: 'sonnet',
        details: { model: 'claude-sonnet-4-5', inputTokens: 100_000, outputTokens: 50_000 },
      },
      {
        timestamp: new Date(now - 12 * 3600 * 1000).toISOString(),
        action: 'token_usage',
        account: 'sonnet',
        details: { model: 'claude-sonnet-4-5', inputTokens: 50_000, outputTokens: 25_000 },
      },
    ]);
    const rows = computeSpend7d([{ commandName: 'sonnet' }], now);
    // Two calls: 100k×$3/M+50k×$15/M=$1.05 + 50k×$3/M+25k×$15/M=$0.525 = $1.575
    expect(rows[0].spent_7d_usd).toBeCloseTo(1.575, 3);
    expect(rows[0].last_use_ts).toBeGreaterThan(0);
  });

  test('ignores entries outside the 7d window', () => {
    const now = Date.now();
    // We pass `now` so readAuditLog filter by `since` would have
    // already excluded these, but `computeSpend7d` also gates
    // defensively. Set up the mock to return a too-old entry to
    // confirm the function ignores it.
    readAuditLogMock.mockReturnValue([
      {
        timestamp: new Date(now - 10 * 24 * 3600 * 1000).toISOString(),
        action: 'token_usage',
        account: 'sonnet',
        details: { model: 'claude-sonnet-4-5', inputTokens: 100_000, outputTokens: 50_000 },
      },
    ]);
    const rows = computeSpend7d([{ commandName: 'sonnet' }], now);
    expect(rows[0].spent_7d_usd).toBe(0);
  });

  test('ignores non-token_usage events', () => {
    const now = Date.now();
    readAuditLogMock.mockReturnValue([
      {
        timestamp: new Date(now - 24 * 3600 * 1000).toISOString(),
        action: 'profile_added',
        account: 'sonnet',
        details: {},
      },
    ]);
    const rows = computeSpend7d([{ commandName: 'sonnet' }], now);
    expect(rows[0].spent_7d_usd).toBe(0);
  });

  test('accepts explicit costUsd in details when token counts missing', () => {
    const now = Date.now();
    readAuditLogMock.mockReturnValue([
      {
        timestamp: new Date(now - 24 * 3600 * 1000).toISOString(),
        action: 'token_usage',
        account: 'a',
        details: { costUsd: 2.50 },
      },
    ]);
    const rows = computeSpend7d([{ commandName: 'a' }], now);
    expect(rows[0].spent_7d_usd).toBeCloseTo(2.50, 4);
  });

  test('tracks last_use_ts as max timestamp', () => {
    const now = Date.now();
    const t1 = now - 5 * 24 * 3600 * 1000;
    const t2 = now - 2 * 24 * 3600 * 1000;
    readAuditLogMock.mockReturnValue([
      {
        timestamp: new Date(t1).toISOString(),
        action: 'token_usage',
        account: 'a',
        details: { model: 'claude-sonnet-4-5', inputTokens: 1000, outputTokens: 500 },
      },
      {
        timestamp: new Date(t2).toISOString(),
        action: 'token_usage',
        account: 'a',
        details: { model: 'claude-sonnet-4-5', inputTokens: 1000, outputTokens: 500 },
      },
    ]);
    const rows = computeSpend7d([{ commandName: 'a' }], now);
    expect(rows[0].last_use_ts).toBeGreaterThanOrEqual(t2 - 1000);
  });

  test('handles malformed details gracefully (no throw)', () => {
    const now = Date.now();
    readAuditLogMock.mockReturnValue([
      {
        timestamp: new Date(now - 24 * 3600 * 1000).toISOString(),
        action: 'token_usage',
        account: 'a',
        details: null,
      } as any,
    ]);
    expect(() => computeSpend7d([{ commandName: 'a' }], now)).not.toThrow();
  });

  test('does not credit accounts without matching audit entries', () => {
    const now = Date.now();
    readAuditLogMock.mockReturnValue([
      {
        timestamp: new Date(now - 24 * 3600 * 1000).toISOString(),
        action: 'token_usage',
        account: 'sonnet',
        details: { model: 'claude-sonnet-4-5', inputTokens: 1000, outputTokens: 500 },
      },
    ]);
    const rows = computeSpend7d([{ commandName: 'sonnet' }, { commandName: 'opus' }], now);
    const opus = rows.find(r => r.profile === 'opus')!;
    expect(opus.spent_7d_usd).toBe(0);
  });

  test('non-existent audit file → empty result, no throw', () => {
    const rows = computeSpend7d([{ commandName: 'a' }], Date.now(), '/tmp/does-not-exist-xyz.jsonl');
    expect(rows).toEqual([{ profile: 'a', spent_7d_usd: 0, last_use_ts: null }]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildProfileDetail
// ─────────────────────────────────────────────────────────────────────

describe('buildProfileDetail', () => {
  beforeEach(() => {
    enumerateAccountsMock.mockReturnValue([
      { name: 'sonnet', commandName: 'sonnet', cliType: 'claude', configDir: '/.sonnet', isDefault: false, isManaged: true },
    ]);
  });

  test('returns null when profile not found', () => {
    enumerateAccountsMock.mockReturnValue([]);
    expect(buildProfileDetail('does-not-exist')).toBeNull();
  });

  test('returns models list with per-model pricing for known provider', () => {
    const detail = buildProfileDetail('sonnet', 5_000, 1_500, [
      { name: 'sonnet', commandName: 'sonnet', cliType: 'claude', provider: 'kimi', model: 'kimi-k2.6' } as any,
    ]);
    expect(detail).not.toBeNull();
    expect(detail!.profile).toBe('sonnet');
    expect(detail!.provider).toBe('kimi');
    expect(detail!.defaultModel).toBe('kimi-k2.6');
    expect(detail!.models.length).toBeGreaterThan(0);
  });

  test('estCostPerCallUsd populated when model is in pricing table', () => {
    const detail = buildProfileDetail('sonnet', 5_000, 1_500, [
      { name: 'sonnet', commandName: 'sonnet', cliType: 'claude', provider: 'anthropic' } as any,
    ]);
    expect(detail).not.toBeNull();
    // anthropic provider's default model is claude-sonnet-4-6 → priced
    const defaultRow = detail!.models.find(m => m.model === detail!.defaultModel);
    expect(defaultRow).toBeDefined();
    expect(defaultRow!.estCostPerCallUsd).toBeCloseTo(0.0375, 4);
  });

  test('handles missing provider config (synthesises minimal row)', () => {
    const detail = buildProfileDetail('sonnet', 5_000, 1_500, [
      { name: 'sonnet', commandName: 'sonnet', cliType: 'claude' } as any,
    ]);
    expect(detail).not.toBeNull();
    expect(detail!.cliType).toBe('claude');
  });
});

// ─────────────────────────────────────────────────────────────────────
// formatPerMillion / formatSpend
// ─────────────────────────────────────────────────────────────────────

describe('formatPerMillion', () => {
  test('null → dash', () => {
    expect(formatPerMillion(null)).toBe('—');
  });
  test('zero → $0', () => {
    expect(formatPerMillion(0)).toBe('$0');
  });
  test('cents → 3 decimals', () => {
    expect(formatPerMillion(0.05)).toBe('$0.050');
  });
  test('dollars → 2 decimals', () => {
    expect(formatPerMillion(3.0)).toBe('$3.00');
    expect(formatPerMillion(15.0)).toBe('$15.00');
  });
  test('Infinity → dash', () => {
    expect(formatPerMillion(Infinity)).toBe('—');
  });
});

describe('formatSpend', () => {
  test('zero → $0.0000', () => {
    expect(formatSpend(0)).toBe('$0.0000');
  });
  test('sub-dollar → 4 decimals', () => {
    expect(formatSpend(0.0123)).toBe('$0.0123');
    expect(formatSpend(0.5)).toBe('$0.5000');
  });
  test('dollar+ → 2 decimals', () => {
    expect(formatSpend(1.25)).toBe('$1.25');
    expect(formatSpend(123.45)).toBe('$123.45');
  });
  test('Infinity → dash', () => {
    expect(formatSpend(Infinity)).toBe('—');
  });
});
