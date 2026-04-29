import { describe, it, expect } from 'vitest';
import { wrapRunner } from '../../middleware/wrap.js';
import type { ModelRunner, AgentEvent, RunOptions } from '../../types.js';
import type { Middleware } from '../../middleware/types.js';

function mockRunner(events: AgentEvent[]): ModelRunner {
  return {
    engine: 'claude-code',
    isAvailable: async () => true,
    async *run() {
      for (const e of events) yield e;
    },
  };
}

describe('wrapRunner', () => {
  it('passes through when no middleware', async () => {
    const events: AgentEvent[] = [{ type: 'text', content: 'hello' }];
    const runner = wrapRunner(mockRunner(events));
    const collected: AgentEvent[] = [];
    for await (const e of runner.run('test', {})) collected.push(e);
    expect(collected).toEqual(events);
  });

  it('applies middleware in order', async () => {
    const log: string[] = [];
    const mw1: Middleware = async function* (r, p, o, next) {
      log.push('mw1-before');
      yield* next(p, o);
      log.push('mw1-after');
    };
    const mw2: Middleware = async function* (r, p, o, next) {
      log.push('mw2-before');
      yield* next(p, o);
      log.push('mw2-after');
    };

    const runner = wrapRunner(mockRunner([{ type: 'text', content: 'x' }]), mw1, mw2);
    const collected: AgentEvent[] = [];
    for await (const e of runner.run('test', {})) collected.push(e);

    expect(log).toEqual(['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after']);
  });

  it('preserves engine identity', () => {
    const runner = wrapRunner(mockRunner([]), async function* (r, p, o, next) { yield* next(p, o); });
    expect(runner.engine).toBe('claude-code');
  });
});
