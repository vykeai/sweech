import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatRunner } from '../../runner/openai-compat.js';

function mockSSEStream(dataLines: string[], status = 200) {
  const encoder = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (i < dataLines.length) {
          controller.enqueue(encoder.encode(dataLines[i] + '\n\n'));
          i++;
        } else {
          controller.close();
        }
      },
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('OpenAICompatRunner', () => {
  let runner: OpenAICompatRunner;

  beforeEach(() => {
    vi.restoreAllMocks();
    runner = new OpenAICompatRunner();
  });

  it('isAvailable always returns true', async () => {
    expect(await runner.isAvailable()).toBe(true);
  });

  // ── Valid/invalid baseUrl ──

  it('yields error when baseUrl is missing', async () => {
    const events = [];
    for await (const e of runner.run('test', {})) events.push(e);
    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.type === 'error' && err!.message).toContain('requires opts.baseUrl');
  });

  it('yields error for non-http protocols (ssrf)', async () => {
    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'file:///etc/passwd' })) events.push(e);
    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.type === 'error' && err!.message).toContain('only http: and https:');
  });

  it('yields error for malformed URL', async () => {
    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'not a url' })) events.push(e);
    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.type === 'error' && err!.message).toContain('not a valid URL');
  });

  it('accepts valid https baseUrl', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockSSEStream(['data: [DONE]']),
    );
    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'https://api.example.com/v1/chat/completions' })) events.push(e);
    const err = events.find(e => e.type === 'error');
    expect(err).toBeUndefined();
    const result = events.find(e => e.type === 'result');
    expect(result).toBeDefined();
  });

  it('accepts localhost http baseUrl (local LLMs)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockSSEStream(['data: [DONE]']),
    );
    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'http://localhost:11434/v1/chat/completions' })) events.push(e);
    const err = events.find(e => e.type === 'error');
    expect(err).toBeUndefined();
  });

  // ── Header injection ──

  it('rejects CRLF in custom headers', async () => {
    const gen = runner.run('test', {
      baseUrl: 'https://api.example.com/v1',
      headers: { 'X-Custom': 'value\r\nX-Injected: malicious' },
    });
    await expect(gen.next()).rejects.toThrow('newline');
  });

  it('rejects null bytes in custom headers', async () => {
    const gen = runner.run('test', {
      baseUrl: 'https://api.example.com/v1',
      headers: { 'X-Bad': 'value\0injection' },
    });
    await expect(gen.next()).rejects.toThrow('null bytes');
  });

  it('rejects empty header name', async () => {
    const gen = runner.run('test', {
      baseUrl: 'https://api.example.com/v1',
      headers: { ' ': 'value' },
    });
    await expect(gen.next()).rejects.toThrow('cannot be empty');
  });

  // ── SSE stream parsing ──

  it('parses streaming text chunks from OpenAI-format SSE', async () => {
    const chunks = [
      'data: {"id":"c1","choices":[{"delta":{"content":"Hello "}}]}',
      'data: {"id":"c2","choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: [DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockSSEStream(chunks));

    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'https://api.example.com/v1' })) events.push(e);

    const texts = events.filter(e => e.type === 'text');
    expect(texts).toHaveLength(2);
    expect(texts[0].type === 'text' && texts[0].content).toBe('Hello ');
    expect(texts[1].type === 'text' && texts[1].content).toBe('world');

    const result = events.find(e => e.type === 'result');
    expect(result).toBeDefined();
    expect(result!.type === 'result' && result!.output).toBe('Hello world');
    expect(result!.type === 'result' && result!.usage.inputTokens).toBe(10);
    expect(result!.type === 'result' && result!.usage.outputTokens).toBe(5);
  });

  it('parses reasoning_content as thinking events', async () => {
    const chunks = [
      'data: {"id":"c1","choices":[{"delta":{"reasoning_content":"Let me think..."}}]}',
      'data: {"id":"c2","choices":[{"delta":{"content":"Answer"}}]}',
      'data: [DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockSSEStream(chunks));

    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'https://api.example.com/v1' })) events.push(e);

    const thinking = events.filter(e => e.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].type === 'thinking' && thinking[0].content).toBe('Let me think...');
  });

  it('skips malformed JSON in SSE stream gracefully', async () => {
    const chunks = [
      'data: {"id":"c1","choices":[{"delta":{"content":"ok"}}]}',
      'data: {invalid json}',
      'data: {"id":"c2","choices":[{"delta":{"content":" still"}}]}',
      'data: [DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockSSEStream(chunks));

    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'https://api.example.com/v1' })) events.push(e);

    const texts = events.filter(e => e.type === 'text');
    expect(texts).toHaveLength(2);
    const result = events.find(e => e.type === 'result');
    expect(result!.type === 'result' && result!.output).toBe('ok still');
  });

  it('skips lines without data: prefix', async () => {
    const chunks = [
      ': this is a comment',
      'data: {"id":"c1","choices":[{"delta":{"content":"yes"}}]}',
      'data: [DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockSSEStream(chunks));

    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'https://api.example.com/v1' })) events.push(e);

    const texts = events.filter(e => e.type === 'text');
    expect(texts).toHaveLength(1);
  });

  it('yields error on API error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"error":"rate limited"}', { status: 429 }),
    );

    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'https://api.example.com/v1' })) events.push(e);

    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.type === 'error' && err!.message).toContain('429');
    expect(err!.type === 'error' && err!.message).toContain('rate limited');
  });

  it('yields error when response has no body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );

    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'https://api.example.com/v1' })) events.push(e);

    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.type === 'error' && err!.message).toContain('No response body');
  });

  // ── Abort signal ──

  it('passes abort signal to fetch', async () => {
    const controller = new AbortController();
    // Pre-abort so fetch rejects immediately
    controller.abort();

    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      expect((init as RequestInit).signal).toBe(controller.signal);
      return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
    });

    const gen = runner.run('test', {
      baseUrl: 'https://api.example.com/v1',
      abortSignal: controller.signal,
    });
    await expect(gen.next()).rejects.toThrow('aborted');
  });

  // ── Request body and headers ──

  it('sends correct request body with system prompt and model', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockSSEStream(['data: [DONE]']),
    );

    for await (const _ of runner.run('test prompt', {
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4',
      systemPrompt: 'You are helpful',
      temperature: 0.7,
    })) {}

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1');
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe('gpt-4');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe('You are helpful');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('test prompt');
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.7);
  });

  it('includes Authorization header when apiKey is provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockSSEStream(['data: [DONE]']),
    );

    for await (const _ of runner.run('test', {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-key-123',
    })) {}

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does not include Authorization header when no apiKey', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockSSEStream(['data: [DONE]']),
    );

    for await (const _ of runner.run('test', {
      baseUrl: 'https://api.example.com/v1',
    })) {}

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockSSEStream(['data: [DONE]']),
    );

    for await (const _ of runner.run('test', {
      baseUrl: 'https://api.example.com/v1/',
    })) {}

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1');
  });

  it('defaults model to "default" and maxTokens to 8192', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockSSEStream(['data: [DONE]']),
    );

    for await (const _ of runner.run('test', {
      baseUrl: 'https://api.example.com/v1',
    })) {}

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('default');
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBeUndefined();
  });

  it('includes usage from final chunk in result event', async () => {
    const chunks = [
      'data: {"id":"c1","choices":[{"delta":{"content":"hi"}}]}',
      'data: {"id":"c2","choices":[{"delta":{}}],"usage":{"prompt_tokens":50,"completion_tokens":20,"total_tokens":70}}',
      'data: [DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockSSEStream(chunks));

    const events = [];
    for await (const e of runner.run('test', { baseUrl: 'https://api.example.com/v1' })) events.push(e);

    const result = events.find(e => e.type === 'result');
    expect(result!.type === 'result' && result!.usage.inputTokens).toBe(50);
    expect(result!.type === 'result' && result!.usage.outputTokens).toBe(20);
    expect(result!.type === 'result' && result!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
