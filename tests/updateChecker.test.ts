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
  shouldSkipUpdateCheck,
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

  // ── shouldSkipUpdateCheck ──────────────────────────────────────────────────

  describe('shouldSkipUpdateCheck', () => {
    // Reusable mocks
    const nodeBin = '/usr/bin/node';
    const cli = '/path/to/sweech/cli.js';

    test('skips when argv contains --json (T-042 regression)', () => {
      const argv = [nodeBin, cli, 'usage', '--json'];
      expect(shouldSkipUpdateCheck(argv, {})).toBe(true);
    });

    test('skips when --json appears with other flags', () => {
      const argv = [nodeBin, cli, 'list', '--json', '--profile', 'foo'];
      expect(shouldSkipUpdateCheck(argv, {})).toBe(true);
    });

    test('skips when SWEECH_NO_UPDATE_NOTIFIER=1', () => {
      const argv = [nodeBin, cli, 'list'];
      expect(shouldSkipUpdateCheck(argv, { SWEECH_NO_UPDATE_NOTIFIER: '1' })).toBe(true);
    });

    test('skips when SWEECH_NO_UPDATE_NOTIFIER=true', () => {
      const argv = [nodeBin, cli, 'list'];
      expect(shouldSkipUpdateCheck(argv, { SWEECH_NO_UPDATE_NOTIFIER: 'true' })).toBe(true);
    });

    test('does NOT skip when SWEECH_NO_UPDATE_NOTIFIER=0', () => {
      const argv = [nodeBin, cli, 'list'];
      expect(shouldSkipUpdateCheck(argv, { SWEECH_NO_UPDATE_NOTIFIER: '0' })).toBe(false);
    });

    test('does NOT skip when SWEECH_NO_UPDATE_NOTIFIER=""', () => {
      const argv = [nodeBin, cli, 'list'];
      expect(shouldSkipUpdateCheck(argv, { SWEECH_NO_UPDATE_NOTIFIER: '' })).toBe(false);
    });

    test('skips for --help / -h', () => {
      expect(shouldSkipUpdateCheck([nodeBin, cli, '--help'], {})).toBe(true);
      expect(shouldSkipUpdateCheck([nodeBin, cli, '-h'], {})).toBe(true);
    });

    test('skips for --version / -v', () => {
      expect(shouldSkipUpdateCheck([nodeBin, cli, '--version'], {})).toBe(true);
      expect(shouldSkipUpdateCheck([nodeBin, cli, '-v'], {})).toBe(true);
    });

    test('skips for update command itself', () => {
      expect(shouldSkipUpdateCheck([nodeBin, cli, 'update'], {})).toBe(true);
    });

    test('skips for --complete (shell completion)', () => {
      expect(shouldSkipUpdateCheck([nodeBin, cli, '--complete'], {})).toBe(true);
    });

    test('does NOT skip for sweech list', () => {
      expect(shouldSkipUpdateCheck([nodeBin, cli, 'list'], {})).toBe(false);
    });

    test('does NOT skip for sweech profile add', () => {
      expect(shouldSkipUpdateCheck([nodeBin, cli, 'profile', 'add'], {})).toBe(false);
    });

    test('does NOT skip when --json is not present and no env opt-out', () => {
      const argv = [nodeBin, cli, 'usage'];
      expect(shouldSkipUpdateCheck(argv, {})).toBe(false);
    });

    test('skips bare invocation (argv.length <= 2) — preserves prior behaviour', () => {
      expect(shouldSkipUpdateCheck([nodeBin, cli], {})).toBe(true);
      expect(shouldSkipUpdateCheck([nodeBin], {})).toBe(true);
    });

    test('--json suppression wins over absence of env var', () => {
      const argv = [nodeBin, cli, 'usage', '--json'];
      expect(shouldSkipUpdateCheck(argv, { OTHER: 'value' })).toBe(true);
    });

    test('env opt-out wins regardless of argv', () => {
      const argv = [nodeBin, cli, 'list'];
      expect(shouldSkipUpdateCheck(argv, { SWEECH_NO_UPDATE_NOTIFIER: '1' })).toBe(true);
    });

    test('does NOT skip for arbitrary other env vars', () => {
      const argv = [nodeBin, cli, 'list'];
      expect(shouldSkipUpdateCheck(argv, { CI: 'true', NODE_ENV: 'production' })).toBe(false);
    });

    test('skips when argv has a positional `update` even with extra args', () => {
      const argv = [nodeBin, cli, 'update', '--check'];
      expect(shouldSkipUpdateCheck(argv, {})).toBe(true);
    });

    test('does NOT skip for sweech --some-long-flag that contains json substring', () => {
      // Defensive: only exact match for --json triggers, not substring
      const argv = [nodeBin, cli, 'list', '--json-pretty'];
      expect(shouldSkipUpdateCheck(argv, {})).toBe(false);
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
        { recursive: true, mode: 0o700 },
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
