import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashScopeRunner } from '../../runner/dashscope.js';

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

describe('DashScopeRunner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('isAvailable returns true when API key is set', async () => {
    const runner = new DashScopeRunner('test-key');
    expect(await runner.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when API key is empty', async () => {
    const runner = new DashScopeRunner('');
    expect(await runner.isAvailable()).toBe(false);
  });

  it('streams text content from OpenAI-compat SSE', async () => {
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":"DashScope"}}]}\n\n',
      'data: {"id":"1","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\n',
      'data: [DONE]\n\n',
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockStreamResponse(chunks));

    const runner = new DashScopeRunner('test-key');
    const events = [];
    for await (const event of runner.run('test prompt', {})) {
      events.push(event);
    }

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].type === 'text' && textEvents[0].content).toBe('Hello ');
    expect(textEvents[1].type === 'text' && textEvents[1].content).toBe('DashScope');

    const result = events.find(e => e.type === 'result');
    expect(result).toBeDefined();
    expect(result!.type === 'result' && result!.output).toBe('Hello DashScope');
    expect(result!.type === 'result' && result!.usage.inputTokens).toBe(20);
    expect(result!.type === 'result' && result!.usage.outputTokens).toBe(10);
  });

  it('streams reasoning content as thinking events', async () => {
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"reasoning_content":"Thinking step..."}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":"Result"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockStreamResponse(chunks));

    const runner = new DashScopeRunner('test-key');
    const events = [];
    for await (const event of runner.run('test', {})) {
      events.push(event);
    }

    const thinkingEvents = events.filter(e => e.type === 'thinking');
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0].type === 'thinking' && thinkingEvents[0].content).toBe('Thinking step...');
  });

  it('sends correct URL and auth header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockStreamResponse(['data: [DONE]\n\n'])
    );

    const runner = new DashScopeRunner('ds-key');
    for await (const _ of runner.run('test', {})) {}

    const [url, reqInit] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions');
    const headers = reqInit!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ds-key');
  });

  it('yields error on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Bad Request', { status: 400 })
    );

    const runner = new DashScopeRunner('test-key');
    const events = [];
    for await (const event of runner.run('test', {})) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].type === 'error' && events[0].message).toContain('400');
  });

  it('resolves model aliases', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockStreamResponse(['data: [DONE]\n\n'])
    );

    const runner = new DashScopeRunner('test-key');
    for await (const _ of runner.run('test', { model: 'qwen-coder' })) {}

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('qwen3-coder-next');
  });

  it('includes stream_options for usage reporting', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockStreamResponse(['data: [DONE]\n\n'])
    );

    const runner = new DashScopeRunner('test-key');
    for await (const _ of runner.run('test', {})) {}

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('passes system prompt when provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockStreamResponse(['data: [DONE]\n\n'])
    );

    const runner = new DashScopeRunner('test-key');
    for await (const _ of runner.run('test', { systemPrompt: 'You are helpful' })) {}

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'test' });
  });

  // ── Adversarial security tests ──

  it('rejects SSRF via file:// baseUrl in constructor', () => {
    expect(() => new DashScopeRunner('test-key', 'file:///etc/passwd')).toThrow('only http: and https:');
  });

  it('rejects SSRF via ftp:// baseUrl in constructor', () => {
    expect(() => new DashScopeRunner('test-key', 'ftp://evil.com/payload')).toThrow('only http: and https:');
  });

  it('rejects CRLF injection via custom headers', async () => {
    const runner = new DashScopeRunner('test-key');
    const gen = runner.run('test', { headers: { 'X-Evil': 'val\r\nInjected: yes' } });
    await expect(gen.next()).rejects.toThrow('newline');
  });

  it('rejects null bytes in custom headers', async () => {
    const runner = new DashScopeRunner('test-key');
    const gen = runner.run('test', { headers: { 'X-Bad': 'val\0ue' } });
    await expect(gen.next()).rejects.toThrow('null bytes');
  });

  it('rejects empty header name in custom headers', async () => {
    const runner = new DashScopeRunner('test-key');
    const gen = runner.run('test', { headers: { ' ': 'val' } });
    await expect(gen.next()).rejects.toThrow('cannot be empty');
  });

  it('accepts http://localhost baseUrl (local LLM)', () => {
    expect(() => new DashScopeRunner('test-key', 'http://localhost:11434/v1')).not.toThrow();
  });
});
