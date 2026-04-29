import { describe, it, expect } from 'vitest';
import { MODEL_OPTIONS, getModelOption } from '../../models.js';
import { PRICING } from '../../pricing.js';
import { CodexRunner } from '../../runner/codex.js';

describe('OpenAI Plus provider support', () => {
  const openaiModels = MODEL_OPTIONS.filter(m => m.provider === 'openai');
  const expectedModels = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'o3',
    'o4-mini',
    'codex-mini',
  ];

  it('all expected OpenAI models exist in MODEL_OPTIONS', () => {
    const ids = openaiModels.map(m => m.id);
    for (const id of expectedModels) {
      expect(ids, `missing model: ${id}`).toContain(id);
    }
  });

  it('codex-mini has toolUse support', () => {
    const codexMini = getModelOption('codex-mini');
    expect(codexMini).toBeDefined();
    expect(codexMini!.supportsToolUse).toBe(true);
  });

  it('gpt-4.1-mini and gpt-4.1-nano exist with correct capabilities', () => {
    const mini = getModelOption('gpt-4.1-mini');
    expect(mini).toBeDefined();
    expect(mini!.provider).toBe('openai');
    expect(mini!.supportsToolUse).toBe(true);
    expect(mini!.supportsVision).toBe(true);
    expect(mini!.costTier).toBe('cheap');

    const nano = getModelOption('gpt-4.1-nano');
    expect(nano).toBeDefined();
    expect(nano!.provider).toBe('openai');
    expect(nano!.supportsToolUse).toBe(true);
    expect(nano!.costTier).toBe('cheap');
  });

  it('o3 and o4-mini support thinking', () => {
    const o3 = getModelOption('o3');
    expect(o3).toBeDefined();
    expect(o3!.supportsThinking).toBe(true);

    const o4mini = getModelOption('o4-mini');
    expect(o4mini).toBeDefined();
    expect(o4mini!.supportsThinking).toBe(true);
  });

  it('all OpenAI models in MODEL_OPTIONS have pricing entries', () => {
    for (const model of openaiModels) {
      expect(PRICING[model.id], `missing pricing for ${model.id}`).toBeDefined();
    }
  });

  it('pricing entries have positive input and output costs', () => {
    for (const model of openaiModels) {
      const pricing = PRICING[model.id];
      expect(pricing.inputPer1M, `${model.id} inputPer1M`).toBeGreaterThan(0);
      expect(pricing.outputPer1M, `${model.id} outputPer1M`).toBeGreaterThan(0);
    }
  });

  it('CodexRunner implements ModelRunner interface', () => {
    const runner = new CodexRunner('/usr/local/bin/codex');
    expect(runner.engine).toBe('codex');
    expect(typeof runner.isAvailable).toBe('function');
    expect(typeof runner.run).toBe('function');
  });
});
