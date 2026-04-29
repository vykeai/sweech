import { describe, it, expect } from 'vitest';
import { estimateCost, PRICING } from '../../pricing.js';

describe('pricing', () => {
  it('estimates cost for claude-sonnet-4-6', () => {
    const cost = estimateCost({ inputTokens: 1000, outputTokens: 500 }, 'claude-sonnet-4-6');
    // 1000/1M * 3 + 500/1M * 15 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('includes cache cost when tokens present', () => {
    const cost = estimateCost({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 }, 'claude-opus-4-6');
    // 1000/1M * 15 + 500/1M * 75 + 2000/1M * 1.5
    expect(cost).toBeCloseTo(0.015 + 0.0375 + 0.003, 6);
  });

  it('returns 0 for unknown model', () => {
    expect(estimateCost({ inputTokens: 1000, outputTokens: 500 }, 'unknown-model')).toBe(0);
  });

  it('has pricing for tier aliases', () => {
    expect(PRICING['opus']).toBeDefined();
    expect(PRICING['sonnet']).toBeDefined();
    expect(PRICING['haiku']).toBeDefined();
  });
});
