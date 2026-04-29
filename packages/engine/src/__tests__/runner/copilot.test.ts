import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotRunner } from '../../runner/copilot.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';

const mockExeca = vi.mocked(execa);

function createStream(lines: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        yield line;
      }
    },
  };
}

function mockCopilotProcess(stdout: string[], stderr: string[]) {
  return {
    stdout: createStream(stdout),
    stderr: createStream(stderr),
    exitCode: 0,
  };
}

describe('CopilotRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges stdout and stderr streams into a single event flow', async () => {
    mockExeca.mockReturnValueOnce(
      mockCopilotProcess(
        [
          '{"type":"assistant.message_delta","data":{"deltaContent":"Hello "}}\n',
          '{"type":"assistant.message","data":{"outputTokens":5}}\n',
          '{"type":"result","sessionId":"session-1","usage":{"totalApiDurationMs":240}}\n',
        ],
        [
          '{"type":"assistant.message_delta","data":{"deltaContent":"copilot"}}\n',
        ],
      ) as any,
    );

    const runner = new CopilotRunner('/bin/copilot');
    const events = [];
    for await (const event of runner.run('hello', {})) {
      events.push(event);
    }

    const textEvents = events.filter(event => event.type === 'text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].type === 'text' && textEvents[0].content).toBe('Hello ');
    expect(textEvents[1].type === 'text' && textEvents[1].content).toBe('copilot');

    const result = events.find(event => event.type === 'result');
    expect(result).toBeDefined();
    if (!result || result.type !== 'result') throw new Error('missing result');
    expect(result.output).toBe('Hello copilot');
    expect(result.sessionId).toBe('session-1');
    expect(result.usage.outputTokens).toBe(5);
  });

  it('emits stream_parse_error and continues parsing after malformed lines', async () => {
    mockExeca.mockReturnValueOnce(
      mockCopilotProcess(
        [
          '{this is not json}\n',
          '{"type":"assistant.message_delta","data":{"deltaContent":"recovered"}}\n',
        ],
        [
          '{"type":"result","sessionId":"session-2","usage":{"totalApiDurationMs":120}}\n',
        ],
      ) as any,
    );

    const runner = new CopilotRunner('/bin/copilot');
    const events = [];
    for await (const event of runner.run('hello', {})) {
      events.push(event);
    }

    const parseErrors = events.filter(event => event.type === 'stream_parse_error');
    expect(parseErrors).toHaveLength(1);
    const parseError = parseErrors[0];
    if (parseError.type !== 'stream_parse_error') throw new Error('wrong type');
    expect(parseError.source).toBe('stdout');
    expect(parseError.line).toBe(0);

    const textEvents = events.filter(event => event.type === 'text');
    expect(textEvents[0].type === 'text' && textEvents[0].content).toBe('recovered');

    const result = events.find(event => event.type === 'result');
    expect(result).toBeDefined();
    if (!result || result.type !== 'result') throw new Error('missing result');
    expect(result.sessionId).toBe('session-2');
    expect(result.usage.inputTokens).toBe(Math.ceil('hello'.length / 4));
  });

  it('parses unterminated final lines instead of dropping output', async () => {
    mockExeca.mockReturnValueOnce(
      mockCopilotProcess(
        ['{"type":"assistant.message_delta","data":{"deltaContent":"tail"}}'],
        [
          '{"type":"result","sessionId":"session-3","usage":{"totalApiDurationMs":100}}\n',
        ],
      ) as any,
    );

    const runner = new CopilotRunner('/bin/copilot');
    const events = [];
    for await (const event of runner.run('hello', {})) {
      events.push(event);
    }

    const textEvents = events.filter(event => event.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].type === 'text' && textEvents[0].content).toBe('tail');

    const result = events.find(event => event.type === 'result');
    expect(result).toBeDefined();
    if (!result || result.type !== 'result') throw new Error('missing result');
    expect(result.sessionId).toBe('session-3');
  });
});
