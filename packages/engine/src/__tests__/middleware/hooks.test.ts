import { describe, expect, it } from 'vitest';
import { wrapRunner } from '../../middleware/wrap.js';
import { hooksMiddleware } from '../../middleware/hooks.js';
import type { AgentEvent, FnHook, ModelRunner } from '../../types.js';

function createRunner(events: AgentEvent[]): ModelRunner {
  return {
    engine: 'qwen-code',
    async isAvailable() {
      return true;
    },
    async *run() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('hooksMiddleware', () => {
  it('executes pre-tool hooks for matching tool names', async () => {
    const capturedPayload: Array<Record<string, unknown>> = [];
    const hook: FnHook = async (input, _toolUseId, { signal }) => {
      capturedPayload.push(input as Record<string, unknown>);
      expect(signal).toBeTruthy();
      return {};
    };

    const runner = wrapRunner(
      createRunner([
        { type: 'tool_use', name: 'read', input: { path: '/tmp' } },
        { type: 'result', output: 'done', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, durationMs: 1 },
      ]),
      hooksMiddleware,
    );

    const events: AgentEvent[] = [];
    for await (const event of runner.run('prompt', {
      hooks: {
        PreToolUse: [{ matcher: 'read', hooks: [hook] }],
      },
    })) {
      events.push(event);
    }

    expect(capturedPayload).toHaveLength(1);
    expect(capturedPayload[0]).toMatchObject({ tool_name: 'read', tool_input: { path: '/tmp' } });
    expect(events[0]).toMatchObject({ type: 'tool_use', name: 'read' });
  });

  it('emits recoverable hook_error events and keeps stream flowing', async () => {
    const recoverableHook: FnHook = async () => {
      throw { code: 'hook_skip', message: 'Tool hook intentionally skipped' };
    };

    const runner = wrapRunner(
      createRunner([
        { type: 'tool_use', name: 'read', input: { path: '/tmp' } },
        { type: 'result', output: 'done', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, durationMs: 1 },
      ]),
      hooksMiddleware,
    );

    const events: AgentEvent[] = [];
    for await (const event of runner.run('prompt', {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [recoverableHook] }],
      },
    })) {
      events.push(event);
    }

    const hookError = events.find((event) => event.type === 'hook_error');
    expect(hookError).toBeDefined();
    expect(hookError).toMatchObject({ type: 'hook_error', recoverable: true, code: 'hook_skip' });
    expect(hookError).toHaveProperty('hookId', 'PreToolUse:*:0');
    expect(events[events.length - 1]).toMatchObject({ type: 'result' });
  });

  it('throws on non-recoverable hook errors after emitting hook_error', async () => {
    const fatalHook: FnHook = async () => {
      throw new Error('fatal hook');
    };

    const runner = wrapRunner(
      createRunner([
        { type: 'tool_use', name: 'read', input: { path: '/tmp' } },
        { type: 'tool_result', name: 'read', content: 'ok', isError: false },
        { type: 'result', output: 'done', usage: { inputTokens: 2, outputTokens: 2 }, costUsd: 0, durationMs: 1 },
      ]),
      hooksMiddleware,
    );

    const events: AgentEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of runner.run('prompt', {
        hooks: {
          PostToolUse: [{ matcher: 'read', hooks: [fatalHook] }],
        },
      })) {
        events.push(event);
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const hookError = events.find((event) => event.type === 'hook_error');
    expect(hookError).toBeDefined();
    expect(hookError).toMatchObject({ type: 'hook_error', recoverable: false });
    expect(hookError).toHaveProperty('hookId', 'PostToolUse:read:0');
    expect(events.some((event) => event.type === 'result')).toBe(false);
  });

  it('aborts hook execution when upstream signal is aborted', async () => {
    const longRunningHook: FnHook = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return {};
    };

    const controller = new AbortController();
    const runner = wrapRunner(
      createRunner([
        { type: 'tool_use', name: 'read', input: { path: '/tmp' } },
        { type: 'result', output: 'done', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, durationMs: 1 },
      ]),
      hooksMiddleware,
    );
    controller.abort({ code: 'abort', message: 'user-cancelled' });

    const events: AgentEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of runner.run('prompt', {
        hooks: {
          PreToolUse: [{ matcher: 'read', hooks: [longRunningHook] }],
        },
        abortSignal: controller.signal,
      })) {
        events.push(event);
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const hookError = events.find((event) => event.type === 'hook_error');
    expect(hookError).toBeDefined();
    expect(hookError).toMatchObject({ type: 'hook_error', recoverable: false, code: 'abort' });
    expect(hookError).toHaveProperty('hookId', 'PreToolUse:read:0');
  });
});
