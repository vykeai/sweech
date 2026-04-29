import type { AgentEvent, RunOptions, ModelRunner } from '../types.js';
import { estimateCost } from '../pricing.js';
import type { Middleware } from './types.js';

export type ProgressEvent = { type: 'progress'; tokensGenerated: number; estimatedTotal?: number; percentComplete?: number };
export type CostUpdateEvent = { type: 'cost_update'; costUsd: number; tokensUsed: { inputTokens: number; outputTokens: number } };

const PROGRESS_INTERVAL = 50; // emit every N estimated tokens

export const streamingMiddleware: Middleware = async function* (runner, prompt, opts, next) {
  let charCount = 0;
  let lastEmitted = 0;
  const model = opts.model ?? '';

  for await (const event of next(prompt, opts)) {
    yield event;

    if (event.type === 'text') {
      charCount += event.content.length;
      const estimatedTokens = Math.floor(charCount / 4);

      if (estimatedTokens - lastEmitted >= PROGRESS_INTERVAL) {
        lastEmitted = estimatedTokens;
        yield {
          type: 'progress',
          tokensGenerated: estimatedTokens,
        } as unknown as AgentEvent;
      }
    }

    if (event.type === 'result') {
      const cost = event.costUsd || estimateCost(event.usage, model);
      yield {
        type: 'cost_update',
        costUsd: cost,
        tokensUsed: { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens },
      } as unknown as AgentEvent;
    }
  }
};
