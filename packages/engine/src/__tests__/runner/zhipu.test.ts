import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZhipuRunner } from '../../runner/zhipu.js';

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

describe('ZhipuRunner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('isAvailable returns true when API key is set', async () => {
    const runner = new ZhipuRunner('test-key');
    expect(await runner.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when API key is empty', async () => {
    const runner = new ZhipuRunner('');
    expect(await runner.isAvailable()).toBe(false);
  });

  it('streams text content from SSE response', async () => {
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"id":"1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockStreamResponse(chunks));

    const runner = new ZhipuRunner('test-key');
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
    expect(result!.type === 'result' && result!.usage.inputTokens).toBe(10);
    expect(result!.type === 'result' && result!.usage.outputTokens).toBe(5);
  });

  it('streams reasoning content as thinking events', async () => {
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"reasoning_content":"Let me think..."}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":"Answer"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockStreamResponse(chunks));

    const runner = new ZhipuRunner('test-key');
    const events = [];
    for await (const event of runner.run('test', {})) {
      events.push(event);
    }

    const thinkingEvents = events.filter(e => e.type === 'thinking');
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0].type === 'thinking' && thinkingEvents[0].content).toBe('Let me think...');
  });

  it('yields error on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Rate limited', { status: 429 })
    );

    const runner = new ZhipuRunner('test-key');
    const events = [];
    for await (const event of runner.run('test', {})) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].type === 'error' && events[0].message).toContain('429');
  });

  it('enforces max_tokens >= 200 for reasoning models', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockStreamResponse(['data: [DONE]\n\n'])
    );

    const runner = new ZhipuRunner('test-key');
    const events = [];
    for await (const event of runner.run('test', { maxTokens: 50 })) {
      events.push(event);
    }

    const [, reqInit] = fetchSpy.mock.calls[0];
    const body = JSON.parse(reqInit!.body as string);
    expect(body.max_tokens).toBe(200);
  });

  it('sends correct model in request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockStreamResponse(['data: [DONE]\n\n'])
    );

    const runner = new ZhipuRunner('test-key');
    for await (const _ of runner.run('test', { model: 'glm-5' })) {}

    const [url, reqInit] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    const body = JSON.parse(reqInit!.body as string);
    expect(body.model).toBe('glm-5');
  });

  // ── Adversarial security tests ──

  it('rejects SSRF via file:// baseUrl in constructor', () => {
    expect(() => new ZhipuRunner('test-key', 'file:///etc/passwd')).toThrow('only http: and https:');
  });

  it('rejects SSRF via ftp:// baseUrl in constructor', () => {
    expect(() => new ZhipuRunner('test-key', 'ftp://evil.com/payload')).toThrow('only http: and https:');
  });

  it('rejects CRLF injection via custom headers', async () => {
    const runner = new ZhipuRunner('test-key');
    const gen = runner.run('test', { headers: { 'X-Evil': 'val\r\nInjected: yes' } });
    await expect(gen.next()).rejects.toThrow('newline');
  });

  it('rejects null bytes in custom headers', async () => {
    const runner = new ZhipuRunner('test-key');
    const gen = runner.run('test', { headers: { 'X-Bad': 'val\0ue' } });
    await expect(gen.next()).rejects.toThrow('null bytes');
  });

  it('accepts http://localhost baseUrl (local LLM)', () => {
    expect(() => new ZhipuRunner('test-key', 'http://localhost:8080/v1')).not.toThrow();
  });
});
