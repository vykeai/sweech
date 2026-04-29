import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapRunner } from '../../middleware/wrap.js';
import { toolTimingMiddleware } from '../../middleware/tools.js';
import type { AgentEvent, ModelRunner } from '../../types.js';

describe('toolTimingMiddleware', () => {
  let now = 1000;

  beforeEach(() => {
    now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 3;
      return now;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createRunner(events: AgentEvent[]): ModelRunner {
    return {
      engine: 'claude-code',
      isAvailable: async () => true,
      async *run() {
        for (const event of events) {
          yield event;
        }
      },
    };
  }

  it('keeps timing distinct for same-name tool calls with explicit IDs', async () => {
    const runner = wrapRunner(
      createRunner([
        { type: 'tool_use', name: 'read', input: {}, id: 'a' } as AgentEvent,
        { type: 'tool_use', name: 'read', input: {}, id: 'b' } as AgentEvent,
        { type: 'tool_result', name: 'read', content: 'done-b', isError: false, id: 'b' } as AgentEvent,
        { type: 'tool_result', name: 'read', content: 'done-a', isError: false, id: 'a' } as AgentEvent,
      ]),
      toolTimingMiddleware,
    );

    const collected: AgentEvent[] = [];
    for await (const event of runner.run('prompt', {})) {
      collected.push(event);
    }

    const results = collected.filter((event): event is AgentEvent & { startedAt: number; durationMs: number } =>
      event.type === 'tool_result',
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ type: 'tool_result', content: 'done-b', startedAt: 1006 });
    expect(results[0].durationMs).toBe(3);
    expect(results[1]).toMatchObject({ type: 'tool_result', content: 'done-a', startedAt: 1003 });
    expect(results[1].durationMs).toBe(9);
  });

  it('keeps timing distinct for concurrent same-name calls without IDs using FIFO fallback', async () => {
    const runner = wrapRunner(
      createRunner([
        { type: 'tool_use', name: 'search', input: {} } as AgentEvent,
        { type: 'tool_use', name: 'search', input: {} } as AgentEvent,
        { type: 'tool_result', name: 'search', content: 'first', isError: false } as AgentEvent,
        { type: 'tool_result', name: 'search', content: 'second', isError: false } as AgentEvent,
      ]),
      toolTimingMiddleware,
    );

    const collected: AgentEvent[] = [];
    for await (const event of runner.run('prompt', {})) {
      collected.push(event);
    }

    const results = collected.filter((event): event is AgentEvent & { startedAt: number; durationMs: number } =>
      event.type === 'tool_result',
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ type: 'tool_result', content: 'first', startedAt: 1003 });
    expect(results[1]).toMatchObject({ type: 'tool_result', content: 'second', startedAt: 1006 });
    expect(results[0].durationMs).toBe(6);
    expect(results[1].durationMs).toBe(6);
  });

  it('does not break normal non-tool events', async () => {
    const runner = wrapRunner(
      createRunner([{ type: 'text', content: 'hello' }, { type: 'result', output: 'done', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, durationMs: 4 }]),
      toolTimingMiddleware,
    );

    const collected: AgentEvent[] = [];
    for await (const event of runner.run('prompt', {})) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ type: 'text', content: 'hello' });
    expect(collected[1]).toMatchObject({ type: 'result', output: 'done' });
  });

  it('attaches audit records to allowed tool events', async () => {
    const audits = [];
    const runner = wrapRunner(
      createRunner([
        { type: 'tool_use', name: 'exec_command', input: { cmd: 'pwd' }, id: 'safe' } as AgentEvent,
        { type: 'tool_result', name: 'exec_command', content: '/tmp', isError: false, id: 'safe' } as AgentEvent,
      ]),
      toolTimingMiddleware,
    );

    const collected: AgentEvent[] = [];
    for await (const event of runner.run('prompt', {
      toolPolicy: {
        policyId: 'tools-test',
        actor: 'unit-test',
        auditSink: (record) => audits.push(record),
      },
    })) {
      collected.push(event);
    }

    expect(collected[0]).toMatchObject({
      type: 'tool_use',
      name: 'exec_command',
      policyAudit: {
        decision: 'allow',
        intent: 'exec',
        policyId: 'tools-test',
      },
    });
    expect(collected[1]).toMatchObject({
      type: 'tool_result',
      content: '/tmp',
      policyAudit: {
        decision: 'allow',
        toolName: 'exec_command',
      },
    });
    expect(audits).toHaveLength(1);
  });

  it('blocks dangerous shell-like tool commands and suppresses their results', async () => {
    const audits = [];
    const runner = wrapRunner(
      createRunner([
        { type: 'tool_use', name: 'exec_command', input: { cmd: 'cat README.md; rm -rf /' }, id: 'blocked' } as AgentEvent,
        { type: 'tool_result', name: 'exec_command', content: 'should not surface', isError: false, id: 'blocked' } as AgentEvent,
      ]),
      toolTimingMiddleware,
    );

    const collected: AgentEvent[] = [];
    for await (const event of runner.run('prompt', {
      toolPolicy: {
        policyId: 'tools-test',
        actor: 'unit-test',
        auditSink: (record) => audits.push(record),
      },
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: 'error',
      code: 'tool_policy_denied',
      policyAudit: {
        decision: 'deny',
        intent: 'exec',
        requiresApproval: true,
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ decision: 'deny', toolName: 'exec_command' });
  });
});
