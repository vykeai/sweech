import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OmnaiClient } from '../client.js';
import type { AgentEvent } from '../types.js';

const envelopeEvent: AgentEvent = {
  type: 'result',
  output: 'ok',
  usage: { inputTokens: 1, outputTokens: 2 },
  costUsd: 0.01,
  durationMs: 12,
};

function createStreamResponse(text: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream);
}

describe('OmnaiClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes daemon stream envelopes in run()', async () => {
    const runResponse = createStreamResponse(
      `data: ${JSON.stringify({
        schema: 'omnai.stream',
        version: 1,
        kind: 'agent_event',
        streamId: 'stream-1',
        requestId: 'run-1',
        sequence: 1,
        traceId: 'trace-1',
        severity: 'info',
        componentId: 'core.daemon.run',
        correlationId: 'corr-1',
        ts: '2026-01-01T00:00:00.000Z',
        event: envelopeEvent,
      })}\n\n`,
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(runResponse);

    const events: AgentEvent[] = [];
    for await (const event of new OmnaiClient({ port: 7845, host: '127.0.0.1' }).run('hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(envelopeEvent);
  });

  it('falls back to raw agent events without envelope', async () => {
    const runResponse = createStreamResponse(`data: ${JSON.stringify({ type: 'text', content: 'hello' })}\n\n`);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(runResponse);

    const events: AgentEvent[] = [];
    for await (const event of new OmnaiClient({ port: 7845, host: '127.0.0.1' }).run('hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text', content: 'hello' });
  });

  it('falls back to error event on malformed daemon frame', async () => {
    const runResponse = createStreamResponse('data: {not-json\n\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(runResponse);

    const events: AgentEvent[] = [];
    for await (const event of new OmnaiClient({ port: 7845, host: '127.0.0.1' }).run('hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'daemon stream produced malformed JSON' });
  });

  it('falls back to error event on unsupported payload shape', async () => {
    const runResponse = createStreamResponse('data: {\"kind\":\"legacy\",\"payload\":1}\n\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(runResponse);

    const events: AgentEvent[] = [];
    for await (const event of new OmnaiClient({ port: 7845, host: '127.0.0.1' }).run('hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'daemon stream produced unsupported payload shape' });
  });
});
