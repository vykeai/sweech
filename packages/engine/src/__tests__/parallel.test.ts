import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runParallel } from '../parallel.js';
import type { ModelRunner, AgentEvent, RunOptions } from '../types.js';

function makeResult(output: string, costUsd: number, durationMs = 100): AgentEvent[] {
  return [
    { type: 'text', content: output },
    { type: 'result', output, usage: { inputTokens: 10, outputTokens: 20 }, costUsd, durationMs },
  ];
}

function mockRunner(engine: string, events: AgentEvent[], delayMs = 0): ModelRunner {
  return {
    engine: engine as ModelRunner['engine'],
    isAvailable: async () => true,
    async *run(_prompt: string, _opts: RunOptions): AsyncGenerator<AgentEvent> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      for (const event of events) yield event;
    },
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('runParallel', () => {
  describe('race strategy', () => {
    it('returns the first complete response and emits race metadata', async () => {
      const fast = mockRunner('claude-code', makeResult('fast answer', 0.01), 10);
      const slow = mockRunner('codex',       makeResult('slow answer', 0.001), 200);

      const start = Date.now();
      const events = await collectEvents(runParallel([fast, slow], 'q', {}, 'race'));
      const elapsed = Date.now() - start;

      // Should finish well before slow runner would
      expect(elapsed).toBeLessThan(150);

      const resultEvent = events.find((e) => e.type === 'result');
      expect(resultEvent).toBeDefined();
      expect((resultEvent as Extract<AgentEvent, { type: 'result' }>).output).toBe('fast answer');

      const metaEvent = events.find(
        (e) => e.type === 'text' && (e as Extract<AgentEvent, { type: 'text' }>).content.includes('[parallel:race]'),
      );
      expect(metaEvent).toBeDefined();
    });

    it('reports winner engine in metadata', async () => {
      const r1 = mockRunner('claude-code', makeResult('a', 0.05), 0);
      const r2 = mockRunner('codex',       makeResult('b', 0.01), 100);

      const events = await collectEvents(runParallel([r1, r2], 'q', {}, 'race'));
      const meta = events.find(
        (e): e is Extract<AgentEvent, { type: 'text' }> =>
          e.type === 'text' && e.content.includes('[parallel:race]'),
      );
      expect(meta?.content).toContain('claude-code');
    });
  });

  describe('cheapest strategy', () => {
    it('returns the result from the cheapest model', async () => {
      const pricey = mockRunner('claude-code', makeResult('expensive', 0.10));
      const cheap  = mockRunner('codex',       makeResult('cheap',     0.01));
      const mid    = mockRunner('pi-mono',     makeResult('mid',       0.05));

      const events = await collectEvents(runParallel([pricey, cheap, mid], 'q', {}, 'cheapest'));

      const resultEvent = events.find((e) => e.type === 'result') as Extract<AgentEvent, { type: 'result' }>;
      expect(resultEvent?.output).toBe('cheap');

      const meta = events.find(
        (e): e is Extract<AgentEvent, { type: 'text' }> =>
          e.type === 'text' && e.content.includes('[parallel:cheapest]'),
      );
      expect(meta?.content).toContain('codex');
      expect(meta?.content).toContain('0.010000');
    });

    it('handles a runner failure gracefully — picks cheapest from remaining', async () => {
      const failing = {
        engine: 'goose' as ModelRunner['engine'],
        isAvailable: async () => true,
        async *run(): AsyncGenerator<AgentEvent> { throw new Error('runner down'); },
      };
      const ok = mockRunner('claude-code', makeResult('ok', 0.02));

      const events = await collectEvents(runParallel([failing, ok], 'q', {}, 'cheapest'));
      const result = events.find((e) => e.type === 'result') as Extract<AgentEvent, { type: 'result' }>;
      expect(result?.output).toBe('ok');
    });
  });

  describe('consensus strategy', () => {
    it('picks the majority output', async () => {
      const r1 = mockRunner('claude-code', makeResult('Paris', 0.05));
      const r2 = mockRunner('codex',       makeResult('Paris', 0.01));
      const r3 = mockRunner('pi-mono',     makeResult('London', 0.03));

      const events = await collectEvents(runParallel([r1, r2, r3], 'q', {}, 'consensus'));

      const result = events.find((e) => e.type === 'result') as Extract<AgentEvent, { type: 'result' }>;
      expect(result?.output).toBe('Paris');

      const meta = events.find(
        (e): e is Extract<AgentEvent, { type: 'text' }> =>
          e.type === 'text' && e.content.includes('[parallel:consensus]'),
      );
      expect(meta?.content).toContain('2/3');
    });

    it('falls back to first runner when no majority', async () => {
      const r1 = mockRunner('claude-code', makeResult('A', 0.05));
      const r2 = mockRunner('codex',       makeResult('B', 0.01));

      const events = await collectEvents(runParallel([r1, r2], 'q', {}, 'consensus'));
      const result = events.find((e) => e.type === 'result') as Extract<AgentEvent, { type: 'result' }>;
      // First runner's output returned when tied
      expect(result?.output).toBe('A');
    });
  });

  describe('edge cases', () => {
    it('passes through single runner unchanged', async () => {
      const r = mockRunner('claude-code', makeResult('direct', 0.01));
      const events = await collectEvents(runParallel([r], 'q', {}, 'race'));
      const result = events.find((e) => e.type === 'result') as Extract<AgentEvent, { type: 'result' }>;
      expect(result?.output).toBe('direct');
      // No meta event for single runner
      expect(events.every((e) => e.type !== 'text' || !(e as Extract<AgentEvent, { type: 'text' }>).content.includes('[parallel:'))).toBe(true);
    });

    it('throws when called with empty runners array', async () => {
      await expect(collectEvents(runParallel([], 'q', {}, 'race'))).rejects.toThrow('at least one runner');
    });

    it('emits error event when all runners fail (cheapest)', async () => {
      const failing = (id: string) => ({
        engine: id as ModelRunner['engine'],
        isAvailable: async () => true,
        async *run(): AsyncGenerator<AgentEvent> { throw new Error('down'); },
      });

      const events = await collectEvents(runParallel([failing('goose'), failing('opencode')], 'q', {}, 'cheapest'));
      expect(events.some((e) => e.type === 'error')).toBe(true);
    });
  });
});
