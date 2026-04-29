import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { ClaudeRunner } from '../../runner/claude.js';

function makeMockQuery(messages: any[]) {
  return (async function* () {
    for (const msg of messages) yield msg;
  })();
}

describe('ClaudeRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses SDK messages into typed events', async () => {
    const messages = [
      {
        type: 'assistant',
        session_id: 'sess-1',
        message: {
          content: [
            { type: 'text', text: 'hello' },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        result: 'done',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    ];

    mockQuery.mockReturnValueOnce(makeMockQuery(messages));

    const runner = new ClaudeRunner('/usr/local/bin/claude');
    const events = [];
    for await (const event of runner.run('test prompt', { cwd: '/tmp' })) {
      events.push(event);
    }

    // assistant text yields 1 event, result is tracked internally, then final result yielded
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('text');
    expect((events[0] as any).content).toBe('hello');
    expect(events[1].type).toBe('result');
    expect((events[1] as any).output).toBe('done');
    expect((events[1] as any).costUsd).toBe(0.01);
  });

  it('yields error event on result error', async () => {
    const messages = [
      {
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sess-1',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        errors: ['something went wrong'],
      },
    ];

    mockQuery.mockReturnValueOnce(makeMockQuery(messages));

    const runner = new ClaudeRunner('/usr/local/bin/claude');
    const events = [];
    for await (const event of runner.run('test', { cwd: '/tmp' })) {
      events.push(event);
    }

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent as any).message).toContain('something went wrong');
  });

  it('yields tool_use events from assistant messages', async () => {
    const messages = [
      {
        type: 'assistant',
        session_id: 'sess-1',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' }, id: 'tu-1' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        result: 'ok',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];

    mockQuery.mockReturnValueOnce(makeMockQuery(messages));

    const runner = new ClaudeRunner('/usr/local/bin/claude');
    const events = [];
    for await (const event of runner.run('test', { cwd: '/tmp' })) {
      events.push(event);
    }

    const toolEvent = events.find(e => e.type === 'tool_use');
    expect(toolEvent).toBeDefined();
    expect((toolEvent as any).name).toBe('Read');
  });

  it('yields multiple blocks from a single assistant message', async () => {
    const messages = [
      {
        type: 'assistant',
        session_id: 'sess-1',
        message: {
          content: [
            { type: 'thinking', thinking: 'let me think...' },
            { type: 'text', text: 'here is the answer' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'tu-1' },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        result: 'done',
        total_cost_usd: 0.05,
        usage: { input_tokens: 50, output_tokens: 100 },
      },
    ];

    mockQuery.mockReturnValueOnce(makeMockQuery(messages));

    const runner = new ClaudeRunner('/usr/local/bin/claude');
    const events = [];
    for await (const event of runner.run('test', { cwd: '/tmp' })) {
      events.push(event);
    }

    // 3 content blocks + 1 final result
    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('thinking');
    expect(events[1].type).toBe('text');
    expect(events[2].type).toBe('tool_use');
    expect(events[3].type).toBe('result');
  });
});
