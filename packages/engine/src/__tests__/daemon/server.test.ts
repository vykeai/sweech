import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, preloadEstate, clearEstateCache, setDaemonLifecycleState, getDaemonSessionStore } from '../../daemon/server.js';
import type { Estate } from '../../estate.js';
import * as estateModule from '../../estate.js';
import * as subscriptionRouting from '../../subscription-routing.js';
import * as selectModule from '../../select.js';
import type { ModelRunner } from '../../types.js';

vi.mock('@vykeai/fed', () => ({
  FedEventClient: class { publish() { return Promise.resolve({}); } },
}));

vi.mock('../../detect.js', () => ({
  detectEngines: vi.fn().mockResolvedValue([
    { engine: 'claude-code', available: true, binaryPath: '/usr/bin/claude', providers: ['claude'] },
    { engine: 'codex', available: true, binaryPath: '/usr/bin/codex', providers: ['codex'] },
    { engine: 'pi-mono', available: true, binaryPath: '/usr/bin/pi', providers: ['openai'] },
  ]),
}));

// select.js is NOT mocked at module level — bun's vi.mock factory async import
// deadlocks even for non-mocked dependencies. makeRunner is spied per-test instead.

// vi.stubGlobal is not supported in bun — mock fetch via globalThis directly.
// This prevents accidental real network calls (e.g. loadSweechTelemetry).
globalThis.fetch = vi.fn().mockRejectedValue(new Error('no sweech in test')) as typeof fetch;

const mockEstate: Estate = {
  version: 1,
  accounts: {
    main: { provider: 'claude', engine: 'claude-code', type: 'subscription' },
  },
  failoverOrder: ['main'],
};

