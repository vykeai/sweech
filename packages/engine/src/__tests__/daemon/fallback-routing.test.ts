import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, clearEstateCache, setDaemonLifecycleState } from '../../daemon/server.js';
import { QuotaTracker } from '../../daemon/quota.js';
import type { Estate } from '../../estate.js';

vi.mock('@vykeai/fed', () => ({
  FedEventClient: class { publish() { return Promise.resolve({}); } },
}));

vi.mock('../../detect.js', () => ({
  detectEngines: vi.fn().mockResolvedValue([
    { engine: 'claude-code', available: true, binaryPath: '/usr/bin/claude', providers: ['claude'] },
    { engine: 'copilot', available: true, binaryPath: '/usr/bin/copilot', providers: ['github'] },
    { engine: 'gemini-cli', available: true, binaryPath: '/usr/bin/gemini', providers: ['gemini'] },
  ]),
}));

vi.mock('../../select.js', async () => {
  const actual = await vi.importActual<typeof import('../../select.js')>('../../select.js');
  return {
    ...actual,
    makeRunner: vi.fn(),
  };
});

const originalFetch = globalThis.fetch;
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sweech in test')));

function makeEstate(): Estate {
  return {
    version: 1,
    accounts: {
      'claude-max': {
        provider: 'claude',
        engine: 'claude-code',
        type: 'free-tier',
        quota: { period: 'daily', limit: 5 },
      },
      'copilot-sub': {
        provider: 'github',
        engine: 'copilot',
        type: 'free-tier',
        quota: { period: 'daily', limit: 3 },
      },
      'gemini-free': {
        provider: 'gemini',
        engine: 'gemini-cli',
        type: 'free-tier',
        quota: { period: 'daily', limit: 10 },
      },
    },
    failoverOrder: ['claude-max', 'copilot-sub', 'gemini-free'],
  };
}

function tmpStatePath(): string {
  return `/tmp/omnai-fallback-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
}

function postSelect(app: ReturnType<typeof createApp>, body: Record<string, unknown> = {}) {
  return app.request('/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('quota-aware fallback routing', () => {
  const trackers: QuotaTracker[] = [];

  function createTracker(estate: Estate): QuotaTracker {
    const t = new QuotaTracker(estate, tmpStatePath());
    trackers.push(t);
    return t;
  }

  beforeEach(() => {
    clearEstateCache();
    setDaemonLifecycleState('ready', 'test');
    for (const t of trackers) t.destroy();
    trackers.length = 0;
  });

  it('returns first matching account when all have quota', async () => {
    const estate = makeEstate();
    const tracker = createTracker(estate);
    const app = createApp({ estate, quotaTracker: tracker });

    const res = await postSelect(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('claude-code');
    expect(body.account).toBe('claude-max');
    expect(body.fallbackReason).toBeUndefined();
  });

  it('falls back to next account when primary is exhausted', async () => {
    const estate = makeEstate();
    const tracker = createTracker(estate);

    for (let i = 0; i < 5; i++) {
      tracker.recordUsage('claude-max', 100, 0.01);
    }

    const app = createApp({ estate, quotaTracker: tracker });
    const res = await postSelect(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('copilot');
    expect(body.account).toBe('copilot-sub');
    expect(body.fallbackReason).toBe('claude-max quota exceeded, fell back to copilot-sub');
  });

  it('skips non-matching accounts when filtering by provider', async () => {
    const estate = makeEstate();
    const tracker = createTracker(estate);
    const app = createApp({ estate, quotaTracker: tracker });

    const res = await postSelect(app, { provider: 'gemini' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('gemini-cli');
    expect(body.account).toBe('gemini-free');
  });

  it('skips non-matching accounts when filtering by engine', async () => {
    const estate = makeEstate();
    const tracker = createTracker(estate);
    const app = createApp({ estate, quotaTracker: tracker });

    const res = await postSelect(app, { engine: 'copilot' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('copilot');
    expect(body.account).toBe('copilot-sub');
  });

  it('returns 503 when all accounts are exhausted', async () => {
    const estate = makeEstate();
    const tracker = createTracker(estate);

    for (let i = 0; i < 5; i++) {
      tracker.recordUsage('claude-max', 100, 0.01);
    }
    for (let i = 0; i < 3; i++) {
      tracker.recordUsage('copilot-sub', 100, 0.01);
    }
    for (let i = 0; i < 10; i++) {
      tracker.recordUsage('gemini-free', 100, 0.01);
    }

    const app = createApp({ estate, quotaTracker: tracker });
    const res = await postSelect(app);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('All accounts in failoverOrder exhausted');
    expect(body.fallbackReason).toContain('quota exceeded');
  });

  it('falls back to basic select() when no quotaTracker', async () => {
    const app = createApp();
    const res = await postSelect(app, { provider: 'claude' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('claude-code');
    expect(body.account).toBeUndefined();
  });

  it('includes fallbackReason listing all skipped accounts', async () => {
    const estate = makeEstate();
    const tracker = createTracker(estate);

    for (let i = 0; i < 5; i++) {
      tracker.recordUsage('claude-max', 100, 0.01);
    }
    for (let i = 0; i < 3; i++) {
      tracker.recordUsage('copilot-sub', 100, 0.01);
    }

    const app = createApp({ estate, quotaTracker: tracker });
    const res = await postSelect(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.engine).toBe('gemini-cli');
    expect(body.account).toBe('gemini-free');
    expect(body.fallbackReason).toBe('claude-max, copilot-sub quota exceeded, fell back to gemini-free');
  });
});
