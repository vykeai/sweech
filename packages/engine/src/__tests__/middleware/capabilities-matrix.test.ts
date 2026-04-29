import { describe, it, expect } from 'vitest';
import { MODEL_OPTIONS, getModelCapabilities } from '../../models.js';
import { PRICING } from '../../pricing.js';
import type { CostTier } from '../../models.js';

const VALID_COST_TIERS: CostTier[] = ['free', 'cheap', 'mid', 'premium'];

describe('capabilities matrix', () => {
  it('every model has all required fields', () => {
    for (const m of MODEL_OPTIONS) {
      expect(m.id, `${m.id} missing id`).toBeTruthy();
      expect(m.label, `${m.id} missing label`).toBeTruthy();
      expect(m.provider, `${m.id} missing provider`).toBeTruthy();
      expect(typeof m.supportsEffort, `${m.id} supportsEffort`).toBe('boolean');
      expect(typeof m.supportsThinking, `${m.id} supportsThinking`).toBe('boolean');
      expect(typeof m.contextWindow, `${m.id} contextWindow`).toBe('number');
      expect(typeof m.maxOutput, `${m.id} maxOutput`).toBe('number');
      expect(typeof m.supportsToolUse, `${m.id} supportsToolUse`).toBe('boolean');
      expect(typeof m.supportsVision, `${m.id} supportsVision`).toBe('boolean');
      expect(m.costTier, `${m.id} costTier`).toBeTruthy();
    }
  });

  it('contextWindow and maxOutput are positive numbers', () => {
    for (const m of MODEL_OPTIONS) {
      expect(m.contextWindow, `${m.id} contextWindow`).toBeGreaterThan(0);
      expect(m.maxOutput, `${m.id} maxOutput`).toBeGreaterThan(0);
    }
  });

  it('costTier is a valid value', () => {
    for (const m of MODEL_OPTIONS) {
      expect(VALID_COST_TIERS, `${m.id} has invalid costTier: ${m.costTier}`).toContain(m.costTier);
    }
  });

  it('no duplicate model IDs', () => {
    const ids = MODEL_OPTIONS.map(m => m.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('every non-alias PRICING entry has a MODEL_OPTIONS entry', () => {
    const knownAliases = ['opus', 'sonnet', 'haiku', 'claude-opus-4.6', 'claude-sonnet-4.6', 'claude-haiku-4.5', 'gemini-3-pro-preview'];
    const copilotOnlyPattern = /^gpt-5/;
    const legacyModels = ['gpt-4.1-mini', 'gpt-4.1-nano', 'o3-mini'];
    const modelIds = new Set(MODEL_OPTIONS.map(m => m.id));
    const gaps: string[] = [];

    for (const pricingId of Object.keys(PRICING)) {
      if (knownAliases.includes(pricingId)) continue;
      if (copilotOnlyPattern.test(pricingId)) continue;
      if (legacyModels.includes(pricingId)) continue;
      if (!modelIds.has(pricingId)) {
        gaps.push(pricingId);
      }
    }

    expect(gaps, `PRICING entries without MODEL_OPTIONS: ${gaps.join(', ')}`).toEqual([]);
  });

  it('getModelCapabilities returns new fields for known models', () => {
    const caps = getModelCapabilities('claude-opus-4-6');
    expect(caps.contextWindow).toBe(200000);
    expect(caps.maxOutput).toBe(32000);
    expect(caps.supportsToolUse).toBe(true);
    expect(caps.supportsVision).toBe(true);
    expect(caps.costTier).toBe('premium');
  });

  it('getModelCapabilities returns defaults for unknown models', () => {
    const caps = getModelCapabilities('nonexistent-model');
    expect(caps.contextWindow).toBe(128000);
    expect(caps.maxOutput).toBe(4096);
    expect(caps.supportsToolUse).toBe(false);
    expect(caps.supportsVision).toBe(false);
    expect(caps.costTier).toBe('mid');
  });
});