function createMockRunner(engine: 'claude-code' | 'pi-mono' | 'copilot' | 'codex', events: ReturnType<ModelRunner['run']> extends AsyncGenerator<infer T> ? T[] : never): ModelRunner {
  return {
    engine,
    async isAvailable() {
      return true;
    },
    async *run() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createDeepArray(depth: number): unknown[] {
  const root: unknown[] = [];
  let cursor: unknown[] = root;
  for (let i = 0; i < depth; i++) {
    const next: unknown[] = [];
    cursor.push(next);
    cursor = next;
  }
  return root;
}

function postSelect(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return app.request('/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRun(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return app.request('/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function extractFirstStreamEvent(raw: string): Record<string, unknown> {
  const frame = raw.split('\n').find((line) => line.startsWith('data: '));
  expect(frame).toBeTruthy();
  const rawPayload = String(frame).slice(6);
  const payload = JSON.parse(rawPayload) as Record<string, unknown>;
  if (typeof payload.event === 'object' && payload.event !== null && typeof (payload.event as { type?: string }).type === 'string') {
    return payload.event as Record<string, unknown>;
  }
  return payload;
}

describe('daemon server', () => {
  const app = createApp();

  beforeEach(() => {
    clearEstateCache();
    setDaemonLifecycleState('ready');
    vi.restoreAllMocks();
  });

  it('GET /healthz reports ready state', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state).toBe('ready');
    expect(typeof body.activeSessions).toBe('number');
  });

  it('GET /healthz returns 503 when daemon is not ready', async () => {
    setDaemonLifecycleState('booting', 'unit test');
    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.state).toBe('booting');
    expect(body.reason).toBe('unit test');
  });

  it('GET /healthz reports terminated state', async () => {
    setDaemonLifecycleState('terminated', 'graceful shutdown');
    const res = await app.request('/healthz');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.state).toBe('terminated');
    expect(body.reason).toBe('graceful shutdown');
  });

  it('GET /health returns ok and uptime', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.version).toBe('string');
  });

  it('GET /engines returns array', async () => {
    const res = await app.request('/engines');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(3);
    expect(body[0].engine).toBe('claude-code');
  });

  it('POST /select with provider returns engine', async () => {
    const res = await app.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('claude-code');
  });

  it('POST /select honors explicit account ids from the estate', async () => {
    // resolveSelectionTarget calls resolveAccount which reads ~/.omnai/estate.yaml.
    // Spy to avoid filesystem dependency for non-standard test account 'pole'.
    vi.spyOn(selectModule, 'resolveSelectionTarget').mockResolvedValueOnce({
      engine: 'claude-code', account: 'pole', binaryPath: '/usr/bin/claude', source: 'selection', provider: 'claude',
    });
    const accountApp = createApp({
      estate: {
        version: 1,
        accounts: {
          pole: { provider: 'claude', engine: 'claude-code', type: 'subscription', configDir: '/Users/luke/.claude-pole' },
        },
        failoverOrder: ['pole'],
      },
    });
    const res = await accountApp.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'pole' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ engine: 'claude-code', account: 'pole' });
  });

  it('POST /select honors explicit fallback account order', async () => {
    // resolveSelectionTarget calls resolveAccount which reads ~/.omnai/estate.yaml.
    // Spy to avoid filesystem dependency for non-standard test accounts.
    vi.spyOn(selectModule, 'resolveSelectionTarget').mockResolvedValueOnce({
      engine: 'pi-mono', account: 'kimi', binaryPath: '/usr/bin/pi', source: 'selection', provider: 'kimi',
    });
    const fallbackApp = createApp({
      estate: {
        version: 1,
        accounts: {
          kimi: { provider: 'kimi', engine: 'pi-mono', type: 'api-key' },
          minimax: { provider: 'minimax', engine: 'pi-mono', type: 'api-key' },
        },
        failoverOrder: ['minimax', 'kimi'],
      },
    });
    const res = await fallbackApp.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fallbackAccounts: ['kimi', 'minimax'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ engine: 'pi-mono', account: 'kimi' });
  });

  it('POST /select can reorder subscription accounts using accountStrategy', async () => {
    vi.spyOn(subscriptionRouting, 'loadSweechTelemetry').mockResolvedValue({
      'claude-main': { utilization5h: 0.9, utilization7d: 0.8, plan: 'Max 5x' },
      'claude-pole': { utilization5h: 0.1, utilization7d: 0.2, plan: 'Max 20x' },
    });

    const strategyApp = createApp({
      estate: {
        version: 1,
        accounts: {
          'claude-main': { provider: 'claude', engine: 'claude-code', type: 'subscription', configDir: '/Users/luke/.claude' },
          'claude-pole': { provider: 'claude', engine: 'claude-code', type: 'subscription', configDir: '/Users/luke/.claude-pole' },
        },
        failoverOrder: ['claude-main', 'claude-pole'],
      },
    });

    const res = await strategyApp.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', accountStrategy: 'least-used' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ engine: 'claude-code', account: 'claude-pole' });
  });

  it('POST /select with codex provider returns codex engine', async () => {
    const res = await app.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'codex' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('codex');
  });

  it('POST /select keeps openai API routing separate from codex', async () => {
    const res = await app.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('pi-mono');
  });

  it('POST /select with unknown engine returns 400', async () => {
    const res = await app.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'nonexistent' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('nonexistent');
  });

  it('POST /select rejects non-JSON body before runner dispatch', async () => {
    const res = await app.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('invalid_json');
    expect(body.error).toContain('valid JSON');
  });

  it('POST /select rejects unknown fields', async () => {
    const res = await postSelect(app, { prompt: 'nope' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('unknown_field');
    expect(body.field).toBe('prompt');
  });

  it('GET /estate returns estate when preloaded', async () => {
    preloadEstate(mockEstate);
    const res = await app.request('/estate');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.accounts.main.provider).toBe('claude');
  });

  it('GET /estate returns 500 when no estate file exists', async () => {
    clearEstateCache();
    vi.spyOn(estateModule, 'loadEstate').mockRejectedValueOnce(new Error('missing estate'));
    const res = await app.request('/estate');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('missing estate');
  });

  it('GET /quota returns accounts object', async () => {
    const res = await app.request('/quota');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ accounts: {} });
  });

  it('POST /run echoes account and provider in SSE result event', async () => {
    const runApp = createApp({
      estate: {
        version: 1,
        accounts: {
          'claude-rai': { provider: 'claude', engine: 'claude-code', type: 'subscription', configDir: '/Users/luke/.claude-rai' },
        },
        failoverOrder: ['claude-rai'],
      },
    });

    vi.spyOn(selectModule, 'makeRunner').mockReturnValueOnce(
      createMockRunner('claude-code', [
        {
          type: 'result',
          output: 'done',
          usage: { inputTokens: 10, outputTokens: 5 },
          costUsd: 0.001,
          durationMs: 50,
        },
      ]),
    );

    const res = await runApp.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', account: 'claude-rai' }),
    });

    expect(res.status).toBe(200);
    const rawBody = await res.text();
    const frame = rawBody.split('\n').find((line) => line.startsWith('data: '));
    expect(frame).toBeTruthy();
    const rawPayload = JSON.parse(String(frame).slice(6));
    expect(rawPayload.schema).toBe('omnai.stream');
    expect(rawPayload.version).toBe(1);

    const payload = extractFirstStreamEvent(rawBody);
    expect(payload.type).toBe('result');
    expect(payload.account).toBe('claude-rai');
    expect(payload.provider).toBe('claude');
  });

  it('POST /run estimates cost for result events that only return token usage', async () => {
    vi.spyOn(selectModule, 'makeRunner').mockReturnValueOnce(
      createMockRunner('pi-mono', [
        {
          type: 'result',
          output: 'done',
          usage: { inputTokens: 1200, outputTokens: 300 },
          costUsd: 0,
          durationMs: 125,
        },
      ]),
    );

    const res = await app.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'estimate this', model: 'gpt-4o' }),
    });

    expect(res.status).toBe(200);
    const payload = extractFirstStreamEvent(await res.text());
    expect(payload.type).toBe('result');
    expect(payload.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(payload.costUsd).toBeGreaterThan(0);
  });

  it('POST /run enforces readiness gate before execution', async () => {
    setDaemonLifecycleState('shutting-down');
    const blockedRes = await postRun(app, { prompt: 'hello' });
    expect(blockedRes.status).toBe(503);
    const body = await blockedRes.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not ready');
  });

  it('POST /select enforces readiness gate before execution', async () => {
    setDaemonLifecycleState('booting', 'warming');
    const blockedRes = await postSelect(app, { provider: 'claude' });
    expect(blockedRes.status).toBe(503);
    const body = await blockedRes.json();
    expect(body.ok).toBe(false);
    expect(body.state).toBe('booting');
    expect(body.reason).toBe('warming');
    expect(body.error).toContain('not ready');
  });

  it('POST /run rejects missing prompt with canonical validation error', async () => {
    const res = await postRun(app, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('invalid_field');
    expect(body.error).toContain('prompt is required');
  });

  it('POST /run rejects payloads that are too large', async () => {
    const res = await postRun(app, { prompt: 'x'.repeat(300_000) });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('request_too_large');
  });

  it('POST /run rejects overly deep payload structures', async () => {
    const res = await postRun(app, { prompt: 'depth-check', env: createDeepArray(20) as unknown as Record<string, string> });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('request_too_deep');
    expect(body.error).toContain('max depth');
  });

  it('POST /run rejects invalid budget latency thresholds', async () => {
    const res = await postRun(app, {
      prompt: 'latency-check',
      budgetGuard: {
        maxCostUsd: 1,
        action: 'abort',
        maxLatencyMs: 0,
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('invalid_field');
    expect(body.field).toBe('budgetGuard.maxLatencyMs');
  });

  it('POST /run rejects invalid budget cooldown attempts', async () => {
    const res = await postRun(app, {
      prompt: 'cooldown-check',
      budgetGuard: {
        maxCostUsd: 1,
        action: 'fallback_tier',
        cooldownAttempts: 11,
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('invalid_field');
    expect(body.field).toBe('budgetGuard.cooldownAttempts');
  });

  it('POST /run wires budget reroute middleware even without explicit retryPolicy', async () => {
    vi.spyOn(selectModule, 'makeRunner').mockReturnValueOnce(
      createMockRunner('claude-code', [
        {
          type: 'cost_update',
          costUsd: 0.2,
          tokensUsed: { inputTokens: 24, outputTokens: 12 },
        },
      ]),
    );

    const res = await postRun(app, {
      prompt: 'reroute-me',
      budgetGuard: {
        maxCostUsd: 0.05,
        action: 'fallback_tier',
        downgradeTo: 'missing-tier',
        hysteresisPct: 0,
      },
    });

    expect(res.status).toBe(200);
    const streamFrames = (await res.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { event: Record<string, unknown> });
    const streamEvents = streamFrames.map((frame) => frame.event);

    expect(streamEvents[0]).toMatchObject({
      type: 'cost_update',
      costUsd: 0.2,
    });
    expect(streamEvents.find((event) => event.type === 'error' && event.code === 'budget_reroute_unavailable')).toMatchObject({
      type: 'error',
      code: 'budget_reroute_unavailable',
    });
  });

  it('POST /select and /run resolve to the same execution target', async () => {
    const convergenceApp = createApp({
      estate: {
        version: 1,
        accounts: {
          'claude-rai': { provider: 'claude', engine: 'claude-code', type: 'subscription', configDir: '/Users/luke/.claude-rai' },
        },
        failoverOrder: ['claude-rai'],
      },
    });

    const selectRes = await convergenceApp.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'claude-rai', taskType: 'coding', accountStrategy: 'least-used' }),
    });
    expect(selectRes.status).toBe(200);
    const selectBody = await selectRes.json() as { engine?: string; account?: string };

    let resolvedEngine: string | undefined;
    let resolvedAccount: string | undefined;
    let resolvedProvider: string | undefined;
    vi.spyOn(selectModule, 'makeRunner').mockImplementation((engine, _binaryPath) => {
      resolvedEngine = engine;
      return {
        engine,
        async isAvailable() {
          return true;
        },
        async *run(_prompt, opts) {
          resolvedAccount = opts.account;
          resolvedProvider = opts.provider;
          yield {
            type: 'result',
            output: 'done',
            usage: { inputTokens: 1, outputTokens: 1 },
            costUsd: 0,
            durationMs: 1,
          };
        },
      };
    });

    const runRes = await convergenceApp.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', account: 'claude-rai', taskType: 'coding', accountStrategy: 'least-used' }),
    });
    expect(runRes.status).toBe(200);
    await runRes.text();

    expect(resolvedEngine).toBe(selectBody.engine);
    expect(resolvedAccount).toBe(selectBody.account);
    expect(resolvedProvider).toBe('claude');
  });
});

