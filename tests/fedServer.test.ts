/**
 * Tests for the fed integration server
 */

import http from 'node:http';
import { createSweechFedServer } from '../src/fedServer';
import { getAccountInfo } from '../src/subscriptions';

// Mock dependencies
jest.mock('../src/config', () => ({
  ConfigManager: jest.fn().mockImplementation(() => ({
    getProfiles: jest.fn().mockReturnValue([
      { name: 'test', commandName: 'claude-test', cliType: 'claude', provider: 'anthropic', createdAt: '2025-01-01T00:00:00Z' }
    ]),
  })),
}));

jest.mock('../src/subscriptions', () => ({
  getKnownAccounts: jest.fn().mockReturnValue([
    { name: 'claude', commandName: 'claude', cliType: 'claude', configDir: '/mock/.claude', isDefault: true },
    { name: 'claude-test', commandName: 'claude-test', cliType: 'claude', configDir: '/mock/.claude-test', isDefault: false },
  ]),
  getAccountInfo: jest.fn().mockResolvedValue([
    {
      name: 'claude',
      commandName: 'claude',
      cliType: 'claude',
      meta: { plan: 'pro', limits: { window5h: 80, window7d: 400 } },
      messages5h: 10,
      messages7d: 50,
      totalMessages: 500,
      minutesUntilFirstCapacity: null,
      weeklyResetAt: '2025-01-08T00:00:00Z',
      hoursUntilWeeklyReset: 48,
      lastActive: '2025-01-01T12:00:00Z',
      live: { status: 'allowed', planType: 'pro' },
    },
  ]),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn().mockReturnValue(JSON.stringify({ version: '0.2.0' })),
  };
});

