import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ESTIMATED_INPUT_TOKENS_PER_LAUNCH,
  ESTIMATED_OUTPUT_TOKENS_PER_LAUNCH,
  estimateUsageFromLaunches,
  estimateUsageFromTokens,
  estimateUsageProxy,
  readLaunchRowsFromLog,
} from '../src/usageProxy';

describe('usageProxy', () => {
  const now = Date.UTC(2026, 4, 20);

  test('Tier 2 estimates cost from token rows grouped by model', () => {
    const estimate = estimateUsageFromTokens(
      { workspace: 'claude-work', provider: 'anthropic', defaultModel: 'claude-sonnet-4-5' },
      [
        { workspace: 'claude-work', model: 'claude-sonnet-4-5', inputTokens: 100_000, outputTokens: 50_000, timestampMs: now },
        { workspace: 'claude-work', model: 'claude-sonnet-4-5', inputTokens: 50_000, outputTokens: 25_000, timestampMs: now },
      ],
      { now }
    );

    expect(estimate.tier).toBe('tier2_tokens');
    expect(estimate.inputTokens).toBe(150_000);
    expect(estimate.outputTokens).toBe(75_000);
    expect(estimate.costUsd).toBeCloseTo(1.575, 6);
    expect(estimate.priced).toBe(true);
  });

  test('Tier 2 clamps cached tokens and charges cache-read rate', () => {
    const estimate = estimateUsageFromTokens(
      { workspace: 'claude-work', provider: 'anthropic' },
      [
        { workspace: 'claude-work', model: 'claude-sonnet-4-5', inputTokens: 5_000, outputTokens: 1_000, cachedInputTokens: 10_000, timestampMs: now },
      ],
      { now }
    );

    expect(estimate.cachedInputTokens).toBe(5_000);
    expect(estimate.costUsd).toBeCloseTo(0.0165, 6);
  });

  test('Tier 2 accepts explicit cost rows when token counts are unavailable', () => {
    const estimate = estimateUsageFromTokens(
      { workspace: 'codex-work', provider: 'openai' },
      [{ workspace: 'codex-work', model: '', costUsd: 0.42, timestampMs: now }],
      { now }
    );

    expect(estimate.tier).toBe('tier2_tokens');
    expect(estimate.costUsd).toBe(0.42);
    expect(estimate.priced).toBe(true);
  });

  test('Tier 2 ignores rows outside the selected window', () => {
    const estimate = estimateUsageFromTokens(
      { workspace: 'claude-work', provider: 'anthropic' },
      [
        { workspace: 'claude-work', model: 'claude-sonnet-4-5', inputTokens: 100_000, outputTokens: 50_000, timestampMs: now - 10_000 },
        { workspace: 'claude-work', model: 'claude-sonnet-4-5', inputTokens: 100_000, outputTokens: 50_000, timestampMs: now },
      ],
      { now, windowMs: 1_000 }
    );

    expect(estimate.inputTokens).toBe(100_000);
    expect(estimate.outputTokens).toBe(50_000);
  });

  test('Tier 2 ignores other workspaces', () => {
    const estimate = estimateUsageFromTokens(
      { workspace: 'target', provider: 'anthropic' },
      [
        { workspace: 'target', model: 'claude-sonnet-4-5', inputTokens: 1_000, outputTokens: 500, timestampMs: now },
        { workspace: 'other', model: 'claude-sonnet-4-5', inputTokens: 1_000_000, outputTokens: 1_000_000, timestampMs: now },
      ],
      { now }
    );

    expect(estimate.inputTokens).toBe(1_000);
    expect(estimate.outputTokens).toBe(500);
  });

  test('free providers return zero cost without launch fallback', () => {
    const estimate = estimateUsageProxy(
      { workspace: 'ollama', provider: 'ollama', defaultModel: 'claude-sonnet-4-5' },
      [{ workspace: 'ollama', model: 'claude-sonnet-4-5', inputTokens: 1_000_000, outputTokens: 1_000_000, timestampMs: now }],
      [{ workspace: 'ollama', timestampMs: now }],
      { now }
    );

    expect(estimate.tier).toBe('free');
    expect(estimate.pricingModel).toBe('free');
    expect(estimate.costUsd).toBe(0);
    expect(estimate.launchCount).toBe(0);
  });

  test('Tier 3 estimates usage from launch count when no token rows exist', () => {
    const estimate = estimateUsageProxy(
      { workspace: 'claude-work', provider: 'anthropic', defaultModel: 'claude-sonnet-4-5' },
      [],
      [{ workspace: 'claude-work', timestampMs: now }, { workspace: 'claude-work', timestampMs: now }],
      { now }
    );

    expect(estimate.tier).toBe('tier3_launches');
    expect(estimate.launchCount).toBe(2);
    expect(estimate.inputTokens).toBe(2 * ESTIMATED_INPUT_TOKENS_PER_LAUNCH);
    expect(estimate.outputTokens).toBe(2 * ESTIMATED_OUTPUT_TOKENS_PER_LAUNCH);
    expect(estimate.costUsd).toBeCloseTo(0.075, 6);
  });

  test('Tier 3 supports custom token budgets per launch', () => {
    const estimate = estimateUsageFromLaunches(
      { workspace: 'codex-work', provider: 'openai', defaultModel: 'gpt-5.4' },
      [{ workspace: 'codex-work', timestampMs: now }],
      { now, estimatedInputTokensPerLaunch: 10_000, estimatedOutputTokensPerLaunch: 2_000 }
    );

    expect(estimate.inputTokens).toBe(10_000);
    expect(estimate.outputTokens).toBe(2_000);
    expect(estimate.costUsd).toBeCloseTo(0.08, 6);
  });

  test('Tier 3 returns unpriced zero-cost estimate when model pricing is unknown', () => {
    const estimate = estimateUsageFromLaunches(
      { workspace: 'custom', provider: 'custom', defaultModel: 'unknown-model' },
      [{ workspace: 'custom', timestampMs: now }],
      { now }
    );

    expect(estimate.tier).toBe('tier3_launches');
    expect(estimate.priced).toBe(false);
    expect(estimate.costUsd).toBe(0);
  });

  test('Tier 3 returns none when there are no launches', () => {
    const estimate = estimateUsageFromLaunches(
      { workspace: 'claude-work', provider: 'anthropic', defaultModel: 'claude-sonnet-4-5' },
      [{ workspace: 'other', timestampMs: now }],
      { now }
    );

    expect(estimate.tier).toBe('none');
    expect(estimate.launchCount).toBe(0);
  });

  test('launch log reader parses valid JSONL rows and skips malformed lines', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-usage-proxy-'));
    const log = path.join(tmp, 'launches.log');
    fs.writeFileSync(log, [
      JSON.stringify({ ts: '2026-05-20T00:00:00.000Z', profile: 'claude-work' }),
      '{bad json',
      JSON.stringify({ ts: 'not-a-date', profile: 'bad' }),
      JSON.stringify({ ts: '2026-05-20T00:00:01.000Z', profile: 'codex-work' }),
    ].join('\n'));

    try {
      expect(readLaunchRowsFromLog(log)).toEqual([
        { workspace: 'claude-work', timestampMs: Date.parse('2026-05-20T00:00:00.000Z') },
        { workspace: 'codex-work', timestampMs: Date.parse('2026-05-20T00:00:01.000Z') },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
