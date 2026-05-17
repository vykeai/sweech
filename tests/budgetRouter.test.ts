/**
 * Tests for src/budgetRouter.ts — routeWithinBudget API + filter helper.
 *
 * Mocks recommendRoute and isInCooldown to keep tests deterministic.
 */

import type { CLIType } from '../src/providers';

// Mock the heavyweight deps before importing the module under test.
jest.mock('../src/accountSelector', () => ({
  recommendRoute: jest.fn(),
}));
jest.mock('../src/failover', () => ({
  isInCooldown: jest.fn(() => false),
}));

import { routeWithinBudget, filterCandidatesByBudget } from '../src/budgetRouter';
import { recommendRoute } from '../src/accountSelector';
import { isInCooldown } from '../src/failover';

const recommendRouteMock = recommendRoute as jest.Mock;
const isInCooldownMock = isInCooldown as jest.Mock;

// Minimal candidate factory matching the RouteCandidate shape that the
// budget router actually reads from. Anything `routeWithinBudget` does
// not look at is left undefined / cast to keep tests focused.
function candidate(overrides: {
  account: string;
  cliType?: string;
  model?: string;
  provider?: string;
  score?: number;
  reasons?: string[];
  planLabel?: string | null;
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
      configDir: `/home/.${overrides.account}`,
      quota: { source: 'unknown', planLabel: overrides.planLabel ?? null } as any,
      metadata: { costQuotaHints: { planLabel: overrides.planLabel ?? null } } as any,
      launch: { status: 'available' } as any,
      health: { status: 'healthy' } as any,
      lastFailure: null,
    },
    capabilities: [],
    score: overrides.score ?? 100,
    selected: false,
    scoreReason: '',
    reasons: overrides.reasons ?? [],
  };
}

beforeEach(() => {
  recommendRouteMock.mockReset();
  isInCooldownMock.mockReset();
  isInCooldownMock.mockReturnValue(false);
});

// ─────────────────────────────────────────────────────────────────────
// routeWithinBudget — happy path
// ─────────────────────────────────────────────────────────────────────

describe('routeWithinBudget — happy path', () => {
  test('returns first candidate under budget', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'claude-opus', model: 'claude-opus-4-5', score: 150 }),
        candidate({ account: 'claude-sonnet', model: 'claude-sonnet-4-5', score: 100 }),
        candidate({ account: 'claude-haiku', model: 'claude-haiku-4-5', score: 50 }),
      ],
    });
    // Budget $0.05 — opus costs ~$0.19, sonnet ~$0.04, haiku ~$0.01.
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 0.05 });
    expect(result).not.toBeNull();
    expect(result!.account).toBe('claude-sonnet'); // first that fits (opus rejected as over-budget)
    expect(result!.model).toBe('claude-sonnet-4-5');
    expect(result!.estimatedCostUsd).toBeCloseTo(0.0375, 3);
  });

  test('rejected list includes over-budget candidates with reason', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'opus', model: 'claude-opus-4-5' }),
        candidate({ account: 'sonnet', model: 'claude-sonnet-4-5' }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 0.05 });
    expect(result!.rejected.find(r => r.account === 'opus')).toEqual(
      expect.objectContaining({ reason: 'over-budget' }),
    );
  });

  test('returns null when every candidate exceeds budget', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'opus', model: 'claude-opus-4-5' }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 0.001 });
    expect(result).toBeNull();
  });

  test('uses custom token estimates when provided', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'sonnet', model: 'claude-sonnet-4-5' }),
      ],
    });
    const result = await routeWithinBudget({
      cliType: 'claude',
      maxCostPerCallUsd: 100,
      estInputTokens: 1_000_000,
      estOutputTokens: 1_000_000,
    });
    expect(result!.estimatedCostUsd).toBeCloseTo(18.00, 2);
  });

  test('defaults to 5k input + 1.5k output tokens', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [candidate({ account: 'sonnet', model: 'claude-sonnet-4-5' })],
    });
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 100 });
    // 5k×$3/M + 1.5k×$15/M = 0.015 + 0.0225 = 0.0375
    expect(result!.estimatedCostUsd).toBeCloseTo(0.0375, 4);
  });

  test('preserves provider + cliType + score in result', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'kimi-pro', model: 'kimi-k2.6', cliType: 'kimi', provider: 'kimi-coding', score: 42 }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'kimi', maxCostPerCallUsd: 10 });
    expect(result!.provider).toBe('kimi-coding');
    expect(result!.cliType).toBe('kimi');
    expect(result!.score).toBe(42);
  });

  test('cached input tokens reduce cost', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [candidate({ account: 'sonnet', model: 'claude-sonnet-4-5' })],
    });
    const result = await routeWithinBudget({
      cliType: 'claude',
      maxCostPerCallUsd: 1,
      estInputTokens: 5_000,
      estOutputTokens: 1_500,
      estCachedInputTokens: 4_000,
    });
    // 1k fresh @ $3/M + 4k cached @ $0.30/M + 1.5k out @ $15/M
    // = 0.003 + 0.0012 + 0.0225 = 0.0267
    expect(result!.estimatedCostUsd).toBeCloseTo(0.0267, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────
// routeWithinBudget — cooldown integration
// ─────────────────────────────────────────────────────────────────────

describe('routeWithinBudget — cooldown integration', () => {
  test('skips candidates that are in failover cooldown', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'cooled', model: 'claude-sonnet-4-5', score: 200 }),
        candidate({ account: 'fresh', model: 'claude-sonnet-4-5', score: 100 }),
      ],
    });
    isInCooldownMock.mockImplementation((name: string) => name === 'cooled');

    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 1 });
    expect(result!.account).toBe('fresh');
    expect(result!.rejected.find(r => r.account === 'cooled')).toEqual(
      expect.objectContaining({ reason: 'cooldown' }),
    );
  });

  test('returns null when every candidate is cooled down', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'a', model: 'claude-sonnet-4-5' }),
        candidate({ account: 'b', model: 'claude-sonnet-4-5' }),
      ],
    });
    isInCooldownMock.mockReturnValue(true);
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 1 });
    expect(result).toBeNull();
  });

  test('honors `now` override for deterministic time', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [candidate({ account: 'x', model: 'claude-sonnet-4-5' })],
    });
    const fixedNow = 1_700_000_000_000;
    await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 1, now: fixedNow });
    expect(isInCooldownMock).toHaveBeenCalledWith('x', fixedNow);
  });
});