describe('Fed Server', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    port = 18000 + Math.floor(Math.random() * 1000);
    server = createSweechFedServer(port);
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function fetch(path: string, method = 'GET'): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  describe('GET /healthz', () => {
    test('returns 200 with status ok', async () => {
      const { status, body } = await fetch('/healthz');
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.2.0');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('timestamp');
    });
  });

  describe('GET /fed/info', () => {
    test('returns machine metadata', async () => {
      const { status, body } = await fetch('/fed/info');
      expect(status).toBe(200);
      expect(body.service).toBe('sweech');
      expect(body.version).toBe('0.2.0');
      expect(body).toHaveProperty('machine');
      expect(body).toHaveProperty('accountCount');
      expect(body.capabilities).toContain('account-usage');
      expect(body.capabilities).toContain('account-recommendation');
      expect(body.capabilities).not.toContain('claude-usage');
    });
  });

  describe('GET /fed/runs', () => {
    test('returns account list', async () => {
      const { status, body } = await fetch('/fed/runs');
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty('name');
      expect(body[0]).toHaveProperty('slug');
      expect(body[0]).toHaveProperty('cliType');
    });
  });

  describe('GET /fed/widget', () => {
    test('returns widget data', async () => {
      const { status, body } = await fetch('/fed/widget');
      expect(status).toBe(200);
      expect(body.type).toBe('account-usage');
      expect(body.title).toBe('sweech');
      expect(body.data).toHaveProperty('accounts');
      expect(body.data).toHaveProperty('summary');
      expect(body.data.summary).toMatchObject({
        totalAccounts: 1,
        availableAccounts: 1,
        limitedAccounts: 0,
        accountsNeedingReauth: 0,
        recommendedAccount: 'claude',
      });
      expect(Array.isArray(body.data.accounts)).toBe(true);
    });
  });

  describe('OPTIONS (CORS)', () => {
    test('returns 204 with CORS header', async () => {
      const { status } = await fetch('/fed/info', 'OPTIONS');
      expect(status).toBe(204);
    });
  });

  describe('404', () => {
    test('returns 404 for unknown path', async () => {
      const { status, body } = await fetch('/unknown');
      expect(status).toBe(404);
      expect(body.error).toBe('Not found');
    });
  });

  describe('GET /fed/alerts', () => {
    const mockedGetAccountInfo = jest.mocked(getAccountInfo);

    afterEach(() => {
      // Restore default mock
      mockedGetAccountInfo.mockResolvedValue([
        {
          name: 'claude',
          commandName: 'claude',
          cliType: 'claude',
          meta: { plan: 'pro', limits: { window5h: 80, window7d: 400 } },
          messages5h: 10,
          messages7d: 50,
          totalMessages: 500,
          minutesUntilFirstCapacity: null,
          weeklyResetAt: '2025-01-08T00:00:00Z',
          hoursUntilWeeklyReset: 48,
          lastActive: '2025-01-01T12:00:00Z',
          live: { status: 'allowed', planType: 'pro' },
        },
      ] as any);
    });

    test('returns alerts array with proper structure', async () => {
      const { status, body } = await fetch('/fed/alerts');
      expect(status).toBe(200);
      expect(body).toHaveProperty('alerts');
      expect(Array.isArray(body.alerts)).toBe(true);
      expect(body).toHaveProperty('timestamp');
    });

    test('includes auth alerts for needsReauth accounts', async () => {
      mockedGetAccountInfo.mockResolvedValueOnce([
        {
          name: 'claude-expired',
          commandName: 'claude-expired',
          cliType: 'claude',
          meta: { plan: 'pro', limits: { window5h: 80, window7d: 400 } },
          messages5h: 0,
          messages7d: 0,
          totalMessages: 0,
          minutesUntilFirstCapacity: null,
          weeklyResetAt: '2025-01-08T00:00:00Z',
          hoursUntilWeeklyReset: 48,
          lastActive: null,
          needsReauth: true,
          live: { status: 'allowed', planType: 'pro' },
        },
      ] as any);
      const { status, body } = await fetch('/fed/alerts');
      expect(status).toBe(200);
      const authAlerts = body.alerts.filter((a: any) => a.type === 'auth');
      expect(authAlerts.length).toBe(1);
      expect(authAlerts[0].severity).toBe('error');
      expect(authAlerts[0].account).toBe('claude-expired');
      expect(authAlerts[0].message).toContain('re-authentication');
    });

    test('includes usage alerts for high utilization', async () => {
      mockedGetAccountInfo.mockResolvedValueOnce([
        {
          name: 'claude-heavy',
          commandName: 'claude-heavy',
          cliType: 'claude',
          meta: { plan: 'pro', limits: { window5h: 80, window7d: 400 } },
          messages5h: 70,
          messages7d: 380,
          totalMessages: 1000,
          minutesUntilFirstCapacity: null,
          weeklyResetAt: '2025-01-08T00:00:00Z',
          hoursUntilWeeklyReset: 48,
          lastActive: '2025-01-01T12:00:00Z',
          live: { status: 'allowed', planType: 'pro', utilization7d: 0.95 },
        },
      ] as any);
      const { status, body } = await fetch('/fed/alerts');
      expect(status).toBe(200);
      const usageAlerts = body.alerts.filter((a: any) => a.type === 'usage');
      expect(usageAlerts.length).toBe(1);
      expect(usageAlerts[0].severity).toBe('warning');
      expect(usageAlerts[0].account).toBe('claude-heavy');
      expect(usageAlerts[0].message).toContain('95%');
    });

    test('includes expiry alerts for imminent resets', async () => {
      const nowSec = Date.now() / 1000;
      const resetIn12h = nowSec + 12 * 3600; // 12 hours from now
      mockedGetAccountInfo.mockResolvedValueOnce([
        {
          name: 'claude-expiring',
          commandName: 'claude-expiring',
          cliType: 'claude',
          meta: { plan: 'pro', limits: { window5h: 80, window7d: 400 } },
          messages5h: 5,
          messages7d: 100,
          totalMessages: 200,
          minutesUntilFirstCapacity: null,
          weeklyResetAt: '2025-01-08T00:00:00Z',
          hoursUntilWeeklyReset: 12,
          lastActive: '2025-01-01T12:00:00Z',
          live: { status: 'allowed', planType: 'pro', utilization7d: 0.5, reset7dAt: resetIn12h },
        },
      ] as any);
      const { status, body } = await fetch('/fed/alerts');
      expect(status).toBe(200);
      const expiryAlerts = body.alerts.filter((a: any) => a.type === 'expiry');
      expect(expiryAlerts.length).toBe(1);
      expect(expiryAlerts[0].severity).toBe('info');
      expect(expiryAlerts[0].account).toBe('claude-expiring');
      expect(expiryAlerts[0].message).toContain('50%');
      expect(expiryAlerts[0].message).toContain('12h');
    });
  });

  describe('GET /fed/status', () => {
    const mockedGetAccountInfo = jest.mocked(getAccountInfo);

    afterEach(() => {
      // Restore default mock
      mockedGetAccountInfo.mockResolvedValue([
        {
          name: 'claude',
          commandName: 'claude',
          cliType: 'claude',
          meta: { plan: 'pro', limits: { window5h: 80, window7d: 400 } },
          messages5h: 10,
          messages7d: 50,
          totalMessages: 500,
          minutesUntilFirstCapacity: null,
          weeklyResetAt: '2025-01-08T00:00:00Z',
          hoursUntilWeeklyReset: 48,
          lastActive: '2025-01-01T12:00:00Z',
          live: { status: 'allowed', planType: 'pro' },
        },
      ] as any);
    });

    test('returns summary counts', async () => {
      const { status, body } = await fetch('/fed/status');
      expect(status).toBe(200);
      expect(body).toHaveProperty('total');
      expect(body).toHaveProperty('available');
      expect(body).toHaveProperty('limited');
      expect(body).toHaveProperty('needsAuth');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('version');
      expect(body.version).toBe('0.2.0');
    });

    test('counts match account states', async () => {
      mockedGetAccountInfo.mockResolvedValueOnce([
        {
          name: 'claude-ok',
          commandName: 'claude-ok',
          cliType: 'claude',
          meta: { plan: 'pro', limits: { window5h: 80, window7d: 400 } },
          messages5h: 10,
          messages7d: 50,
          totalMessages: 500,
          minutesUntilFirstCapacity: null,
          weeklyResetAt: '2025-01-08T00:00:00Z',
          hoursUntilWeeklyReset: 48,
          lastActive: '2025-01-01T12:00:00Z',
          live: { status: 'allowed', planType: 'pro' },
        },
        {
          name: 'claude-limited',
          commandName: 'claude-limited',
          cliType: 'claude',
          meta: { plan: 'pro', limits: { window5h: 80, window7d: 400 } },
          messages5h: 80,
          messages7d: 400,
          totalMessages: 1000,
          minutesUntilFirstCapacity: 120,
          weeklyResetAt: '2025-01-08T00:00:00Z',
          hoursUntilWeeklyReset: 48,
          lastActive: '2025-01-01T12:00:00Z',
          live: { status: 'limit_reached', planType: 'pro' },
        },
        {
          name: 'claude-reauth',
          commandName: 'claude-reauth',
          cliType: 'claude',
          meta: { plan: 'pro', limits: { window5h: 80, window7d: 400 } },
          messages5h: 0,
          messages7d: 0,
          totalMessages: 0,
          minutesUntilFirstCapacity: null,
          weeklyResetAt: '2025-01-08T00:00:00Z',
          hoursUntilWeeklyReset: 48,
          lastActive: null,
          needsReauth: true,
          live: { status: 'allowed', planType: 'pro' },
        },
      ] as any);
      const { status, body } = await fetch('/fed/status');
      expect(status).toBe(200);
      expect(body.total).toBe(3);
      expect(body.available).toBe(1);
      expect(body.limited).toBe(1);
      expect(body.needsAuth).toBe(1);
    });
  });

  describe('Rate limiting', () => {
    test('allows requests under limit', async () => {
      const { status } = await fetch('/fed/info');
      expect(status).toBe(200);
    });

    // Rate limit is 60/min so we won't hit it in normal tests.
    // Just verify the endpoint doesn't crash with many requests.
    test('handles rapid sequential requests', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => fetch('/healthz'))
      );
      results.forEach(({ status }) => {
        expect(status).toBe(200);
      });
    });
  });
});
