import { describe, it, expect } from 'vitest';
import { fallbackMiddleware } from '../../middleware/fallback.js';
import { wrapRunner } from '../../middleware/wrap.js';
import type { ModelRunner, AgentEvent } from '../../types.js';

function failingRunner(engine: string, errorMsg: string): ModelRunner {
  return {
    engine: engine as any,
    isAvailable: async () => true,
    async *run() {
      yield { type: 'error', message: errorMsg } as AgentEvent;
    },
  };
}

function okRunner(engine: string): ModelRunner {
  return {
    engine: engine as any,
    isAvailable: async () => true,
    async *run() {
      yield { type: 'text', content: 'ok' } as AgentEvent;
      yield { type: 'result', output: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0, durationMs: 50 } as AgentEvent;
    },
  };
}

describe('fallbackMiddleware', () => {
  it('is a no-op when managedBy is consumer', async () => {
    const runner = wrapRunner(
      failingRunner('claude-code', 'ECONNREFUSED'),
      fallbackMiddleware({ managedBy: 'consumer', maxRetries: 2 }),
    );
    const events: AgentEvent[] = [];
    for await (const e of runner.run('test', {})) events.push(e);
    // Error passes through — no retry
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });

  it('retries on network error when managedBy is omnai', async () => {
    let callCount = 0;
    const flaky: ModelRunner = {
      engine: 'pi-mono',
      isAvailable: async () => true,
      async *run() {
        callCount++;
        if (callCount === 1) {
          yield { type: 'error', message: 'ECONNREFUSED' } as AgentEvent;
        } else {
          yield { type: 'text', content: 'ok' } as AgentEvent;
          yield { type: 'result', output: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0, durationMs: 50 } as AgentEvent;
        }
      },
    };

    const runner = wrapRunner(
      flaky,
      fallbackMiddleware({ managedBy: 'omnai', maxRetries: 2, delayMs: 10 }),
    );
    const events: AgentEvent[] = [];
    for await (const e of runner.run('test', {})) events.push(e);

    const results = events.filter(e => e.type === 'result');
    const retryNotice = events.find((event) => event.type === 'error' && event.code === 'retry_scheduled');
    expect(results).toHaveLength(1);
    expect(callCount).toBe(2);
    expect(retryNotice).toMatchObject({
      type: 'error',
      retry: {
        classification: 'infra',
        attempt: 1,
      },
    });
  });

  it('falls back to alternate engine', async () => {
    const backup = okRunner('qwen-code');
    const runner = wrapRunner(
      failingRunner('claude-code', 'ECONNREFUSED'),
      fallbackMiddleware(
        { managedBy: 'omnai', maxRetries: 1, engines: ['qwen-code'], delayMs: 10 },
        (id) => id === 'qwen-code' ? backup : undefined,
      ),
    );
    const events: AgentEvent[] = [];
    for await (const e of runner.run('test', {})) events.push(e);

    const results = events.filter(e => e.type === 'result');
    expect(results).toHaveLength(1);
  });

  it('schedules a tier reroute when budget middleware requests it', async () => {
    const events: AgentEvent[] = [];
    const rerouteRequest: AgentEvent = {
      type: 'error',
      code: 'budget_reroute_requested',
      message: 'reroute',
      reroute: {
        reason: 'cost',
        attempt: 1,
        fromEngine: 'claude-code',
        toEngine: 'qwen-code',
        threshold: 0.05,
        observed: 0.2,
        hysteresisPct: 0.1,
        cooldownAttempts: 1,
        cooldownRemaining: 0,
        projection: {
          costUsd: { mean: 0.2, lowerBound: 0.2, upperBound: 0.2, sampleCount: 1 },
          latencyMs: { mean: 50, lowerBound: 50, upperBound: 50, sampleCount: 1 },
          errorRate: { mean: 1, lowerBound: 1, upperBound: 1, sampleCount: 1 },
          confidence: 'low',
        },
        avoidEngines: ['claude-code'],
      },
    };
    const wrapped = wrapRunner(
      {
        engine: 'claude-code',
        isAvailable: async () => true,
        async *run() {
          yield { type: 'cost_update', costUsd: 0.2, tokensUsed: { inputTokens: 20, outputTokens: 10 } } as AgentEvent;
          yield rerouteRequest;
        },
      },
      fallbackMiddleware(undefined, (engine) => engine === 'qwen-code' ? okRunner('qwen-code') : undefined),
    );

    for await (const event of wrapped.run('prompt', {})) events.push(event);

    expect(events.find((event) => event.type === 'error' && event.code === 'reroute_scheduled')).toMatchObject({
      type: 'error',
      code: 'reroute_scheduled',
      reroute: {
        fromEngine: 'claude-code',
        toEngine: 'qwen-code',
      },
    });
    expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
  });

  it('emits a terminal error when a reroute target cannot be resolved', async () => {
    const events: AgentEvent[] = [];
    const wrapped = wrapRunner(
      {
        engine: 'claude-code',
        isAvailable: async () => true,
        async *run() {
          yield {
            type: 'error',
            code: 'budget_reroute_requested',
            message: 'reroute',
            reroute: {
              reason: 'cost',
              attempt: 1,
              fromEngine: 'claude-code',
              targetTier: 'missing-tier',
              threshold: 0.05,
              observed: 0.2,
              hysteresisPct: 0.1,
              cooldownAttempts: 1,
              cooldownRemaining: 0,
              projection: {
                costUsd: { mean: 0.2, lowerBound: 0.2, upperBound: 0.2, sampleCount: 1 },
                latencyMs: { mean: 50, lowerBound: 50, upperBound: 50, sampleCount: 1 },
                errorRate: { mean: 1, lowerBound: 1, upperBound: 1, sampleCount: 1 },
                confidence: 'low',
              },
              avoidEngines: ['claude-code'],
            },
          } as AgentEvent;
        },
      },
      fallbackMiddleware(undefined, () => undefined),
    );

    for await (const event of wrapped.run('prompt', {})) events.push(event);

    expect(events).toEqual([
      {
        type: 'error',
        code: 'budget_reroute_unavailable',
        message: '[omnai reroute cost] no alternate engine available for tier "missing-tier".',
        reroute: {
          reason: 'cost',
          attempt: 1,
          fromEngine: 'claude-code',
          targetTier: 'missing-tier',
          threshold: 0.05,
          observed: 0.2,
          hysteresisPct: 0.1,
          cooldownAttempts: 1,
          cooldownRemaining: 0,
          projection: {
            costUsd: { mean: 0.2, lowerBound: 0.2, upperBound: 0.2, sampleCount: 1 },
            latencyMs: { mean: 50, lowerBound: 50, upperBound: 50, sampleCount: 1 },
            errorRate: { mean: 1, lowerBound: 1, upperBound: 1, sampleCount: 1 },
            confidence: 'low',
          },
          avoidEngines: ['claude-code'],
        },
      },
    ]);
  });

  it('does not retry auth failures', async () => {
    let callCount = 0;
    const runner = wrapRunner(
      {
        engine: 'claude-code',
        isAvailable: async () => true,
        async *run() {
          callCount++;
          yield { type: 'error', message: '401 Unauthorized' } as AgentEvent;
        },
      },
      fallbackMiddleware({ managedBy: 'omnai', maxRetries: 3, delayMs: 0 }),
    );

    const events: AgentEvent[] = [];
    for await (const event of runner.run('prompt', {})) events.push(event);

    expect(callCount).toBe(1);
    expect(events).toEqual([{ type: 'error', message: '401 Unauthorized' }]);
  });

  it('does not retry unsafe tool failures unless explicitly enabled', async () => {
    let callCount = 0;
    const runner = wrapRunner(
      {
        engine: 'claude-code',
        isAvailable: async () => true,
        async *run() {
          callCount++;
          yield { type: 'tool_result', name: 'exec_command', content: 'tool failed', isError: true } as AgentEvent;
        },
      },
      fallbackMiddleware({
        managedBy: 'omnai',
        safeToRetryTools: false,
        retryClasses: {
          tool: { maxAttempts: 2, retriable: true },
        },
      }),
    );

    const events: AgentEvent[] = [];
    for await (const event of runner.run('prompt', {})) events.push(event);

    expect(callCount).toBe(1);
    expect(events).toEqual([{ type: 'tool_result', name: 'exec_command', content: 'tool failed', isError: true }]);
  });
});