describe('session continuity (T-LU-031)', () => {
  beforeEach(() => {
    vi.spyOn(estateModule, 'loadEstate').mockResolvedValue(mockEstate);
    vi.spyOn(subscriptionRouting, 'loadSweechTelemetry').mockResolvedValue([]);
    clearEstateCache();
    preloadEstate(mockEstate);
    setDaemonLifecycleState('ready');
  });

  it('returns omnaiSessionId in result when persistSession is true', async () => {
    const app = createApp({ estate: mockEstate });
    let capturedOpts: Record<string, unknown> = {};
    vi.spyOn(selectModule, 'makeRunner').mockImplementation((engine) => ({
      engine,
      async isAvailable() { return true; },
      async *run(_prompt: string, opts: Record<string, unknown>) {
        capturedOpts = { ...opts };
        yield { type: 'result', output: 'hello', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, durationMs: 1 };
      },
    }));

    const res = await postRun(app, { prompt: 'hi', persistSession: true });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const events = raw.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    const result = events.find((e: Record<string, unknown>) => e.event?.type === 'result');
    expect(result?.event?.omnaiSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(capturedOpts).toBeDefined();
  });

  it('uses provided omnaiSessionId and prepends history to prompt', async () => {
    const app = createApp({ estate: mockEstate });
    const sessionStore = getDaemonSessionStore();

    // Seed session history manually
    const sessionId = 'test-session-abc';
    await sessionStore.save(sessionId, [
      { role: 'user', content: 'previous question', ts: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'previous answer', ts: '2026-01-01T00:00:01Z' },
    ]);

    const receivedPrompts: string[] = [];
    vi.spyOn(selectModule, 'makeRunner').mockImplementation((engine) => ({
      engine,
      async isAvailable() { return true; },
      async *run(prompt: string) {
        receivedPrompts.push(prompt);
        yield { type: 'result', output: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, durationMs: 1 };
      },
    }));

    const res = await postRun(app, { prompt: 'new question', omnaiSessionId: sessionId });
    expect(res.status).toBe(200);
    await res.text();

    // History should be prepended to the prompt
    expect(receivedPrompts[0]).toContain('previous question');
    expect(receivedPrompts[0]).toContain('previous answer');
    expect(receivedPrompts[0]).toContain('new question');

    // Clean up seeded session
    await sessionStore.clear(sessionId);
  });

  it('rejects invalid omnaiSessionId', async () => {
    const app = createApp({ estate: mockEstate });
    const res = await postRun(app, { prompt: 'hi', omnaiSessionId: 42 });
    expect(res.status).toBe(400);
    const body = await res.json() as { field?: string };
    expect(body.field).toBe('omnaiSessionId');
  });

  it('stores conversation after run when omnaiSessionId is provided', async () => {
    const app = createApp({ estate: mockEstate });
    const sessionStore = getDaemonSessionStore();
    const sessionId = 'test-store-session';
    await sessionStore.clear(sessionId);

    vi.spyOn(selectModule, 'makeRunner').mockImplementation((engine) => ({
      engine,
      async isAvailable() { return true; },
      async *run() {
        yield { type: 'text', content: 'stored response' };
        yield { type: 'result', output: 'stored response', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, durationMs: 1 };
      },
    }));

    const res = await postRun(app, { prompt: 'store this', omnaiSessionId: sessionId });
    expect(res.status).toBe(200);
    await res.text();

    const history = await sessionStore.load(sessionId);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user', content: 'store this' });
    expect(history[1]).toMatchObject({ role: 'assistant' });

    await sessionStore.clear(sessionId);
  });
});
