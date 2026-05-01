import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SweechClient } from '../client.js';
import type { AgentEvent } from '../types.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

describe('SweechClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes daemon stream envelopes in run()', async () => {
    const runResponse = createStreamResponse(
      `data: ${JSON.stringify({
        schema: 'sweech.stream',
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
    for await (const event of new SweechClient({ port: 9876, host: '127.0.0.1' }).run('hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(envelopeEvent);
  });

  it('falls back to raw agent events without envelope', async () => {
    const runResponse = createStreamResponse(`data: ${JSON.stringify({ type: 'text', content: 'hello' })}\n\n`);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(runResponse);

    const events: AgentEvent[] = [];
    for await (const event of new SweechClient({ port: 9876, host: '127.0.0.1' }).run('hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text', content: 'hello' });
  });

  it('falls back to error event on malformed daemon frame', async () => {
    const runResponse = createStreamResponse('data: {not-json\n\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(runResponse);

    const events: AgentEvent[] = [];
    for await (const event of new SweechClient({ port: 9876, host: '127.0.0.1' }).run('hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'daemon stream produced malformed JSON' });
  });

  it('falls back to error event on unsupported payload shape', async () => {
    const runResponse = createStreamResponse('data: {\"kind\":\"legacy\",\"payload\":1}\n\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(runResponse);

    const events: AgentEvent[] = [];
    for await (const event of new SweechClient({ port: 9876, host: '127.0.0.1' }).run('hello')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'daemon stream produced unsupported payload shape' });
  });

  describe('discover()', () => {
    const fedConfigPath = join(homedir(), '.fed', 'config.json');
    let originalConfig: string | null = null;

    beforeEach(async () => {
      try { originalConfig = await import('node:fs/promises').then(fs => fs.readFile(fedConfigPath, 'utf-8')); } catch { originalConfig = null; }
    });

    afterEach(async () => {
      if (originalConfig !== null) {
        await writeFile(fedConfigPath, originalConfig, 'utf-8');
      }
    });

    it('resolves port from fed config for sweech-engine', async () => {
      await mkdir(join(homedir(), '.fed'), { recursive: true });
      await writeFile(fedConfigPath, JSON.stringify({ tools: { 'sweech-engine': { dash: 17807, fed: 17857, enabled: true } } }), 'utf-8');
      delete process.env.SWEECH_PORT;
      const client = await SweechClient.discover();
      expect((client as unknown as { baseUrl: string }).baseUrl).toBe('http://127.0.0.1:17807');
    });

    it('prefers SWEECH_PORT env var over fed config', async () => {
      process.env.SWEECH_PORT = '9999';
      const client = await SweechClient.discover();
      expect((client as unknown as { baseUrl: string }).baseUrl).toBe('http://127.0.0.1:9999');
      delete process.env.SWEECH_PORT;
    });

    it('falls back to default 7801 when config unavailable', async () => {
      delete process.env.SWEECH_PORT;
      await rm(fedConfigPath).catch(() => {});
      const client = await SweechClient.discover();
      expect((client as unknown as { baseUrl: string }).baseUrl).toBe('http://127.0.0.1:7801');
    });
  });
});
