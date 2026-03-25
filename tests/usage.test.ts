/**
 * Tests for usage tracking functionality
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UsageTracker, UsageRecord, UsageStats, summarizeAccountsForTelemetry } from '../src/usage';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('UsageTracker', () => {
  let tracker: UsageTracker;
  const mockUsageFile = path.join(os.homedir(), '.sweech', 'usage.json');

  beforeEach(() => {
    jest.clearAllMocks();
    tracker = new UsageTracker();
  });

  describe('logUsage', () => {
    test('creates new usage file with first record', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.readFileSync.mockReturnValue('[]');

      tracker.logUsage('claude-mini');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toHaveLength(1);
      expect(writtenData[0].commandName).toBe('claude-mini');
      expect(writtenData[0].timestamp).toBeDefined();
    });

    test('appends to existing usage file', () => {
      const existingRecords: UsageRecord[] = [
        { commandName: 'claude-mini', timestamp: '2025-02-01T00:00:00.000Z' }
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(existingRecords));

      tracker.logUsage('claude-qwen');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toHaveLength(2);
      expect(writtenData[1].commandName).toBe('claude-qwen');
    });

    test('limits records to last 1000', () => {
      const manyRecords: UsageRecord[] = Array.from({ length: 1000 }, (_, i) => ({
        commandName: 'test',
        timestamp: `2025-02-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`
      }));

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(manyRecords));

      tracker.logUsage('new-command');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toHaveLength(1000);
      expect(writtenData[0].commandName).toBe('test'); // Oldest dropped
      expect(writtenData[999].commandName).toBe('new-command');
    });

    test('handles corrupted usage file gracefully', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(() => {
        throw new Error('Parse error');
      });

      expect(() => tracker.logUsage('test')).not.toThrow();
    });
  });

  describe('getStats', () => {
    test('returns empty array when no usage file exists', () => {
      mockFs.existsSync.mockReturnValue(false);

      const stats = tracker.getStats();

      expect(stats).toEqual([]);
    });

    test('calculates stats for single command', () => {
      const records: UsageRecord[] = [
        { commandName: 'claude-mini', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'claude-mini', timestamp: '2025-02-02T10:00:00.000Z' },
        { commandName: 'claude-mini', timestamp: '2025-02-03T10:00:00.000Z' }
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats();

      expect(stats).toHaveLength(1);
      expect(stats[0].commandName).toBe('claude-mini');
      expect(stats[0].totalUses).toBe(3);
      expect(stats[0].firstUsed).toBe('2025-02-01T10:00:00.000Z');
      expect(stats[0].lastUsed).toBe('2025-02-03T10:00:00.000Z');
    });

    test('calculates stats for multiple commands', () => {
      const records: UsageRecord[] = [
        { commandName: 'claude-mini', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'claude-qwen', timestamp: '2025-02-01T11:00:00.000Z' },
        { commandName: 'claude-mini', timestamp: '2025-02-02T10:00:00.000Z' },
        { commandName: 'claude-qwen', timestamp: '2025-02-02T11:00:00.000Z' },
        { commandName: 'claude-mini', timestamp: '2025-02-03T10:00:00.000Z' }
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats();

      expect(stats).toHaveLength(2);

      const miniStats = stats.find(s => s.commandName === 'claude-mini');
      expect(miniStats?.totalUses).toBe(3);

      const qwenStats = stats.find(s => s.commandName === 'claude-qwen');
      expect(qwenStats?.totalUses).toBe(2);
    });

    test('filters stats by command name', () => {
      const records: UsageRecord[] = [
        { commandName: 'claude-mini', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'claude-qwen', timestamp: '2025-02-01T11:00:00.000Z' },
        { commandName: 'claude-mini', timestamp: '2025-02-02T10:00:00.000Z' }
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats('claude-mini');

      expect(stats).toHaveLength(1);
      expect(stats[0].commandName).toBe('claude-mini');
      expect(stats[0].totalUses).toBe(2);
    });

    test('sorts stats by total uses descending', () => {
      const records: UsageRecord[] = [
        { commandName: 'claude-mini', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'claude-qwen', timestamp: '2025-02-01T11:00:00.000Z' },
        { commandName: 'claude-qwen', timestamp: '2025-02-02T11:00:00.000Z' },
        { commandName: 'claude-qwen', timestamp: '2025-02-03T11:00:00.000Z' }
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats();

      expect(stats[0].commandName).toBe('claude-qwen'); // 3 uses
      expect(stats[0].totalUses).toBe(3);
      expect(stats[1].commandName).toBe('claude-mini'); // 1 use
      expect(stats[1].totalUses).toBe(1);
    });

    test('includes recent uses (last 10)', () => {
      const records: UsageRecord[] = Array.from({ length: 15 }, (_, i) => ({
        commandName: 'test',
        timestamp: `2025-02-01T${String(i).padStart(2, '0')}:00:00.000Z`
      }));

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats();

      expect(stats[0].recentUses).toHaveLength(10);
      expect(stats[0].recentUses[0]).toBe('2025-02-01T05:00:00.000Z'); // 6th oldest
      expect(stats[0].recentUses[9]).toBe('2025-02-01T14:00:00.000Z'); // Most recent
    });

    test('handles corrupted usage file', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      const stats = tracker.getStats();

      expect(stats).toEqual([]);
    });
  });

  describe('clearStats', () => {
    test('clears all stats when no command specified', () => {
      tracker.clearStats();

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        mockUsageFile,
        JSON.stringify([], null, 2)
      );
    });

    test('clears stats for specific command only', () => {
      const records: UsageRecord[] = [
        { commandName: 'claude-mini', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'claude-qwen', timestamp: '2025-02-01T11:00:00.000Z' },
        { commandName: 'claude-mini', timestamp: '2025-02-02T10:00:00.000Z' }
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      tracker.clearStats('claude-mini');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);

      expect(writtenData).toHaveLength(1);
      expect(writtenData[0].commandName).toBe('claude-qwen');
    });
  });

  describe('summarizeAccountsForTelemetry', () => {
    test('summarizes multi-account availability for machine-readable consumers', () => {
      const summary = summarizeAccountsForTelemetry([
        { commandName: 'claude', live: { status: 'allowed' } },
        { commandName: 'codex', live: { status: 'limit_reached' } },
        { commandName: 'claude-pole', needsReauth: true, live: { status: 'allowed' } },
      ]);

      expect(summary).toEqual({
        totalAccounts: 3,
        availableAccounts: 1,
        limitedAccounts: 1,
        accountsNeedingReauth: 1,
        recommendedAccount: 'claude',
      });
    });
  });
});