// ─────────────────────────────────────────────────────────────────────
// routeWithinBudget — exclude list
// ─────────────────────────────────────────────────────────────────────

describe('routeWithinBudget — exclude list', () => {
  test('excludes the named accounts', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'first', model: 'claude-sonnet-4-5', score: 200 }),
        candidate({ account: 'second', model: 'claude-sonnet-4-5', score: 100 }),
      ],
    });
    const result = await routeWithinBudget({
      cliType: 'claude',
      maxCostPerCallUsd: 1,
      exclude: ['first'],
    });
    expect(result!.account).toBe('second');
    expect(result!.rejected.find(r => r.account === 'first')).toEqual(
      expect.objectContaining({ reason: 'excluded' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// routeWithinBudget — tier matching
// ─────────────────────────────────────────────────────────────────────

describe('routeWithinBudget — tier filter', () => {
  test('matches tier=max against "Claude Max 20x" label', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'pro', model: 'claude-sonnet-4-5', planLabel: 'Claude Pro' }),
        candidate({ account: 'max', model: 'claude-sonnet-4-5', planLabel: 'Claude Max 20x' }),
      ],
    });
    const result = await routeWithinBudget({
      cliType: 'claude',
      tier: 'max',
      maxCostPerCallUsd: 1,
    });
    expect(result!.account).toBe('max');
    expect(result!.rejected.find(r => r.account === 'pro')).toEqual(
      expect.objectContaining({ reason: 'tier-mismatch' }),
    );
  });

  test('tier=free filters out paid plans', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'free', model: 'deepseek-chat', planLabel: 'Free Tier' }),
        candidate({ account: 'pro', model: 'claude-sonnet-4-5', planLabel: 'Pro' }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', tier: 'free', maxCostPerCallUsd: 1 });
    expect(result!.account).toBe('free');
  });

  test('omitted tier means no tier filter', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'any', model: 'claude-sonnet-4-5', planLabel: 'whatever' }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 1 });
    expect(result).not.toBeNull();
  });

  test('null planLabel rejected when tier requested', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'unknown-plan', model: 'claude-sonnet-4-5', planLabel: null }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', tier: 'pro', maxCostPerCallUsd: 1 });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// routeWithinBudget — health failure handling
// ─────────────────────────────────────────────────────────────────────

