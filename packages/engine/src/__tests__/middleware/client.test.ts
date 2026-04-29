import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OmnaiClient } from '../../client.js';

describe('OmnaiClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('defaults to port 7845 and 127.0.0.1', () => {
    const client = new OmnaiClient();
    // Access private baseUrl via any cast
    expect((client as any).baseUrl).toBe('http://127.0.0.1:7845');
  });

  it('accepts custom port and host', () => {
    const client = new OmnaiClient({ port: 9999, host: 'localhost' });
    expect((client as any).baseUrl).toBe('http://localhost:9999');
  });

  it('ping returns false when daemon is not running', async () => {
    const client = new OmnaiClient({ port: 1 }); // port 1 won't have anything
    const result = await client.ping();
    expect(result).toBe(false);
  });

  it('ping returns true when daemon responds ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    const client = new OmnaiClient();
    const result = await client.ping();
    expect(result).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7845/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('select throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    const client = new OmnaiClient();
    await expect(client.select({ provider: 'claude' })).rejects.toThrow(
      'Daemon select failed: 500 Internal Server Error',
    );
  });

  it('select returns engine on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ engine: 'claude-code', account: 'claude-sub' }),
    });
    const client = new OmnaiClient();
    const result = await client.select({ provider: 'claude' });
    expect(result).toEqual({ engine: 'claude-code', account: 'claude-sub' });
  });

  it('select forwards explicit account ids', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ engine: 'claude-code', account: 'claude-pole' }),
    });
    const client = new OmnaiClient();
    await client.select({ account: 'claude-pole' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7845/select',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ account: 'claude-pole' }),
      }),
    );
  });

  it('select forwards fallback account order', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ engine: 'pi-mono', account: 'kimi-api' }),
    });
    const client = new OmnaiClient();
    await client.select({ provider: 'kimi', fallbackAccounts: ['kimi-api', 'minimax-api'] });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:7845/select',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ provider: 'kimi', fallbackAccounts: ['kimi-api', 'minimax-api'] }),
      }),
    );
  });

  it('getEngines throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const client = new OmnaiClient();
    await expect(client.getEngines()).rejects.toThrow('Daemon engines failed: 503');
  });

  it('getEstate throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const client = new OmnaiClient();
    await expect(client.getEstate()).rejects.toThrow('Daemon estate failed: 404');
  });

  it('getQuota throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const client = new OmnaiClient();
    await expect(client.getQuota()).rejects.toThrow('Daemon quota failed: 401');
  });
});

describe('selectViaDaemon', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to local select when daemon is down', async () => {
    // Import dynamically so mocks are set up
    const { selectViaDaemon } = await import('../../select.js');
    const detect = await import('../../detect.js');

    // Mock detectEngines to return a known engine
    vi.spyOn(detect, 'detectEngines').mockResolvedValue([
      { engine: 'claude-code', available: true, binaryPath: '/usr/bin/claude' },
    ]);

    // Daemon is not running on port 1
    const runner = await selectViaDaemon({ engine: 'claude-code', config: {} as any });
    expect(runner.engine).toBe('claude-code');
  });
});
