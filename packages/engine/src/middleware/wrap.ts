import type { AgentEvent, ModelRunner, RunOptions } from '../types.js';
import type { Middleware } from './types.js';

export function wrapRunner(runner: ModelRunner, ...middlewares: Middleware[]): ModelRunner {
  if (middlewares.length === 0) return runner;

  return {
    engine: runner.engine,
    isAvailable: () => runner.isAvailable(),
    run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
      const chain = middlewares.reduceRight<(p: string, o: RunOptions) => AsyncGenerator<AgentEvent>>(
        (next, mw) => (p, o) => mw(runner, p, o, next),
        (p, o) => runner.run(p, o),
      );
      return chain(prompt, opts);
    },
  };
}