describe('routeWithinBudget — candidate health', () => {
  test('skips candidates with health failures (auth-required, etc.)', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'needs-auth', model: 'claude-sonnet-4-5', reasons: ['needs-reauth'] }),
        candidate({ account: 'ok', model: 'claude-sonnet-4-5' }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 1 });
    expect(result!.account).toBe('ok');
    expect(result!.rejected.find(r => r.account === 'needs-auth')).toEqual(
      expect.objectContaining({ reason: 'health-failed' }),
    );
  });

  test('"not-selected:lower-score" alone does NOT trigger health-failed', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'runner-up', model: 'claude-sonnet-4-5', reasons: ['not-selected:lower-score'] }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 1 });
    expect(result!.account).toBe('runner-up');
  });

  test('cli-type mismatch handled separately', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'codex', model: 'gpt-5', cliType: 'codex' }),
        candidate({ account: 'claude', model: 'claude-sonnet-4-5', cliType: 'claude' }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 1 });
    expect(result!.account).toBe('claude');
    expect(result!.rejected.find(r => r.account === 'codex')).toEqual(
      expect.objectContaining({ reason: 'cli-mismatch' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// routeWithinBudget — model edge cases
// ─────────────────────────────────────────────────────────────────────

describe('routeWithinBudget — model edge cases', () => {
  test('null model → unknown-model rejection', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        { ...candidate({ account: 'no-model', model: '' }), route: { ...candidate({ account: 'no-model' }).route, model: null } },
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 1 });
    expect(result).toBeNull();
  });

  test('unpriced model → unpriced-model rejection (conservative)', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'mystery', model: 'totally-unknown-model-xyz' }),
        candidate({ account: 'known', model: 'claude-sonnet-4-5' }),
      ],
    });
    const result = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 1 });
    expect(result!.account).toBe('known');
    expect(result!.rejected.find(r => r.account === 'mystery')).toEqual(
      expect.objectContaining({ reason: 'unpriced-model' }),
    );
  });

  test('budget edge case: cost exactly equals budget → fits (inclusive)', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [candidate({ account: 'sonnet', model: 'claude-sonnet-4-5' })],
    });
    // sonnet @ 5k/1.5k = $0.0375
    const result = await routeWithinBudget({
      cliType: 'claude',
      maxCostPerCallUsd: 0.0375,
    });
    expect(result).not.toBeNull();
  });

  test('budget edge case: cost 0.0001 over budget → rejected', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [candidate({ account: 'sonnet', model: 'claude-sonnet-4-5' })],
    });
    const result = await routeWithinBudget({
      cliType: 'claude',
      maxCostPerCallUsd: 0.0374,
    });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// filterCandidatesByBudget — bulk filter helper
// ─────────────────────────────────────────────────────────────────────

describe('filterCandidatesByBudget', () => {
  test('returns one row per matching candidate', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'opus', model: 'claude-opus-4-5' }),
        candidate({ account: 'sonnet', model: 'claude-sonnet-4-5' }),
        candidate({ account: 'haiku', model: 'claude-haiku-4-5' }),
      ],
    });
    const rows = await filterCandidatesByBudget('claude', 0.05);
    expect(rows).toHaveLength(3);
    expect(rows.find(r => r.account === 'opus')!.fits).toBe(false);
    expect(rows.find(r => r.account === 'sonnet')!.fits).toBe(true);
    expect(rows.find(r => r.account === 'haiku')!.fits).toBe(true);
  });

  test('filters cli-type mismatches out', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        candidate({ account: 'claude-x', model: 'claude-sonnet-4-5', cliType: 'claude' }),
        candidate({ account: 'codex-x', model: 'gpt-5', cliType: 'codex' }),
      ],
    });
    const rows = await filterCandidatesByBudget('claude', 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe('claude-x');
  });

  test('unpriced model rows have fits=false + reason=unpriced-model', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [candidate({ account: 'x', model: 'made-up-model-id' })],
    });
    const rows = await filterCandidatesByBudget('claude', 1);
    expect(rows[0].fits).toBe(false);
    expect(rows[0].reason).toBe('unpriced-model');
  });

  test('null model rows have fits=false + reason=unknown-model', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [
        { ...candidate({ account: 'x', model: '' }), route: { ...candidate({ account: 'x' }).route, model: null } },
      ],
    });
    const rows = await filterCandidatesByBudget('claude', 1);
    expect(rows[0].fits).toBe(false);
    expect(rows[0].reason).toBe('unknown-model');
  });

  test('per-row cost matches estimateCostUsd', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [candidate({ account: 'opus', model: 'claude-opus-4-5' })],
    });
    const rows = await filterCandidatesByBudget('claude', 1, 5_000, 1_500);
    // 5k×$15/M + 1.5k×$75/M = 0.075 + 0.1125 = 0.1875
    expect(rows[0].cost).toBeCloseTo(0.1875, 4);
  });

  test('custom token estimates propagate to cost calculation', async () => {
    recommendRouteMock.mockResolvedValue({
      candidates: [candidate({ account: 'sonnet', model: 'claude-sonnet-4-5' })],
    });
    const rows = await filterCandidatesByBudget('claude', 100, 1_000_000, 1_000_000);
    expect(rows[0].cost).toBeCloseTo(18.00, 2);
  });
});
