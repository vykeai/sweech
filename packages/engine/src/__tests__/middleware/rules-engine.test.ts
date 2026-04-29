import { describe, it, expect } from 'vitest';
import { evaluateRule, evaluateRules } from '../../rules/engine.js';
import type { Rule, RulesConfig } from '../../rules/types.js';
import type { AgentEvent } from '../../types.js';

const ctx = { engine: 'claude-code' as const, provider: 'claude', cumulativeCostUsd: 0 };

function rule(overrides: Partial<Rule> & { when: Rule['when'] }): Rule {
  return { name: 'test', enabled: true, priority: 100, then: { action: 'retry', maxRetries: 1 }, ...overrides };
}

describe('evaluateRule', () => {
  it('matches plain error event', () => {
    const r = rule({ when: { event: 'error' } });
    expect(evaluateRule({ type: 'error', message: 'something broke' }, r, ctx)).toBe(true);
  });

  it('infers rate_limit from error message', () => {
    const r = rule({ when: { event: 'rate_limit' } });
    expect(evaluateRule({ type: 'error', message: 'rate limit exceeded' }, r, ctx)).toBe(true);
    expect(evaluateRule({ type: 'error', message: '429 Too Many Requests' }, r, ctx)).toBe(true);
  });

  it('infers timeout from error message', () => {
    const r = rule({ when: { event: 'timeout' } });
    expect(evaluateRule({ type: 'error', message: 'ETIMEDOUT' }, r, ctx)).toBe(true);
  });

  it('does not match rate_limit rule against plain error', () => {
    const r = rule({ when: { event: 'rate_limit' } });
    expect(evaluateRule({ type: 'error', message: 'file not found' }, r, ctx)).toBe(false);
  });

  it('filters by engine', () => {
    const r = rule({ when: { event: 'error', engine: 'pi-mono' } });
    expect(evaluateRule({ type: 'error', message: 'fail' }, r, ctx)).toBe(false);
    expect(evaluateRule({ type: 'error', message: 'fail' }, r, { ...ctx, engine: 'pi-mono' })).toBe(true);
  });

  it('filters by provider', () => {
    const r = rule({ when: { event: 'error', provider: 'openai' } });
    expect(evaluateRule({ type: 'error', message: 'fail' }, r, ctx)).toBe(false);
    expect(evaluateRule({ type: 'error', message: 'fail' }, r, { ...ctx, provider: 'openai' })).toBe(true);
  });

  it('matches pattern against error message', () => {
    const r = rule({ when: { event: 'error', pattern: 'ECONNREFUSED|ECONNRESET' } });
    expect(evaluateRule({ type: 'error', message: 'connect ECONNREFUSED 127.0.0.1:3000' }, r, ctx)).toBe(true);
    expect(evaluateRule({ type: 'error', message: 'some other error' }, r, ctx)).toBe(false);
  });

  it('matches cost_exceeded when cumulative cost exceeds threshold', () => {
    const r = rule({ when: { event: 'cost_exceeded', maxCostUsd: 5 } });
    const costEvent: AgentEvent = { type: 'cost_update', costUsd: 1, tokensUsed: { inputTokens: 100, outputTokens: 50 } };
    expect(evaluateRule(costEvent, r, { ...ctx, cumulativeCostUsd: 3 })).toBe(false);
    expect(evaluateRule(costEvent, r, { ...ctx, cumulativeCostUsd: 5.01 })).toBe(true);
  });

  it('ignores non-error event types for error rules', () => {
    const r = rule({ when: { event: 'error' } });
    expect(evaluateRule({ type: 'text', content: 'hello' }, r, ctx)).toBe(false);
    expect(evaluateRule({ type: 'result', output: 'done', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, durationMs: 0 }, r, ctx)).toBe(false);
  });

  it('requires ALL conditions to match (AND logic)', () => {
    const r = rule({ when: { event: 'error', engine: 'claude-code', pattern: 'ECONNREFUSED' } });
    // Right engine, wrong pattern
    expect(evaluateRule({ type: 'error', message: 'other error' }, r, ctx)).toBe(false);
    // Right pattern, wrong engine
    expect(evaluateRule({ type: 'error', message: 'ECONNREFUSED' }, r, { ...ctx, engine: 'pi-mono' })).toBe(false);
    // Both match
    expect(evaluateRule({ type: 'error', message: 'ECONNREFUSED' }, r, ctx)).toBe(true);
  });
});

describe('evaluateRules', () => {
  it('returns first matching rule action by priority', () => {
    const config: RulesConfig = {
      version: 1,
      rules: [
        rule({ name: 'low-pri', priority: 50, when: { event: 'error' }, then: { action: 'warn', message: 'low' } }),
        rule({ name: 'high-pri', priority: 10, when: { event: 'error' }, then: { action: 'retry', maxRetries: 3 } }),
      ],
      tiers: {},
    };
    // Rules should be sorted by priority (engine.ts relies on config ordering, config.ts sorts on save)
    config.rules.sort((a, b) => a.priority - b.priority);
    const action = evaluateRules({ type: 'error', message: 'fail' }, config, ctx);
    expect(action?.action).toBe('retry');
  });

  it('skips disabled rules', () => {
    const config: RulesConfig = {
      version: 1,
      rules: [
        rule({ name: 'disabled', enabled: false, when: { event: 'error' }, then: { action: 'abort' } }),
        rule({ name: 'enabled', enabled: true, when: { event: 'error' }, then: { action: 'retry', maxRetries: 1 } }),
      ],
      tiers: {},
    };
    const action = evaluateRules({ type: 'error', message: 'fail' }, config, ctx);
    expect(action?.action).toBe('retry');
  });

  it('returns null when no rules match', () => {
    const config: RulesConfig = { version: 1, rules: [], tiers: {} };
    expect(evaluateRules({ type: 'error', message: 'fail' }, config, ctx)).toBeNull();
  });
});
