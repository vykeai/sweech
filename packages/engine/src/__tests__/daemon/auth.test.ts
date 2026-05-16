/// T-039: HMAC auth on the sweech daemon. These tests sit at the seam
/// between `createApp({ auth })` and the auth middleware so we exercise
/// real Hono routing instead of unit-testing the middleware in isolation.
///
/// Coverage:
///   - secret generation lifecycle (lazy create, idempotent, 0600)
///   - public probes pass without auth
///   - protected routes return 401 without a signature
///   - protected routes return 401 with the wrong signature
///   - protected routes return 401 with a stale timestamp
///   - protected routes return 200 with a valid signature
///   - signature is path-bound (signing /healthz won't pass for /run)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrCreateSecret,
  getSecretFileMode,
  resetSecretCacheForTesting,
  signRequest,
  computeSignature,
  SWEECH_AUTH_HEADER,
  SWEECH_TS_HEADER,
  SWEECH_TS_SKEW_MS,
} from '../../daemon/auth.js';
import { createApp, clearEstateCache, setDaemonLifecycleState } from '../../daemon/server.js';

// fed mock — the daemon publishes events to it during /run; we never want
// real network here.
vi.mock('@vykeai/fed', () => ({
  FedEventClient: class { publish() { return Promise.resolve({}); } },
}));

// detectEngines is exercised by /run setup — return a fixed list.
vi.mock('../../detect.js', () => ({
  detectEngines: vi.fn().mockResolvedValue([
    { engine: 'claude-code', available: true, binaryPath: '/usr/bin/claude', providers: ['claude'] },
  ]),
}));

// Block any accidental real-network fetch (e.g. loadSweechTelemetry).
globalThis.fetch = vi.fn().mockRejectedValue(new Error('no network in test')) as typeof fetch;

const TEST_SECRET = 'a'.repeat(64); // 32 bytes hex

function buildAuth(method: string, pathWithQuery: string, body: string, secret = TEST_SECRET, ts = Date.now()) {
  const sig = computeSignature(secret, method, pathWithQuery, body, ts);
  return {
    [SWEECH_AUTH_HEADER]: sig,
    [SWEECH_TS_HEADER]: String(ts),
  };
}

describe('daemon auth — secret lifecycle', () => {
  let dir: string;
  let secretPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sweech-auth-test-'));
    secretPath = join(dir, 'daemon.secret');
    resetSecretCacheForTesting();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    resetSecretCacheForTesting();
  });

  it('creates ~/.sweech/daemon.secret with mode 0600 on first call', async () => {
    const secret = await loadOrCreateSecret(secretPath);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const mode = await getSecretFileMode(secretPath);
    expect(mode).toBe(0o600);
  });

  it('returns the same secret on repeat calls (no rotation)', async () => {
    const a = await loadOrCreateSecret(secretPath);
    const b = await loadOrCreateSecret(secretPath);
    expect(b).toBe(a);
  });

  it('reads an existing secret file without rewriting it', async () => {
    await writeFile(secretPath, TEST_SECRET + '\n', { mode: 0o600 });
    const before = await stat(secretPath);
    const secret = await loadOrCreateSecret(secretPath);
    const after = await stat(secretPath);
    expect(secret).toBe(TEST_SECRET);
    // mtime should be unchanged — we only read it.
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('normalises lax file modes back to 0600 only on creation', async () => {
    // Pre-existing secret with bad perms — we read it as-is. (Tightening
    // is a separate concern; here we just assert we don't loosen it.)
    await writeFile(secretPath, TEST_SECRET + '\n', { mode: 0o644 });
    await chmod(secretPath, 0o644);
    const secret = await loadOrCreateSecret(secretPath);
    expect(secret).toBe(TEST_SECRET);
    const mode = await getSecretFileMode(secretPath);
    expect(mode).toBe(0o644);
  });
});

describe('daemon auth — middleware over Hono', () => {
  beforeEach(() => {
    clearEstateCache();
    setDaemonLifecycleState('ready');
    vi.restoreAllMocks();
  });

  it('lets /healthz through without a signature', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('lets /health through without a signature', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('rejects /check and /check/all without a signature (401)', async () => {
    // Security MED-1 from Phase 2 review: these routes enumerate every
    // configured profile + reachability + suggestedFallback, which is
    // useful intel for any local process the user didn't authorise.
    // Loopback ≠ security boundary on multi-user macOS.
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const res = await app.request('/check?profile=nope');
    expect(res.status).toBe(401);

    const resAll = await app.request('/check/all');
    expect(resAll.status).toBe(401);
  });

  it('rejects /run without auth headers (401)', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const res = await app.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('rejects /select without auth headers (401)', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const res = await app.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects /run with a wrong signature (401)', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const body = JSON.stringify({ prompt: 'hi' });
    const headers = buildAuth('POST', '/run', body, 'b'.repeat(64));
    const res = await app.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.reason).toBe('signature mismatch');
  });

  it('rejects a signature whose timestamp is outside the replay window', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const body = JSON.stringify({ prompt: 'hi' });
    const oldTs = Date.now() - SWEECH_TS_SKEW_MS - 1_000;
    const headers = buildAuth('POST', '/run', body, TEST_SECRET, oldTs);
    const res = await app.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.reason).toBe('timestamp outside replay window');
  });

  it('rejects a non-numeric timestamp', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const res = await app.request('/select', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SWEECH_AUTH_HEADER]: 'deadbeef',
        [SWEECH_TS_HEADER]: 'not-a-number',
      },
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.reason).toBe('invalid timestamp');
  });

  it('rejects a signature computed for a different path (path-bound)', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const body = JSON.stringify({ prompt: 'hi' });
    // Sign /select then try to use the headers against /run.
    const headers = buildAuth('POST', '/select', body, TEST_SECRET);
    const res = await app.request('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('admits /select with a valid signature', async () => {
    // /select hits resolveSelectionTarget which may read from disk; we only
    // care that the middleware lets it through (not 401). The handler may
    // return 200/400/503 depending on environment — that's fine.
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const body = JSON.stringify({ provider: 'claude' });
    const headers = buildAuth('POST', '/select', body, TEST_SECRET);
    const res = await app.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).not.toBe(401);
  });

  it('signRequest helper produces headers that round-trip with the middleware', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const body = JSON.stringify({ provider: 'claude' });
    const { headers } = signRequest(TEST_SECRET, 'POST', '/select', body);
    const res = await app.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).not.toBe(401);
  });

  it('keeps GET endpoints reachable on protected paths with a signed GET', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const headers = buildAuth('GET', '/engines', '', TEST_SECRET);
    const res = await app.request('/engines', { method: 'GET', headers });
    expect(res.status).toBe(200);
  });

  it('rejects unsigned GET on a protected endpoint', async () => {
    const app = createApp({ auth: { enabled: true, getSecret: async () => TEST_SECRET } });
    const res = await app.request('/engines', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('passes through everything when auth is disabled (test default)', async () => {
    // createApp() without `auth` — current existing-test posture.
    const app = createApp();
    const res = await app.request('/engines');
    expect(res.status).toBe(200);
  });

  it('bubbles up an error from the secret loader as 401', async () => {
    const app = createApp({
      auth: {
        enabled: true,
        getSecret: async () => { throw new Error('disk on fire'); },
      },
    });
    const body = JSON.stringify({ provider: 'claude' });
    const headers = buildAuth('POST', '/select', body, TEST_SECRET);
    const res = await app.request('/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.reason).toBe('server secret unavailable');
  });
});
