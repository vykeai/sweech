import type { AgentEvent, ModelRunner, RunOptions, TokenUsage, EngineId } from '../types.js';
import { estimateCost } from '../pricing.js';
import type { CostAccumulator, Middleware } from './types.js';

export function createCostAccumulator(): CostAccumulator {
  return {
    totalCost: 0,
    runs: [],
    add(engine: EngineId, model: string | undefined, cost: number, usage: TokenUsage) {
      this.totalCost += cost;
      this.runs.push({ engine, model, cost, usage });
    },
  };
}

export const costMiddleware: Middleware = async function* (runner, prompt, opts, next) {
  const model = opts.model ?? '';
  const accumulator = opts.costAccumulator as CostAccumulator | undefined;

  for await (const event of next(prompt, opts)) {
    if (event.type === 'result' && event.costUsd === 0 && (event.usage.inputTokens > 0 || event.usage.outputTokens > 0)) {
      const estimated = estimateCost(event.usage, model);
      const patched = { ...event, costUsd: estimated };
      accumulator?.add(runner.engine, model, estimated, event.usage);
      yield patched;
    } else {
      if (event.type === 'result' && accumulator) {
        accumulator.add(runner.engine, model, event.costUsd, event.usage);
      }
      yield event;
    }
  }
};
