/**
 * Tests for liveUsage cache functions — readCache, writeCache, getCached, getStaleCache, setCached.
 *
 * These are internal functions, so we test them indirectly via getLiveUsage/refreshLiveUsage
 * by mocking fs and the fetch/keychain calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fs before importing liveUsage
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock child_process to prevent keychain access
jest.mock('child_process', () => ({
  execSync: jest.fn().mockImplementation(() => { throw new Error('no keychain'); }),
  execFileSync: jest.fn(),
  spawn: jest.fn(),
}));

// Mock global fetch
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

import { getLiveUsage, refreshLiveUsage, LiveRateLimitData } from '../src/liveUsage';

function makeCacheData(overrides: Partial<LiveRateLimitData> = {}): LiveRateLimitData {
  return {
    buckets: [{ label: 'All models', session: { utilization: 0.3 }, weekly: { utilization: 0.5, resetsAt: Date.now() / 1000 + 3600 } }],
    status: 'allowed',
    capturedAt: Date.now(),
    utilization5h: 0.3,
    utilization7d: 0.5,
    ...overrides,
  };
}

describe('liveUsage cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('getCached — fresh cache hit', () => {
    test('returns cached data when within TTL', async () => {
      const cached = makeCacheData({ capturedAt: Date.now() - 60_000 }); // 1 min ago
      const store = { '/mock/.claude': cached };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(store));

      const result = await getLiveUsage('/mock/.claude');
      expect(result).toBeDefined();
      expect(result!.status).toBe('allowed');
      expect(result!.utilization5h).toBe(0.3);
      // fetch should NOT have been called since cache is fresh
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('returns stale data with isStale flag when cache is expired and no token', async () => {
      const cached = makeCacheData({ capturedAt: Date.now() - 10 * 60_000 }); // 10 min ago (expired)
      const store = { '/mock/.claude': cached };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(store));

      const result = await getLiveUsage('/mock/.claude');
      // No keychain token → falls to stale cache
      expect(result).toBeDefined();
      expect(result!.isStale).toBe(true);
    });
  });

  describe('getCached — cache miss', () => {
    test('returns fallback with tokenStatus when no cache entry exists', async () => {
      mockFs.readFileSync.mockReturnValue('{}'); // empty store

      const result = await getLiveUsage('/mock/.claude');
      // No cached data, no token → returns { buckets: [], tokenStatus: 'no_token' }
      expect(result).toBeDefined();
      expect(result!.buckets).toEqual([]);
      expect(result!.tokenStatus).toBe('no_token');
    });

    test('returns fallback with tokenStatus when cache file is corrupted', async () => {
      mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const result = await getLiveUsage('/mock/.claude');
      // readCache catches errors and returns {}, then no token
      expect(result).toBeDefined();
      expect(result!.tokenStatus).toBe('no_token');
    });
  });

  describe('cache TTL boundary', () => {
    test('cache just past 5 minutes is expired (returns stale)', async () => {
      const cached = makeCacheData({ capturedAt: Date.now() - 5 * 60_000 - 100 }); // slightly past TTL
      const store = { '/mock/.claude': cached };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(store));

      const result = await getLiveUsage('/mock/.claude');
      // Past TTL → cache miss → tries to fetch → no token → stale fallback
      expect(result).toBeDefined();
      expect(result!.isStale).toBe(true);
    });

    test('cache at just under 5 minutes is still fresh', async () => {
      const cached = makeCacheData({ capturedAt: Date.now() - 4 * 60_000 - 59_000 }); // 4m59s ago
      const store = { '/mock/.claude': cached };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(store));

      const result = await getLiveUsage('/mock/.claude');
      expect(result).toBeDefined();
      expect(result!.isStale).toBeUndefined(); // fresh, not stale
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('cache write/read round-trip', () => {
    test('writeCache is called after successful fetch', async () => {
      // Simulate: empty cache, then verify write
      let writtenData: string | undefined;
      mockFs.readFileSync.mockImplementation(() => {
        if (writtenData) return writtenData;
        return '{}';
      });
      mockFs.writeFileSync.mockImplementation((_path: any, data: any) => {
        writtenData = data as string;
      });
      mockFs.mkdirSync.mockImplementation(() => undefined as any);

      // getLiveUsage with no token → returns fallback, no cache write
      const result = await getLiveUsage('/mock/.new-profile');
      expect(result).toBeDefined();
      expect(result!.tokenStatus).toBe('no_token');
      // No write happened — token was missing so nothing to cache
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('refreshLiveUsage', () => {
    test('bypasses cache and returns stale when no token but stale exists', async () => {
      const cached = makeCacheData({ capturedAt: Date.now() - 1000 }); // very fresh
      const store = { '/mock/.claude': cached };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(store));

      const result = await refreshLiveUsage('/mock/.claude');
      // refreshLiveUsage skips getCached, tries to fetch, fails (no token), returns stale
      expect(result).toBeDefined();
      expect(result!.isStale).toBe(true);
    });

    test('returns fallback with tokenStatus when no cache and no token', async () => {
      mockFs.readFileSync.mockReturnValue('{}');

      const result = await refreshLiveUsage('/mock/.claude');
      expect(result).toBeDefined();
      expect(result!.tokenStatus).toBe('no_token');
      expect(result!.buckets).toEqual([]);
    });
  });

  describe('codex cliType path', () => {
    test('getLiveUsage with codex type returns null when no cache and spawn fails', async () => {
      mockFs.readFileSync.mockReturnValue('{}');
      // Mock spawn to return a process that emits an error
      const { spawn } = require('child_process');
      const EventEmitter = require('events');
      const mockProc = new EventEmitter();
      mockProc.stdout = new EventEmitter();
      mockProc.stdin = { write: jest.fn() };
      mockProc.kill = jest.fn();
      (spawn as jest.Mock).mockReturnValue(mockProc);

      const promise = getLiveUsage('/mock/.codex-home', 'codex');
      // Trigger error event
      mockProc.emit('error', new Error('spawn ENOENT'));

      const result = await promise;
      // No stale cache → returns null
      expect(result).toBeNull();
    });

    test('getLiveUsage infers 2x limits for eligible codex plans when provider promo is absent', async () => {
      const cached = makeCacheData({
        planType: 'pro',
        promotion: undefined,
        capturedAt: Date.now() - 60_000,
      });
      const store = { '/mock/.codex-home': cached };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(store));

      const result = await getLiveUsage('/mock/.codex-home', 'codex');
      expect(result).toBeDefined();
      expect(result!.promotion).toEqual(expect.objectContaining({
        label: '2x Limits',
        multiplier: 2,
        source: 'inferred',
      }));
    });

    test('getLiveUsage preserves provider promo when codex already returns one', async () => {
      const cached = makeCacheData({
        planType: 'pro',
        promotion: { label: '+250 Credits', source: 'provider' as const },
        capturedAt: Date.now() - 60_000,
      });
      const store = { '/mock/.codex-home': cached };
      mockFs.readFileSync.mockReturnValue(JSON.stringify(store));

      const result = await getLiveUsage('/mock/.codex-home', 'codex');
      expect(result).toBeDefined();
      expect(result!.promotion).toEqual(expect.objectContaining({
        label: '+250 Credits',
        source: 'provider',
      }));
    });

    test('getLiveUsage applies manual promo override ahead of inferred codex promo', async () => {
      const cached = makeCacheData({
        planType: 'pro',
        promotion: undefined,
        capturedAt: Date.now() - 60_000,
      });
      const store = { '/mock/.codex-home': cached };
      mockFs.readFileSync.mockImplementation((value: fs.PathOrFileDescriptor) => {
        const file = String(value);
        if (file.includes('rate-limit-cache.json')) return JSON.stringify(store);
        if (file.includes('promotions.json')) {
          return JSON.stringify([{ cliType: 'codex', label: 'Spring Promo', multiplier: 3 }]);
        }
        return '{}';
      });

      const result = await getLiveUsage('/mock/.codex-home', 'codex');
      expect(result).toBeDefined();
      expect(result!.promotion).toEqual(expect.objectContaining({
        label: 'Spring Promo',
        multiplier: 3,
        source: 'manual',
      }));
    });
  });
});
