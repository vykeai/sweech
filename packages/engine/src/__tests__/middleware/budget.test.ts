import { describe, it, expect } from 'vitest';
import { budgetMiddleware } from '../../middleware/budget.js';
import { wrapRunner } from '../../middleware/wrap.js';
import type { AgentEvent, ModelRunner, RunOptions } from '../../types.js';

function createRunner(engine: string, eventsByAttempt: AgentEvent[][]): ModelRunner {
  let index = 0;
  return {
    engine: engine as ModelRunner['engine'],
    isAvailable: async () => true,
    async *run() {
      const events = eventsByAttempt[index] ?? [];
      index += 1;
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('budgetMiddleware', () => {
  it('preserves abort behaviour when cumulative cost exceeds the configured maximum', async () => {
    const runner = wrapRunner(
      createRunner('pi-mono', [[
        {
          type: 'cost_update',
          costUsd: 0.06,
          tokensUsed: { inputTokens: 10, outputTokens: 6 },
        },
      ]]),
      budgetMiddleware({ maxCostUsd: 0.05, action: 'abort', hysteresisPct: 0 }),
    );

    const events: AgentEvent[] = [];
    for await (const event of runner.run('budget regression', {})) events.push(event);

    expect(events).toEqual([
      {
        type: 'cost_update',
        costUsd: 0.06,
        tokensUsed: { inputTokens: 10, outputTokens: 6 },
      },
      {
        type: 'error',
        code: 'budget_exceeded',
        message: 'Budget exceeded: cumulative cost $0.0600 >= $0.05 limit. Aborting.',
      },
    ]);
  });

  it('emits a structured reroute request with rolling projections', async () => {
    const runner = wrapRunner(
      createRunner('claude-code', [
        [
          {
            type: 'cost_update',
            costUsd: 0.03,
            tokensUsed: { inputTokens: 8, outputTokens: 4 },
          },
          {
            type: 'result',
            output: 'baseline',
            usage: { inputTokens: 8, outputTokens: 4 },
            costUsd: 0.03,
            durationMs: 40,
          },
        ],
        [
          {
            type: 'cost_update',
            costUsd: 0.07,
            tokensUsed: { inputTokens: 16, outputTokens: 8 },
          },
        ],
      ]),
      budgetMiddleware({
        maxCostUsd: 0.05,
        action: 'fallback_tier',
        downgradeTo: 'cheap',
        hysteresisPct: 0,
        rollingWindow: 4,
        cooldownAttempts: 1,
      }),
    );

    const opts: RunOptions = {};
    const firstAttempt: AgentEvent[] = [];
    for await (const event of runner.run('attempt one', opts)) firstAttempt.push(event);
    const secondAttempt: AgentEvent[] = [];
    for await (const event of runner.run('attempt two', opts)) secondAttempt.push(event);

    expect(firstAttempt.map((event) => event.type)).toEqual(['cost_update', 'result']);
    const rerouteEvent = secondAttempt.find((event) => event.type === 'error' && event.code === 'budget_reroute_requested');
    expect(rerouteEvent).toMatchObject({
      type: 'error',
      code: 'budget_reroute_requested',
      reroute: {
        reason: 'cost',
        fromEngine: 'claude-code',
        targetTier: 'cheap',
        threshold: 0.05,
        observed: 0.07,
        projection: {
          confidence: 'low',
          costUsd: {
            sampleCount: 2,
          },
        },
      },
    });
  });

  it('suppresses immediate repeat reroutes while cooldown is active', async () => {
    const runner = wrapRunner(
      createRunner('claude-code', [
        [
          {
            type: 'cost_update',
            costUsd: 0.08,
            tokensUsed: { inputTokens: 10, outputTokens: 10 },
          },
        ],
        [
          {
            type: 'cost_update',
            costUsd: 0.09,
            tokensUsed: { inputTokens: 12, outputTokens: 9 },
          },
        ],
      ]),
      budgetMiddleware({
        maxCostUsd: 0.05,
        action: 'fallback_tier',
        downgradeTo: 'cheap',
        hysteresisPct: 0,
        cooldownAttempts: 2,
      }),
    );

    const opts: RunOptions = {};
    const firstAttempt: AgentEvent[] = [];
    for await (const event of runner.run('attempt one', opts)) firstAttempt.push(event);
    const secondAttempt: AgentEvent[] = [];
    for await (const event of runner.run('attempt two', opts)) secondAttempt.push(event);

    expect(firstAttempt.find((event) => event.type === 'error' && event.code === 'budget_reroute_requested')).toBeDefined();
    expect(secondAttempt.find((event) => event.type === 'error' && event.code === 'budget_reroute_blocked')).toMatchObject({
      type: 'error',
      code: 'budget_reroute_blocked',
      reroute: {
        cooldownRemaining: 2,
      },
    });
  });

  it('uses rolling error-rate projections to request a reroute after repeated failures', async () => {
    const runner = wrapRunner(
      createRunner('claude-code', [
        [{ type: 'error', message: 'attempt failed' }],
        [{ type: 'error', message: 'attempt failed again' }],
        [{ type: 'text', content: 'still unstable' }],
      ]),
      budgetMiddleware({
        maxCostUsd: 10,
        maxErrorRate: 0.5,
        action: 'fallback_tier',
        downgradeTo: 'cheap',
        hysteresisPct: 0,
        minimumSamples: 3,
      }),
    );

    const opts: RunOptions = {};
    for await (const _event of runner.run('attempt one', opts)) { /* consume */ }
    for await (const _event of runner.run('attempt two', opts)) { /* consume */ }

    const thirdAttempt: AgentEvent[] = [];
    for await (const event of runner.run('attempt three', opts)) thirdAttempt.push(event);

    expect(thirdAttempt.find((event) => event.type === 'error' && event.code === 'budget_reroute_requested')).toMatchObject({
      type: 'error',
      code: 'budget_reroute_requested',
      reroute: {
        reason: 'error_rate',
        projection: {
          errorRate: {
            sampleCount: 3,
          },
        },
      },
    });
  });
});
