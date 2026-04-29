import { describe, it, expect } from 'vitest';
import { costMiddleware, createCostAccumulator } from '../../middleware/cost.js';
import { wrapRunner } from '../../middleware/wrap.js';
import type { ModelRunner, AgentEvent } from '../../types.js';

function mockRunner(events: AgentEvent[]): ModelRunner {
  return {
    engine: 'qwen-code',
    isAvailable: async () => true,
    async *run() { for (const e of events) yield e; },
  };
}

describe('costMiddleware', () => {
  it('estimates cost when costUsd is 0 and tokens present', async () => {
    const runner = wrapRunner(
      mockRunner([{ type: 'result', output: 'done', usage: { inputTokens: 1000, outputTokens: 500 }, costUsd: 0, durationMs: 100 }]),
      costMiddleware,
    );
    const events: AgentEvent[] = [];
    for await (const e of runner.run('test', { model: 'gpt-4o' })) events.push(e);

    const result = events.find(e => e.type === 'result');
    expect(result?.type === 'result' && result.costUsd).toBeGreaterThan(0);
  });

  it('passes through non-zero cost', async () => {
    const runner = wrapRunner(
      mockRunner([{ type: 'result', output: 'done', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.5, durationMs: 100 }]),
      costMiddleware,
    );
    const events: AgentEvent[] = [];
    for await (const e of runner.run('test', { model: 'gpt-4o' })) events.push(e);

    const result = events.find(e => e.type === 'result');
    expect(result?.type === 'result' && result.costUsd).toBe(0.5);
  });

  it('accumulates cost across runs', async () => {
    const acc = createCostAccumulator();
    const runner = wrapRunner(
      mockRunner([{ type: 'result', output: 'done', usage: { inputTokens: 1000, outputTokens: 500 }, costUsd: 0.1, durationMs: 100 }]),
      costMiddleware,
    );
    for await (const _ of runner.run('test', { model: 'gpt-4o', costAccumulator: acc } as any)) {}
    expect(acc.totalCost).toBe(0.1);
    expect(acc.runs).toHaveLength(1);
  });
});
