/**
 * Tests for the auto-update checker module.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import {
  isNewerVersion,
  readCache,
  writeCache,
  checkForUpdate,
  fetchLatestVersion,
  fetchChangelog,
} from '../src/updateChecker';

jest.mock('fs');
jest.mock('https');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockHttps = https as jest.Mocked<typeof https>;

const CACHE_FILE = path.join(os.homedir(), '.sweech', 'update-check.json');

// Helper: create a mock HTTP response that emits data then end
function makeMockRes(body: string): { on: jest.Mock } {
  const res: { on: jest.Mock } = {
    on: jest.fn(),
  };
  res.on.mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
    if (event === 'data') cb(Buffer.from(body));
    if (event === 'end') cb();
    return res;
  });
  return res;
}

// Helper: create a mock HTTP request that fires an error immediately
function makeMockReqError(): { on: jest.Mock; destroy: jest.Mock } {
  const req: { on: jest.Mock; destroy: jest.Mock } = {
    on: jest.fn(),
    destroy: jest.fn(),
  };
  req.on.mockImplementation((event: string, cb: () => void) => {
    if (event === 'error') cb();
    return req;
  });
  return req;
}

// Helper: create a mock HTTP request that does nothing (for success cases)
function makeMockReqOk(): { on: jest.Mock; destroy: jest.Mock } {
  const req: { on: jest.Mock; destroy: jest.Mock } = {
    on: jest.fn(),
    destroy: jest.fn(),
  };
  req.on.mockReturnValue(req);
  return req;
}

describe('updateChecker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── isNewerVersion ─────────────────────────────────────────────────────────

  describe('isNewerVersion', () => {
    test('returns true when latest major is greater', () => {
      expect(isNewerVersion('0.2.0', '1.0.0')).toBe(true);
    });

    test('returns true when latest minor is greater', () => {
      expect(isNewerVersion('0.2.0', '0.3.0')).toBe(true);
    });

    test('returns true when latest patch is greater', () => {
      expect(isNewerVersion('0.2.0', '0.2.1')).toBe(true);
    });

    test('returns false when versions are equal', () => {
      expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    });

    test('returns false when current is newer', () => {
      expect(isNewerVersion('1.0.0', '0.9.0')).toBe(false);
    });

    test('handles v prefix in version strings', () => {
      expect(isNewerVersion('v0.2.0', 'v0.3.0')).toBe(true);
      expect(isNewerVersion('v1.0.0', 'v0.9.0')).toBe(false);
    });

    test('handles two-part version strings', () => {
      expect(isNewerVersion('0.2', '0.3')).toBe(true);
      expect(isNewerVersion('1.0', '0.9')).toBe(false);
    });

    test('handles single-part version strings', () => {
      expect(isNewerVersion('1', '2')).toBe(true);
      expect(isNewerVersion('2', '1')).toBe(false);
    });

    test('returns false for identical versions with v prefix mismatch', () => {
      expect(isNewerVersion('v0.2.0', '0.2.0')).toBe(false);
      expect(isNewerVersion('0.2.0', 'v0.2.0')).toBe(false);
    });

    test('handles large version numbers', () => {
      expect(isNewerVersion('10.20.30', '10.20.31')).toBe(true);
      expect(isNewerVersion('10.20.30', '10.21.0')).toBe(true);
    });
  });

  // ── readCache ──────────────────────────────────────────────────────────────

  describe('readCache', () => {
    test('returns null when cache file does not exist', () => {
      mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      expect(readCache()).toBeNull();
    });

    test('returns cached data when within TTL', () => {
      const now = Date.now();
      const cache = { timestamp: now - 1000, latest: '0.3.0' };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));
      const result = readCache(now);
      expect(result).toEqual(cache);
    });

    test('returns null when cache is stale (>24h)', () => {
      const now = Date.now();
      const staleTimestamp = now - (25 * 60 * 60 * 1000); // 25 hours ago
      const cache = { timestamp: staleTimestamp, latest: '0.3.0' };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));
      expect(readCache(now)).toBeNull();
    });

    test('returns cached data at exactly 23h59m (within TTL)', () => {
      const now = Date.now();
      const almostStale = now - (23 * 60 * 60 * 1000 + 59 * 60 * 1000);
      const cache = { timestamp: almostStale, latest: '0.3.0' };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));
      expect(readCache(now)).toEqual(cache);
    });

    test('returns null at exactly 24h (boundary)', () => {
      const now = Date.now();
      const exactly24h = now - (24 * 60 * 60 * 1000);
      const cache = { timestamp: exactly24h, latest: '0.3.0' };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));
      expect(readCache(now)).toBeNull();
    });

    test('returns null for invalid JSON in cache file', () => {
      mockFs.readFileSync.mockReturnValue('not-json{{{');
      expect(readCache()).toBeNull();
    });
  });

  // ── writeCache ─────────────────────────────────────────────────────────────

  describe('writeCache', () => {
    test('writes cache file with timestamp and latest version', () => {
      mockFs.existsSync.mockReturnValue(true);
      const now = 1700000000000;
      writeCache('0.3.0', now);
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        CACHE_FILE,
        JSON.stringify({ timestamp: now, latest: '0.3.0' }, null, 2),
        'utf-8',
      );
    });

    test('creates cache directory if missing', () => {
      mockFs.existsSync.mockReturnValue(false);
      writeCache('0.3.0');
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        path.join(os.homedir(), '.sweech'),
        { recursive: true },
      );
    });

    test('does not throw when write fails', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.writeFileSync.mockImplementation(() => { throw new Error('EACCES'); });
      expect(() => writeCache('0.3.0')).not.toThrow();
    });
  });

  // ── fetchLatestVersion ─────────────────────────────────────────────────────

  describe('fetchLatestVersion', () => {
    test('returns version from npm registry response', async () => {
      const mockRes = makeMockRes(JSON.stringify({ version: '0.4.0' }));
      const mockReq = makeMockReqOk();
      mockHttps.get.mockImplementation((_url: any, _opts: any, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const result = await fetchLatestVersion(5000);
      expect(result).toBe('0.4.0');
    });

    test('returns null on network error', async () => {
      const mockReq = makeMockReqError();
      mockHttps.get.mockImplementation(() => mockReq as any);

      const result = await fetchLatestVersion(1000);
      expect(result).toBeNull();
    });

    test('returns null on invalid JSON response', async () => {
      const mockRes = makeMockRes('not-json');
      const mockReq = makeMockReqOk();
      mockHttps.get.mockImplementation((_url: any, _opts: any, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const result = await fetchLatestVersion(5000);
      expect(result).toBeNull();
    });

    test('returns null when response lacks version field', async () => {
      const mockRes = makeMockRes(JSON.stringify({ name: 'sweech' }));
      const mockReq = makeMockReqOk();
      mockHttps.get.mockImplementation((_url: any, _opts: any, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const result = await fetchLatestVersion(5000);
      expect(result).toBeNull();
    });
  });

  // ── fetchChangelog ─────────────────────────────────────────────────────────

  describe('fetchChangelog', () => {
    test('returns formatted release notes for newer versions', async () => {
      const releases = [
        { tag_name: 'v0.4.0', name: 'v0.4.0', body: 'New features' },
        { tag_name: 'v0.3.0', name: 'v0.3.0', body: 'Bug fixes' },
        { tag_name: 'v0.2.0', name: 'v0.2.0', body: 'Initial release' },
      ];
      const mockRes = makeMockRes(JSON.stringify(releases));
      const mockReq = makeMockReqOk();
      mockHttps.get.mockImplementation((_opts: any, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const result = await fetchChangelog('0.2.0', '0.4.0', 5000);
      expect(result).toContain('v0.4.0');
      expect(result).toContain('New features');
      expect(result).toContain('v0.3.0');
      expect(result).toContain('Bug fixes');
      // Should NOT include v0.2.0 (current version)
      expect(result).not.toContain('Initial release');
    });

    test('returns null when no newer releases exist', async () => {
      const releases = [
        { tag_name: 'v0.2.0', name: 'v0.2.0', body: 'Initial release' },
      ];
      const mockRes = makeMockRes(JSON.stringify(releases));
      const mockReq = makeMockReqOk();
      mockHttps.get.mockImplementation((_opts: any, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const result = await fetchChangelog('0.2.0', '0.2.0', 5000);
      expect(result).toBeNull();
    });

    test('returns null on network error', async () => {
      const mockReq = makeMockReqError();
      mockHttps.get.mockImplementation(() => mockReq as any);

      const result = await fetchChangelog('0.2.0', '0.3.0', 1000);
      expect(result).toBeNull();
    });

    test('returns null when response is not an array', async () => {
      const mockRes = makeMockRes(JSON.stringify({ message: 'rate limited' }));
      const mockReq = makeMockReqOk();
      mockHttps.get.mockImplementation((_opts: any, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const result = await fetchChangelog('0.2.0', '0.3.0', 5000);
      expect(result).toBeNull();
    });
  });

  // ── checkForUpdate ─────────────────────────────────────────────────────────

  describe('checkForUpdate', () => {
    test('returns cached result when cache is fresh', async () => {
      const now = Date.now();
      const cache = { timestamp: now - 1000, latest: '0.3.0' };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      const result = await checkForUpdate('0.2.0', now);
      expect(result).toEqual({
        current: '0.2.0',
        latest: '0.3.0',
        updateAvailable: true,
      });
      // Should NOT have made any network calls
      expect(mockHttps.get).not.toHaveBeenCalled();
    });

    test('returns no-update when cached version equals current', async () => {
      const now = Date.now();
      const cache = { timestamp: now - 1000, latest: '0.2.0' };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      const result = await checkForUpdate('0.2.0', now);
      expect(result).toEqual({
        current: '0.2.0',
        latest: '0.2.0',
        updateAvailable: false,
      });
    });

    test('fetches from npm and writes cache when cache is stale', async () => {
      const now = Date.now();
      // Stale cache
      mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      mockFs.existsSync.mockReturnValue(true);

      const mockRes = makeMockRes(JSON.stringify({ version: '0.5.0' }));
      const mockReq = makeMockReqOk();
      mockHttps.get.mockImplementation((_url: any, _opts: any, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const result = await checkForUpdate('0.2.0', now);
      expect(result).toEqual({
        current: '0.2.0',
        latest: '0.5.0',
        updateAvailable: true,
      });
      // Should have written cache
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    test('returns null when network fails and no cache', async () => {
      mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const mockReq = makeMockReqError();
      mockHttps.get.mockImplementation(() => mockReq as any);

      const result = await checkForUpdate('0.2.0');
      expect(result).toBeNull();
    });

    test('handles current version being newer than npm (dev build)', async () => {
      const now = Date.now();
      const cache = { timestamp: now - 1000, latest: '0.2.0' };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(cache));

      const result = await checkForUpdate('0.3.0-dev', now);
      expect(result).not.toBeNull();
      expect(result!.updateAvailable).toBe(false);
    });
  });
});
