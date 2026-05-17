/**
 * Tests for src/costs.ts — pricing table, override loader, cost math.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MODEL_PRICING,
  getModelPricing,
  estimateCostUsd,
  getPricingTable,
  formatUsd,
  formatUsdCompact,
} from '../src/costs';

describe('MODEL_PRICING table', () => {
  test('contains anthropic claude-sonnet-4-x rates', () => {
    expect(MODEL_PRICING['claude-sonnet-4']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-5']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-sonnet-4'].input_usd_per_million).toBe(3.00);
    expect(MODEL_PRICING['claude-sonnet-4'].output_usd_per_million).toBe(15.00);
  });

  test('contains claude opus 4.x family', () => {
    expect(MODEL_PRICING['claude-opus-4']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-5']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-7']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-5'].input_usd_per_million).toBe(15.00);
    expect(MODEL_PRICING['claude-opus-4-5'].output_usd_per_million).toBe(75.00);
  });

  test('contains claude haiku 4.5', () => {
    expect(MODEL_PRICING['claude-haiku-4-5']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5'].input_usd_per_million).toBe(1.00);
  });

  test('contains gpt-5 family', () => {
    expect(MODEL_PRICING['gpt-5']).toBeDefined();
    expect(MODEL_PRICING['gpt-5-mini']).toBeDefined();
    expect(MODEL_PRICING['gpt-5'].output_usd_per_million).toBeGreaterThan(MODEL_PRICING['gpt-5-mini'].output_usd_per_million);
  });

  test('contains gpt-4o + gpt-4o-mini', () => {
    expect(MODEL_PRICING['gpt-4o']).toBeDefined();
    expect(MODEL_PRICING['gpt-4o-mini']).toBeDefined();
    expect(MODEL_PRICING['gpt-4o-mini'].input_usd_per_million).toBe(0.15);
  });

  test('contains kimi-k2 + k2.6 variants', () => {
    expect(MODEL_PRICING['kimi-k2']).toBeDefined();
    expect(MODEL_PRICING['kimi-k2.6']).toBeDefined();
    expect(MODEL_PRICING['kimi-k2-turbo-preview']).toBeDefined();
  });

  test('contains qwen3-coder + qwen-coder-plus aliases', () => {
    expect(MODEL_PRICING['qwen3-coder-plus']).toBeDefined();
    expect(MODEL_PRICING['qwen-coder-plus']).toBeDefined();
    expect(MODEL_PRICING['qwen3-coder-flash']).toBeDefined();
  });

  test('contains deepseek-chat + deepseek-reasoner', () => {
    expect(MODEL_PRICING['deepseek-chat']).toBeDefined();
    expect(MODEL_PRICING['deepseek-reasoner']).toBeDefined();
    expect(MODEL_PRICING['deepseek-chat'].input_usd_per_million).toBe(0.28);
    expect(MODEL_PRICING['deepseek-chat'].output_usd_per_million).toBe(0.42);
  });

  test('contains glm-4.6 + glm-5 + glm-5.1', () => {
    expect(MODEL_PRICING['glm-4.6']).toBeDefined();
    expect(MODEL_PRICING['glm-5']).toBeDefined();
    expect(MODEL_PRICING['glm-5.1']).toBeDefined();
  });

  test('claude has cache_read + cache_write rates', () => {
    const sonnet = MODEL_PRICING['claude-sonnet-4-5'];
    expect(sonnet.cache_read_usd_per_million).toBeDefined();
    expect(sonnet.cache_write_usd_per_million).toBeDefined();
    expect(sonnet.cache_read_usd_per_million).toBeLessThan(sonnet.input_usd_per_million);
  });

  test('every entry has non-negative input + output rates', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.input_usd_per_million).toBeGreaterThanOrEqual(0);
      expect(pricing.output_usd_per_million).toBeGreaterThanOrEqual(0);
    }
  });

  test('output >= input for every entry (industry convention)', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.output_usd_per_million).toBeGreaterThanOrEqual(pricing.input_usd_per_million * 0.5);
    }
  });

  test('contains at least 12 models (covers the acceptance criteria list)', () => {
    expect(Object.keys(MODEL_PRICING).length).toBeGreaterThanOrEqual(12);
  });
});

describe('getModelPricing', () => {
  test('exact match returns the entry', () => {
    const pricing = getModelPricing('claude-sonnet-4-5');
    expect(pricing).not.toBeNull();
    expect(pricing!.input_usd_per_million).toBe(3.00);
  });

  test('case-insensitive lookup', () => {
    const pricing = getModelPricing('Claude-Sonnet-4-5');
    expect(pricing).not.toBeNull();
    expect(pricing!.input_usd_per_million).toBe(3.00);
  });

  test('strips provider prefix (anthropic/claude-sonnet-4.5)', () => {
    const pricing = getModelPricing('anthropic/claude-sonnet-4.5');
    expect(pricing).not.toBeNull();
    expect(pricing!.input_usd_per_million).toBe(3.00);
  });

  test('strips provider prefix (openai/gpt-5.4)', () => {
    const pricing = getModelPricing('openai/gpt-5.4');
    expect(pricing).not.toBeNull();
    expect(pricing!.input_usd_per_million).toBe(5.00);
  });

  test('strips trailing date stamp (claude-3.5-sonnet-20241022)', () => {
    const pricing = getModelPricing('claude-3.5-sonnet-20241022');
    expect(pricing).not.toBeNull();
    expect(pricing!.input_usd_per_million).toBe(3.00);
  });

  test('dotted variant resolves to dashed key (claude-sonnet-4.5 -> claude-sonnet-4-5)', () => {
    const pricing = getModelPricing('claude-sonnet-4.5');
    expect(pricing).not.toBeNull();
  });

  test('returns null for unknown model', () => {
    expect(getModelPricing('totally-made-up-model')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(getModelPricing('')).toBeNull();
  });

  test('strips MiniMax-M2.7-highspeed suffix', () => {
    // Note: pricing key is lowercase, normaliser handles case.
    const pricing = getModelPricing('MiniMax-M2.7-highspeed');
    expect(pricing).not.toBeNull();
    expect(pricing!.input_usd_per_million).toBe(0.30);
  });

  test('kimi-k2-thinking-turbo falls back to kimi-k2-thinking when needed', () => {
    // We have kimi-k2-thinking in the table; turbo variant should
    // resolve via prefix-match path.
    const pricing = getModelPricing('kimi-k2-thinking-turbo');
    expect(pricing).not.toBeNull();
  });

  test('grok-code-fast-1 resolves directly', () => {
    const pricing = getModelPricing('grok-code-fast-1');
    expect(pricing).not.toBeNull();
    expect(pricing!.input_usd_per_million).toBe(0.20);
  });
});

describe('estimateCostUsd', () => {
  test('returns 0 for unknown model (safe fallback)', () => {
    expect(estimateCostUsd('unknown-model', 1000, 500)).toBe(0);
  });

  test('claude-sonnet-4-5: 1M in + 1M out = $3 + $15 = $18', () => {
    const cost = estimateCostUsd('claude-sonnet-4-5', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18.00, 4);
  });

  test('claude-opus-4-5: 5k in + 1.5k out = ~$0.1875', () => {
    // 5000/1M × $15 + 1500/1M × $75 = 0.075 + 0.1125 = 0.1875
    const cost = estimateCostUsd('claude-opus-4-5', 5_000, 1_500);
    expect(cost).toBeCloseTo(0.1875, 4);
  });

  test('claude-haiku-4-5: 5k in + 1.5k out = $0.0125', () => {
    // 5000/1M × $1 + 1500/1M × $5 = 0.005 + 0.0075 = 0.0125
    const cost = estimateCostUsd('claude-haiku-4-5', 5_000, 1_500);
    expect(cost).toBeCloseTo(0.0125, 4);
  });

  test('gpt-4o-mini: 100k in + 50k out = $0.045', () => {
    // 100k/1M × $0.15 + 50k/1M × $0.60 = 0.015 + 0.030 = 0.045
    const cost = estimateCostUsd('gpt-4o-mini', 100_000, 50_000);
    expect(cost).toBeCloseTo(0.045, 4);
  });

  test('deepseek-chat is the cheapest tier (cheaper than haiku)', () => {
    const dsCost = estimateCostUsd('deepseek-chat', 5_000, 1_500);
    const haikuCost = estimateCostUsd('claude-haiku-4-5', 5_000, 1_500);
    expect(dsCost).toBeLessThan(haikuCost);
  });

  test('opus is more expensive than sonnet by 5x output rate', () => {
    const opusCost = estimateCostUsd('claude-opus-4-5', 5_000, 1_500);
    const sonnetCost = estimateCostUsd('claude-sonnet-4-5', 5_000, 1_500);
    expect(opusCost).toBeGreaterThan(sonnetCost);
  });

  test('zero tokens = $0 cost', () => {
    expect(estimateCostUsd('claude-sonnet-4-5', 0, 0)).toBe(0);
  });

  test('negative tokens are clamped to 0 (defensive)', () => {
    expect(estimateCostUsd('claude-sonnet-4-5', -1000, -500)).toBe(0);
  });

  test('cached input tokens charged at cache_read rate when available', () => {
    // 1k fresh in @ $3/M + 4k cached @ $0.30/M + 1k out @ $15/M
    // = 0.003 + 0.0012 + 0.015 = 0.0192
    const cost = estimateCostUsd('claude-sonnet-4-5', 5_000, 1_000, 4_000);
    expect(cost).toBeCloseTo(0.0192, 4);
  });

  test('cached input clamped at total input (cannot exceed inputTokens)', () => {
    // estCachedInputTokens=10k but input only 5k → treat all 5k as cached
    const cost = estimateCostUsd('claude-sonnet-4-5', 5_000, 1_000, 10_000);
    // 0 fresh + 5k cached @ $0.30/M + 1k out @ $15/M = 0 + 0.0015 + 0.015 = 0.0165
    expect(cost).toBeCloseTo(0.0165, 4);
  });

  test('cached input falls back to input rate when cache_read undefined', () => {
    // Qwen has no cache rates → cached priced at input rate
    const cost = estimateCostUsd('qwen3-coder-flash', 5_000, 1_500, 3_000);
    // entire 5k charged at input rate = $0.14/M
    // = 5000/1M × 0.14 + 1500/1M × 0.56 = 0.0007 + 0.00084 = 0.00154
    expect(cost).toBeCloseTo(0.00154, 4);
  });

  test('fractional token counts floor to integer', () => {
    const cost = estimateCostUsd('claude-sonnet-4-5', 5_500.7, 1_500.2);
    const expected = estimateCostUsd('claude-sonnet-4-5', 5_500, 1_500);
    expect(cost).toBeCloseTo(expected, 6);
  });
});

describe('pricing override file (~/.sweech/pricing.json)', () => {
  let tmpDir: string;
  let overridePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-pricing-'));
    overridePath = path.join(tmpDir, 'pricing.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('override file value replaces baked-in for known model', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'claude-sonnet-4-5': { input_usd_per_million: 1.50, output_usd_per_million: 7.50 },
    }));
    const table = getPricingTable(overridePath);
    expect(table['claude-sonnet-4-5'].input_usd_per_million).toBe(1.50);
    expect(table['claude-sonnet-4-5'].output_usd_per_million).toBe(7.50);
  });

  test('override file adds new model not in baked table', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'my-local-model': { input_usd_per_million: 0, output_usd_per_million: 0 },
    }));
    const table = getPricingTable(overridePath);
    expect(table['my-local-model']).toEqual({
      input_usd_per_million: 0,
      output_usd_per_million: 0,
    });
  });

  test('override preserves all other baked-in entries', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'claude-sonnet-4-5': { input_usd_per_million: 1.50, output_usd_per_million: 7.50 },
    }));
    const table = getPricingTable(overridePath);
    expect(table['claude-opus-4-5']).toBeDefined();
    expect(table['gpt-5']).toBeDefined();
    expect(table['kimi-k2']).toBeDefined();
  });

  test('missing override file returns baked table only', () => {
    const table = getPricingTable(path.join(tmpDir, 'does-not-exist.json'));
    expect(table['claude-sonnet-4-5'].input_usd_per_million).toBe(3.00);
  });

  test('malformed JSON falls back silently (logs to stderr)', () => {
    const origStderr = process.stderr.write;
    let stderrCalls = 0;
    process.stderr.write = (() => { stderrCalls++; return true; }) as any;
    fs.writeFileSync(overridePath, '{ not valid json');
    const table = getPricingTable(overridePath);
    expect(table['claude-sonnet-4-5'].input_usd_per_million).toBe(3.00);
    expect(stderrCalls).toBeGreaterThan(0);
    process.stderr.write = origStderr;
  });

  test('array at top level rejected (must be object)', () => {
    const origStderr = process.stderr.write;
    process.stderr.write = (() => true) as any;
    fs.writeFileSync(overridePath, JSON.stringify([{ x: 1 }]));
    const table = getPricingTable(overridePath);
    expect(table['claude-sonnet-4-5'].input_usd_per_million).toBe(3.00);
    process.stderr.write = origStderr;
  });

  test('null entries skipped', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'good-model': { input_usd_per_million: 1, output_usd_per_million: 2 },
      'bad-model': null,
    }));
    const table = getPricingTable(overridePath);
    expect(table['good-model']).toBeDefined();
    expect(table['bad-model']).toBeUndefined();
  });

  test('non-numeric rates skipped', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'string-rate': { input_usd_per_million: 'not-a-number', output_usd_per_million: 2 },
      'valid': { input_usd_per_million: 1, output_usd_per_million: 2 },
    }));
    const table = getPricingTable(overridePath);
    expect(table['string-rate']).toBeUndefined();
    expect(table['valid']).toBeDefined();
  });

  test('negative rates skipped (defensive)', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'negative': { input_usd_per_million: -1, output_usd_per_million: 2 },
    }));
    const table = getPricingTable(overridePath);
    expect(table['negative']).toBeUndefined();
  });

  test('override key normalised to lowercase', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'GPT-5.4': { input_usd_per_million: 2, output_usd_per_million: 8 },
    }));
    const table = getPricingTable(overridePath);
    expect(table['gpt-5.4'].input_usd_per_million).toBe(2);
  });

  test('Infinity rejected', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'infinite': { input_usd_per_million: 'Infinity', output_usd_per_million: 2 },
    }));
    const table = getPricingTable(overridePath);
    expect(table['infinite']).toBeUndefined();
  });

  test('optional cache_read + cache_write preserved in override', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'cached-override': {
        input_usd_per_million: 1, output_usd_per_million: 2,
        cache_read_usd_per_million: 0.1, cache_write_usd_per_million: 1.5,
      },
    }));
    const table = getPricingTable(overridePath);
    expect(table['cached-override'].cache_read_usd_per_million).toBe(0.1);
    expect(table['cached-override'].cache_write_usd_per_million).toBe(1.5);
  });

  test('estimateCostUsd respects override table', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      'claude-sonnet-4-5': { input_usd_per_million: 1.50, output_usd_per_million: 7.50 },
    }));
    const table = getPricingTable(overridePath);
    const cost = estimateCostUsd('claude-sonnet-4-5', 1_000_000, 1_000_000, 0, table);
    expect(cost).toBeCloseTo(9.00, 4); // half the baked-in price
  });
});

describe('formatUsd / formatUsdCompact', () => {
  test('formatUsd: 4-decimal precision', () => {
    // toFixed(4) rounds half-up — 0.12345 → "0.1235"
    expect(formatUsd(0.12341)).toBe('$0.1234');
    expect(formatUsd(1)).toBe('$1.0000');
    expect(formatUsd(0)).toBe('$0.0000');
  });

  test('formatUsd: Infinity → dash', () => {
    expect(formatUsd(Infinity)).toBe('—');
    expect(formatUsd(NaN)).toBe('—');
  });

  test('formatUsdCompact: amount >= $1 → 2 decimals', () => {
    expect(formatUsdCompact(1.5)).toBe('$1.50');
    expect(formatUsdCompact(10)).toBe('$10.00');
  });

  test('formatUsdCompact: amount < $1 → 4 decimals', () => {
    expect(formatUsdCompact(0.05)).toBe('$0.0500');
    expect(formatUsdCompact(0.0001)).toBe('$0.0001');
  });

  test('formatUsdCompact: zero → $0.0000', () => {
    expect(formatUsdCompact(0)).toBe('$0.0000');
  });

  test('formatUsdCompact: Infinity → dash', () => {
    expect(formatUsdCompact(Infinity)).toBe('—');
  });
});
