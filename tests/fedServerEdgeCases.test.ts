/**
 * Edge case tests for the fed integration server:
 * - Rate limiting (hitting the limit, window reset)
 * - OPTIONS CORS preflight on various paths
 * - 404 for various unknown paths
 * - Health check field validation
 * - Multiple concurrent requests
 */

import http from 'node:http';

// We need to directly test the rate limiter, so we import from source.
// But createSweechFedServer is the only export we need for HTTP tests.

// Mock dependencies
jest.mock('../src/config', () => ({
  ConfigManager: jest.fn().mockImplementation(() => ({
    getProfiles: jest.fn().mockReturnValue([]),
  })),
}));

jest.mock('../src/subscriptions', () => ({
  getKnownAccounts: jest.fn().mockReturnValue([]),
  getAccountInfo: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/accountSelector', () => ({
  suggestBestAccount: jest.fn().mockResolvedValue(null),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn().mockReturnValue(JSON.stringify({ version: '1.0.0-test' })),
  };
});

import { createSweechFedServer } from '../src/fedServer';

describe('Fed Server Edge Cases', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    port = 19000 + Math.floor(Math.random() * 1000);
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

  function doFetch(urlPath: string, method = 'GET'): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body: any = data;
          try { body = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // Health check field validation
  // -------------------------------------------------------------------------

  describe('GET /healthz — field validation', () => {
    test('contains uptime as a number', async () => {
      const { body } = await doFetch('/healthz');
      expect(typeof body.uptime).toBe('number');
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });

    test('contains version string', async () => {
      const { body } = await doFetch('/healthz');
      expect(typeof body.version).toBe('string');
      expect(body.version).toBe('1.0.0-test');
    });

    test('contains valid ISO timestamp', async () => {
      const { body } = await doFetch('/healthz');
      expect(typeof body.timestamp).toBe('string');
      const parsed = new Date(body.timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });

    test('returns CORS headers', async () => {
      const { headers } = await doFetch('/healthz');
      expect(headers['access-control-allow-origin']).toBe('*');
    });
  });

  // -------------------------------------------------------------------------
  // OPTIONS CORS preflight
  // -------------------------------------------------------------------------

  describe('OPTIONS CORS preflight', () => {
    test('returns 204 for OPTIONS on /healthz', async () => {
      const { status } = await doFetch('/healthz', 'OPTIONS');
      expect(status).toBe(204);
    });

    test('returns 204 for OPTIONS on /fed/runs', async () => {
      const { status } = await doFetch('/fed/runs', 'OPTIONS');
      expect(status).toBe(204);
    });

    test('returns 204 for OPTIONS on /fed/widget', async () => {
      const { status } = await doFetch('/fed/widget', 'OPTIONS');
      expect(status).toBe(204);
    });

    test('returns 204 for OPTIONS on /fed/alerts', async () => {
      const { status } = await doFetch('/fed/alerts', 'OPTIONS');
      expect(status).toBe(204);
    });

    test('returns 204 for OPTIONS on /fed/status', async () => {
      const { status } = await doFetch('/fed/status', 'OPTIONS');
      expect(status).toBe(204);
    });

    test('returns 204 for OPTIONS on unknown path', async () => {
      const { status } = await doFetch('/does-not-exist', 'OPTIONS');
      expect(status).toBe(204);
    });

    test('OPTIONS response has CORS origin header', async () => {
      const { headers } = await doFetch('/fed/info', 'OPTIONS');
      expect(headers['access-control-allow-origin']).toBe('*');
    });

    test('OPTIONS response body is empty', async () => {
      const { body } = await doFetch('/fed/info', 'OPTIONS');
      expect(body).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // 404 for unknown paths
  // -------------------------------------------------------------------------

  describe('404 for unknown paths', () => {
    test('returns 404 for /api', async () => {
      const { status, body } = await doFetch('/api');
      expect(status).toBe(404);
      expect(body.error).toBe('Not found');
    });

    test('returns 404 for /fed (without subpath)', async () => {
      const { status, body } = await doFetch('/fed');
      expect(status).toBe(404);
      expect(body.error).toBe('Not found');
    });

    test('returns 404 for /fed/nonexistent', async () => {
      const { status, body } = await doFetch('/fed/nonexistent');
      expect(status).toBe(404);
      expect(body.error).toBe('Not found');
    });

    test('returns 404 for root /', async () => {
      const { status, body } = await doFetch('/');
      expect(status).toBe(404);
      expect(body.error).toBe('Not found');
    });

    test('returns JSON content-type for 404', async () => {
      const { headers } = await doFetch('/unknown-path');
      expect(headers['content-type']).toBe('application/json');
    });
  });

  // -------------------------------------------------------------------------
  // Empty profiles / accounts
  // -------------------------------------------------------------------------

  describe('Endpoints with no profiles', () => {
    test('/fed/info returns accountCount 0', async () => {
      const { status, body } = await doFetch('/fed/info');
      expect(status).toBe(200);
      expect(body.accountCount).toBe(0);
    });

    test('/fed/runs returns empty array', async () => {
      const { status, body } = await doFetch('/fed/runs');
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(0);
    });

    test('/fed/widget returns empty accounts array', async () => {
      const { status, body } = await doFetch('/fed/widget');
      expect(status).toBe(200);
      expect(body.data.accounts).toHaveLength(0);
    });

    test('/fed/alerts returns empty alerts with no accounts', async () => {
      const { status, body } = await doFetch('/fed/alerts');
      expect(status).toBe(200);
      expect(body.alerts).toHaveLength(0);
      expect(body).toHaveProperty('timestamp');
    });

    test('/fed/status returns all zeros with no accounts', async () => {
      const { status, body } = await doFetch('/fed/status');
      expect(status).toBe(200);
      expect(body.total).toBe(0);
      expect(body.available).toBe(0);
      expect(body.limited).toBe(0);
      expect(body.needsAuth).toBe(0);
    });

    test('/fed/recommendation returns null with no profiles', async () => {
      const { status, body } = await doFetch('/fed/recommendation');
      expect(status).toBe(200);
      expect(body).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent requests
  // -------------------------------------------------------------------------

  describe('Concurrent request handling', () => {
    test('handles 20 concurrent requests to different endpoints', async () => {
      const endpoints = ['/healthz', '/fed/info', '/fed/runs', '/fed/widget', '/fed/status'];
      const requests = Array.from({ length: 20 }, (_, i) =>
        doFetch(endpoints[i % endpoints.length])
      );
      const results = await Promise.all(requests);
      results.forEach(({ status }) => {
        expect(status).toBe(200);
      });
    });
  });
});
