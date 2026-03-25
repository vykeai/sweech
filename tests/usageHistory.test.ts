/**
 * Tests for usage history — hourly utilization snapshots (src/usageHistory.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  appendSnapshot,
  getHistory,
  pruneOldEntries,
  accountSparkline,
  allAccountSparklines,
  _setHistoryFilePath,
  _resetHistoryFilePath,
  type HistoryEntry,
} from '../src/usageHistory';
import type { AccountInfo } from '../src/subscriptions';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let historyFile: string;

function makeAccount(
  commandName: string,
  u5h: number,
  u7d: number,
): AccountInfo {
  return {
    name: commandName,
    commandName,
    cliType: 'claude',
    configDir: `/mock/.${commandName}`,
    meta: {},
    messages5h: 10,
    messages7d: 50,
    totalMessages: 200,
    live: {
      buckets: [
        {
          label: 'All models',
          session: { utilization: u5h },
          weekly: { utilization: u7d },
        },
      ],
      capturedAt: Date.now(),
      utilization5h: u5h,
      utilization7d: u7d,
    },
  };
}

function writeHistory(entries: HistoryEntry[]): void {
  fs.writeFileSync(historyFile, JSON.stringify(entries, null, 2));
}

function readHistory(): HistoryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
  } catch {
    return [];
  }
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-history-test-'));
  historyFile = path.join(tmpDir, 'history.json');
  _setHistoryFilePath(historyFile);
});

afterEach(() => {
  _resetHistoryFilePath();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── pruneOldEntries ─────────────────────────────────────────────────────────

describe('pruneOldEntries', () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  test('keeps entries within 7 days', () => {
    const now = Date.now();
    const entries: HistoryEntry[] = [
      { timestamp: now - SEVEN_DAYS_MS + 1000, accounts: { a: { u5h: 0.1, u7d: 0.2 } } },
      { timestamp: now - 3600_000, accounts: { a: { u5h: 0.3, u7d: 0.4 } } },
    ];
    const result = pruneOldEntries(entries, now);
    expect(result).toHaveLength(2);
  });

  test('removes entries older than 7 days', () => {
    const now = Date.now();
    const entries: HistoryEntry[] = [
      { timestamp: now - SEVEN_DAYS_MS - 1000, accounts: { a: { u5h: 0.1, u7d: 0.2 } } },
      { timestamp: now - 3600_000, accounts: { a: { u5h: 0.3, u7d: 0.4 } } },
    ];
    const result = pruneOldEntries(entries, now);
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(now - 3600_000);
  });

  test('returns empty array when all entries are old', () => {
    const now = Date.now();
    const entries: HistoryEntry[] = [
      { timestamp: now - SEVEN_DAYS_MS - 100_000, accounts: { a: { u5h: 0, u7d: 0 } } },
    ];
    const result = pruneOldEntries(entries, now);
    expect(result).toHaveLength(0);
  });

  test('handles empty input', () => {
    expect(pruneOldEntries([])).toHaveLength(0);
  });

  test('boundary: exactly 7 days old is kept (timestamp === cutoff)', () => {
    const now = Date.now();
    const entries: HistoryEntry[] = [
      { timestamp: now - SEVEN_DAYS_MS, accounts: { a: { u5h: 0, u7d: 0 } } },
    ];
    const result = pruneOldEntries(entries, now);
    // timestamp === cutoff means timestamp >= cutoff is true, so it's kept
    expect(result).toHaveLength(1);
  });

  test('boundary: one millisecond older than 7 days is pruned', () => {
    const now = Date.now();
    const entries: HistoryEntry[] = [
      { timestamp: now - SEVEN_DAYS_MS - 1, accounts: { a: { u5h: 0, u7d: 0 } } },
    ];
    const result = pruneOldEntries(entries, now);
    expect(result).toHaveLength(0);
  });
});

// ── appendSnapshot ──────────────────────────────────────────────────────────

describe('appendSnapshot', () => {
  test('writes snapshot to file when history is empty', () => {
    const accounts = [makeAccount('claude-pole', 0.3, 0.5)];
    appendSnapshot(accounts);
    const stored = readHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0].accounts['claude-pole']).toEqual({ u5h: 0.3, u7d: 0.5 });
  });

  test('appends to existing history', () => {
    const now = Date.now();
    writeHistory([
      { timestamp: now - 7200_000, accounts: { 'claude-pole': { u5h: 0.1, u7d: 0.2 } } },
    ]);
    appendSnapshot([makeAccount('claude-pole', 0.4, 0.6)], now);
    const stored = readHistory();
    expect(stored).toHaveLength(2);
    expect(stored[1].accounts['claude-pole']).toEqual({ u5h: 0.4, u7d: 0.6 });
  });

  test('deduplicates: skips if last entry is less than 1 hour ago', () => {
    const now = Date.now();
    writeHistory([
      { timestamp: now - 1800_000, accounts: { a: { u5h: 0.1, u7d: 0.2 } } }, // 30 min ago
    ]);
    appendSnapshot([makeAccount('a', 0.5, 0.6)], now);
    const stored = readHistory();
    expect(stored).toHaveLength(1); // No new entry
    expect(stored[0].accounts.a.u5h).toBe(0.1); // Old data unchanged
  });

  test('allows entry when last entry is exactly 1 hour ago', () => {
    const now = Date.now();
    writeHistory([
      { timestamp: now - 3600_000, accounts: { a: { u5h: 0.1, u7d: 0.2 } } },
    ]);
    appendSnapshot([makeAccount('a', 0.5, 0.6)], now);
    const stored = readHistory();
    expect(stored).toHaveLength(2);
  });

  test('records multiple accounts in one snapshot', () => {
    const accounts = [
      makeAccount('claude-pole', 0.3, 0.5),
      makeAccount('claude-equator', 0.1, 0.2),
    ];
    appendSnapshot(accounts);
    const stored = readHistory();
    expect(stored).toHaveLength(1);
    expect(stored[0].accounts['claude-pole']).toBeDefined();
    expect(stored[0].accounts['claude-equator']).toBeDefined();
  });

  test('skips accounts with no live data', () => {
    const noLive: AccountInfo = {
      name: 'no-data',
      commandName: 'no-data',
      cliType: 'claude',
      configDir: '/mock/.no-data',
      meta: {},
      messages5h: 0,
      messages7d: 0,
      totalMessages: 0,
    };
    appendSnapshot([noLive]);
    // No file should be created since there's no meaningful data
    expect(fs.existsSync(historyFile)).toBe(false);
  });

  test('prunes old entries when appending', () => {
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    writeHistory([
      { timestamp: now - SEVEN_DAYS_MS - 100_000, accounts: { a: { u5h: 0.1, u7d: 0.1 } } },
      { timestamp: now - 7200_000, accounts: { a: { u5h: 0.2, u7d: 0.3 } } },
    ]);
    appendSnapshot([makeAccount('a', 0.5, 0.6)], now);
    const stored = readHistory();
    // Old entry should be pruned, only recent + new remain
    expect(stored).toHaveLength(2);
    expect(stored[0].timestamp).toBe(now - 7200_000);
  });

  test('enforces max 168 entries', () => {
    const now = Date.now();
    // Create 170 entries, all within 7 days but older than 1 hour
    const entries: HistoryEntry[] = [];
    for (let i = 170; i >= 1; i--) {
      entries.push({
        timestamp: now - i * 3600_000, // each 1 hour apart
        accounts: { a: { u5h: i / 170, u7d: i / 170 } },
      });
    }
    writeHistory(entries);
    appendSnapshot([makeAccount('a', 0.99, 0.99)], now);
    const stored = readHistory();
    expect(stored.length).toBeLessThanOrEqual(168);
  });

  test('creates ~/.sweech directory if it does not exist', () => {
    const deepPath = path.join(tmpDir, 'deep', 'nested', 'history.json');
    _setHistoryFilePath(deepPath);
    appendSnapshot([makeAccount('a', 0.5, 0.5)]);
    expect(fs.existsSync(deepPath)).toBe(true);
  });

  test('handles corrupt history file gracefully', () => {
    fs.writeFileSync(historyFile, 'NOT VALID JSON!!!');
    // Should not throw, should overwrite with new data
    appendSnapshot([makeAccount('a', 0.3, 0.5)]);
    const stored = readHistory();
    expect(stored).toHaveLength(1);
  });
});

// ── getHistory ──────────────────────────────────────────────────────────────

describe('getHistory', () => {
  test('returns entries within the requested time range', () => {
    const now = Date.now();
    writeHistory([
      { timestamp: now - 48 * 3600_000, accounts: { a: { u5h: 0.1, u7d: 0.1 } } },
      { timestamp: now - 12 * 3600_000, accounts: { a: { u5h: 0.2, u7d: 0.2 } } },
      { timestamp: now - 3600_000, accounts: { a: { u5h: 0.3, u7d: 0.3 } } },
    ]);
    const result = getHistory(24);
    expect(result).toHaveLength(2);
  });

  test('defaults to 24 hours', () => {
    const now = Date.now();
    writeHistory([
      { timestamp: now - 25 * 3600_000, accounts: { a: { u5h: 0.1, u7d: 0.1 } } },
      { timestamp: now - 1 * 3600_000, accounts: { a: { u5h: 0.2, u7d: 0.2 } } },
    ]);
    const result = getHistory();
    expect(result).toHaveLength(1);
  });

  test('returns empty array when no file exists', () => {
    expect(getHistory()).toEqual([]);
  });

  test('returns all entries with large hour parameter', () => {
    const now = Date.now();
    writeHistory([
      { timestamp: now - 100 * 3600_000, accounts: { a: { u5h: 0.1, u7d: 0.1 } } },
      { timestamp: now - 50 * 3600_000, accounts: { a: { u5h: 0.2, u7d: 0.2 } } },
      { timestamp: now - 3600_000, accounts: { a: { u5h: 0.3, u7d: 0.3 } } },
    ]);
    const result = getHistory(200);
    expect(result).toHaveLength(3);
  });
});

// ── accountSparkline ────────────────────────────────────────────────────────

describe('accountSparkline', () => {
  test('renders sparkline from history data', () => {
    const now = Date.now();
    const entries: HistoryEntry[] = [];
    for (let i = 10; i >= 0; i--) {
      entries.push({
        timestamp: now - i * 3600_000,
        accounts: { 'claude-pole': { u5h: 0.1, u7d: (10 - i) / 10 } },
      });
    }
    writeHistory(entries);
    const result = accountSparkline('claude-pole', 24, 'u7d');
    expect(result.length).toBeGreaterThan(0);
    // Increasing values should produce ascending blocks
    const chars = result.split('');
    for (let i = 1; i < chars.length; i++) {
      expect(chars[i].codePointAt(0)!).toBeGreaterThanOrEqual(chars[i - 1].codePointAt(0)!);
    }
  });

  test('returns empty string when no data for account', () => {
    const now = Date.now();
    writeHistory([
      { timestamp: now - 3600_000, accounts: { other: { u5h: 0.5, u7d: 0.5 } } },
    ]);
    const result = accountSparkline('nonexistent', 24, 'u7d');
    expect(result).toBe('');
  });

  test('uses u5h field when requested', () => {
    const now = Date.now();
    writeHistory([
      { timestamp: now - 3600_000, accounts: { a: { u5h: 0.9, u7d: 0.1 } } },
      { timestamp: now - 100, accounts: { a: { u5h: 0.1, u7d: 0.9 } } },
    ]);
    const result = accountSparkline('a', 24, 'u5h');
    expect(result.length).toBe(2);
    // u5h goes from 0.9 to 0.1 — descending
    const chars = result.split('');
    expect(chars[0].codePointAt(0)!).toBeGreaterThan(chars[1].codePointAt(0)!);
  });

  test('returns empty string when history file does not exist', () => {
    expect(accountSparkline('a')).toBe('');
  });
});

// ── allAccountSparklines ────────────────────────────────────────────────────

describe('allAccountSparklines', () => {
  test('returns sparklines for all accounts in history', () => {
    const now = Date.now();
    writeHistory([
      {
        timestamp: now - 3 * 3600_000,
        accounts: {
          'claude-pole': { u5h: 0.1, u7d: 0.2 },
          'claude-equator': { u5h: 0.3, u7d: 0.4 },
        },
      },
      {
        timestamp: now - 2 * 3600_000,
        accounts: {
          'claude-pole': { u5h: 0.5, u7d: 0.6 },
          'claude-equator': { u5h: 0.7, u7d: 0.8 },
        },
      },
    ]);
    const result = allAccountSparklines(24, 'u7d');
    expect(result.size).toBe(2);
    expect(result.has('claude-pole')).toBe(true);
    expect(result.has('claude-equator')).toBe(true);
    expect(result.get('claude-pole')!.length).toBe(2);
  });

  test('returns empty map when no history', () => {
    const result = allAccountSparklines();
    expect(result.size).toBe(0);
  });

  test('skips accounts with no data in time range', () => {
    const now = Date.now();
    writeHistory([
      {
        timestamp: now - 48 * 3600_000, // 48h ago — outside 24h window
        accounts: { old: { u5h: 0.5, u7d: 0.5 } },
      },
      {
        timestamp: now - 3600_000,
        accounts: { recent: { u5h: 0.5, u7d: 0.5 } },
      },
    ]);
    const result = allAccountSparklines(24, 'u7d');
    expect(result.has('recent')).toBe(true);
    expect(result.has('old')).toBe(false);
  });
});

// ── Integration: sparkline rendering from history ────────────────────────────

describe('sparkline rendering from history data', () => {
  test('constant utilization produces identical block characters', () => {
    const now = Date.now();
    const entries: HistoryEntry[] = [];
    for (let i = 5; i >= 0; i--) {
      entries.push({
        timestamp: now - i * 3600_000,
        accounts: { a: { u5h: 0.5, u7d: 0.5 } },
      });
    }
    writeHistory(entries);
    const result = accountSparkline('a', 24, 'u7d');
    const chars = result.split('');
    expect(new Set(chars).size).toBe(1); // All identical
  });

  test('spike pattern is visible in sparkline', () => {
    const now = Date.now();
    const vals = [0.1, 0.1, 0.1, 0.9, 0.1, 0.1];
    const entries: HistoryEntry[] = vals.map((v, i) => ({
      timestamp: now - (vals.length - i) * 3600_000,
      accounts: { a: { u5h: v, u7d: v } },
    }));
    writeHistory(entries);
    const result = accountSparkline('a', 24, 'u7d');
    expect(result.length).toBe(6);
    // The spike (index 3) should be the tallest block
    const chars = result.split('');
    const maxCode = Math.max(...chars.map(c => c.codePointAt(0)!));
    expect(chars[3].codePointAt(0)).toBe(maxCode);
  });
});
