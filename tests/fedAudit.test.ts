/**
 * Tests for the GET /fed/audit endpoint.
 *
 * Covers:
 * - Returns entries from the audit log
 * - ?limit=N filtering
 * - ?action=<type> filtering
 * - Combined limit + action filtering
 * - Empty audit log
 * - Invalid limit parameter
 */

import http from 'node:http';
import { readAuditLog } from '../src/auditLog';

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

jest.mock('../src/auditLog', () => ({
  readAuditLog: jest.fn().mockReturnValue([]),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn().mockReturnValue(JSON.stringify({ version: '1.0.0-test' })),
  };
});

import { createSweechFedServer } from '../src/fedServer';

const mockedReadAuditLog = jest.mocked(readAuditLog);

describe('GET /fed/audit', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    port = 19500 + Math.floor(Math.random() * 500);
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

  afterEach(() => {
    mockedReadAuditLog.mockReset();
    mockedReadAuditLog.mockReturnValue([]);
  });

  function doFetch(urlPath: string): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
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

  // ---------------------------------------------------------------------------
  // Basic response structure
  // ---------------------------------------------------------------------------

  test('returns 200 with entries array', async () => {
    const { status, body } = await doFetch('/fed/audit');
    expect(status).toBe(200);
    expect(body).toHaveProperty('entries');
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('timestamp');
  });

  test('returns CORS headers', async () => {
    const { headers } = await doFetch('/fed/audit');
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  test('returns JSON content-type', async () => {
    const { headers } = await doFetch('/fed/audit');
    expect(headers['content-type']).toBe('application/json');
  });

  // ---------------------------------------------------------------------------
  // Empty audit log
  // ---------------------------------------------------------------------------

  test('returns empty entries when no audit log exists', async () => {
    mockedReadAuditLog.mockReturnValue([]);
    const { status, body } = await doFetch('/fed/audit');
    expect(status).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // With audit entries
  // ---------------------------------------------------------------------------

  test('returns audit entries from the log', async () => {
    const mockEntries = [
      { timestamp: '2025-01-01T00:00:00Z', action: 'profile_added', account: 'claude-1' },
      { timestamp: '2025-01-01T01:00:00Z', action: 'token_refreshed', account: 'claude-2' },
    ];
    mockedReadAuditLog.mockReturnValue(mockEntries);

    const { status, body } = await doFetch('/fed/audit');
    expect(status).toBe(200);
    expect(body.entries).toEqual(mockEntries);
    expect(body.total).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // ?limit=N filtering
  // ---------------------------------------------------------------------------

  test('passes limit parameter to readAuditLog', async () => {
    mockedReadAuditLog.mockReturnValue([]);
    await doFetch('/fed/audit?limit=5');

    expect(mockedReadAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 })
    );
  });

  test('ignores invalid limit (non-numeric)', async () => {
    mockedReadAuditLog.mockReturnValue([]);
    await doFetch('/fed/audit?limit=abc');

    // NaN is not > 0, so limit should be undefined
    expect(mockedReadAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined })
    );
  });

  test('ignores zero limit', async () => {
    mockedReadAuditLog.mockReturnValue([]);
    await doFetch('/fed/audit?limit=0');

    expect(mockedReadAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined })
    );
  });

  test('ignores negative limit', async () => {
    mockedReadAuditLog.mockReturnValue([]);
    await doFetch('/fed/audit?limit=-5');

    expect(mockedReadAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined })
    );
  });

  // ---------------------------------------------------------------------------
  // ?action=<type> filtering
  // ---------------------------------------------------------------------------

  test('passes action parameter to readAuditLog', async () => {
    mockedReadAuditLog.mockReturnValue([]);
    await doFetch('/fed/audit?action=profile_added');

    expect(mockedReadAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'profile_added' })
    );
  });

  test('action is undefined when not provided', async () => {
    mockedReadAuditLog.mockReturnValue([]);
    await doFetch('/fed/audit');

    expect(mockedReadAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: undefined })
    );
  });

  // ---------------------------------------------------------------------------
  // Combined filters
  // ---------------------------------------------------------------------------

  test('passes both limit and action when provided', async () => {
    mockedReadAuditLog.mockReturnValue([]);
    await doFetch('/fed/audit?limit=10&action=backup_created');

    expect(mockedReadAuditLog).toHaveBeenCalledWith({
      limit: 10,
      action: 'backup_created',
    });
  });

  // ---------------------------------------------------------------------------
  // total field matches entries length
  // ---------------------------------------------------------------------------

  test('total matches entries count after filtering', async () => {
    const entries = [
      { timestamp: '2025-01-01T00:00:00Z', action: 'profile_added' },
      { timestamp: '2025-01-01T01:00:00Z', action: 'profile_added' },
      { timestamp: '2025-01-01T02:00:00Z', action: 'profile_added' },
    ];
    mockedReadAuditLog.mockReturnValue(entries);

    const { body } = await doFetch('/fed/audit?action=profile_added');
    expect(body.total).toBe(3);
    expect(body.entries).toHaveLength(3);
  });
});
