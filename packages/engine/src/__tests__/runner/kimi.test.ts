import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KimiRunner } from '../../runner/kimi.js';

function mockStreamResponse(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  let chunkIndex = 0;

  return new Response(
    new ReadableStream({
      pull(controller) {
        if (chunkIndex < chunks.length) {
          controller.enqueue(encoder.encode(chunks[chunkIndex]));
          chunkIndex++;
        } else {
          controller.close();
        }
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'text/event-stream' },
    }
  );
}

describe('KimiRunner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('isAvailable returns true when API key is set', async () => {
    const runner = new KimiRunner('test-key');
    expect(await runner.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when API key is empty', async () => {
    const runner = new KimiRunner('');
    expect(await runner.isAvailable()).toBe(false);
  });

  it('streams text content from Anthropic-style SSE', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":15}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockStreamResponse(chunks));

    const runner = new KimiRunner('test-key');
    const events = [];
    for await (const event of runner.run('test prompt', {})) {
      events.push(event);
    }

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].type === 'text' && textEvents[0].content).toBe('Hello ');
    expect(textEvents[1].type === 'text' && textEvents[1].content).toBe('world');

    const result = events.find(e => e.type === 'result');
    expect(result).toBeDefined();
    expect(result!.type === 'result' && result!.output).toBe('Hello world');
    expect(result!.type === 'result' && result!.usage.inputTokens).toBe(15);
    expect(result!.type === 'result' && result!.usage.outputTokens).toBe(8);
  });

  it('streams thinking content', async () => {
    const chunks = [
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me reason..."}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}\n\n',
      'data: [DONE]\n\n',
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockStreamResponse(chunks));

    const runner = new KimiRunner('test-key');
    const events = [];
    for await (const event of runner.run('test', {})) {
      events.push(event);
    }

    const thinkingEvents = events.filter(e => e.type === 'thinking');
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0].type === 'thinking' && thinkingEvents[0].content).toBe('Let me reason...');
  });

  it('sends correct headers (x-api-key + anthropic-version)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockStreamResponse(['data: [DONE]\n\n'])
    );

    const runner = new KimiRunner('kimi-test-key');
    for await (const _ of runner.run('test', {})) {}

    const [url, reqInit] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.kimi.com/coding/v1/messages');
    const headers = reqInit!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('kimi-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('yields error on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 })
    );

    const runner = new KimiRunner('bad-key');
    const events = [];
    for await (const event of runner.run('test', {})) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].type === 'error' && events[0].message).toContain('401');
  });

  it('resolves model aliases', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockStreamResponse(['data: [DONE]\n\n'])
    );

    const runner = new KimiRunner('test-key');
    for await (const _ of runner.run('test', { model: 'k2p5' })) {}

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('kimi-for-coding');
  });

  it('defaults max_tokens to 32000 for 32k output', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockStreamResponse(['data: [DONE]\n\n'])
    );

    const runner = new KimiRunner('test-key');
    for await (const _ of runner.run('test', {})) {}

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.max_tokens).toBe(32000);
  });

  // ── Adversarial security tests ──

  it('rejects SSRF via file:// baseUrl in constructor', () => {
    expect(() => new KimiRunner('test-key', 'file:///etc/passwd')).toThrow('only http: and https:');
  });

  it('rejects SSRF via javascript: baseUrl in constructor', () => {
    expect(() => new KimiRunner('test-key', 'javascript:alert(1)')).toThrow('only http: and https:');
  });

  it('rejects CRLF injection via custom headers', async () => {
    const runner = new KimiRunner('test-key');
    const gen = runner.run('test', { headers: { 'X-Evil': 'val\r\nInjected: yes' } });
    await expect(gen.next()).rejects.toThrow('newline');
  });

  it('rejects null bytes in custom headers', async () => {
    const runner = new KimiRunner('test-key');
    const gen = runner.run('test', { headers: { 'X-Bad': 'val\0ue' } });
    await expect(gen.next()).rejects.toThrow('null bytes');
  });

  it('accepts http://localhost baseUrl (local LLM)', () => {
    expect(() => new KimiRunner('test-key', 'http://localhost:8080/v1')).not.toThrow();
  });
});
