/**
 * Edge case tests for usage tracking functionality.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UsageTracker, UsageRecord } from '../src/usage';

jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('UsageTracker edge cases', () => {
  let tracker: UsageTracker;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.writeFileSync.mockImplementation(() => {}); // default: no-op
    tracker = new UsageTracker();
  });

  describe('logUsage edge cases', () => {
    test('handles empty string command name', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.readFileSync.mockReturnValue('[]');

      tracker.logUsage('');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData).toHaveLength(1);
      expect(writtenData[0].commandName).toBe('');
    });

    test('write failure propagates (not silently caught)', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.readFileSync.mockReturnValue('[]');
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      // logUsage does NOT wrap writeFileSync in try/catch — it throws
      expect(() => tracker.logUsage('test')).toThrow('EACCES');
    });

    test('non-array JSON in usage file causes error on push', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('{"not": "an array"}');

      // getRecords returns the parsed object, and .push() fails on it
      expect(() => tracker.logUsage('test')).toThrow();
    });

    test('handles exactly 999 records (does not trim)', () => {
      const records: UsageRecord[] = Array.from({ length: 999 }, (_, i) => ({
        commandName: 'test',
        timestamp: `2025-02-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`
      }));

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      tracker.logUsage('new');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData).toHaveLength(1000);
    });

    test('handles exactly 1000 existing records (trims oldest)', () => {
      const records: UsageRecord[] = Array.from({ length: 1000 }, (_, i) => ({
        commandName: `test-${i}`,
        timestamp: `2025-02-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`
      }));

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      tracker.logUsage('new');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData).toHaveLength(1000);
      expect(writtenData[999].commandName).toBe('new');
      // First record is test-1 (test-0 was trimmed)
      expect(writtenData[0].commandName).toBe('test-1');
    });

    test('special characters in command name are preserved', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.readFileSync.mockReturnValue('[]');

      tracker.logUsage('claude-work-日本語');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData[0].commandName).toBe('claude-work-日本語');
    });
  });

  describe('getStats edge cases', () => {
    test('returns empty array for empty usage array', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('[]');

      const stats = tracker.getStats();
      expect(stats).toEqual([]);
    });

    test('returns empty array when filtering for non-existent command', () => {
      const records: UsageRecord[] = [
        { commandName: 'claude-mini', timestamp: '2025-02-01T10:00:00.000Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats('nonexistent');
      expect(stats).toEqual([]);
    });

    test('handles single record correctly', () => {
      const records: UsageRecord[] = [
        { commandName: 'claude-solo', timestamp: '2025-02-01T10:00:00.000Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].totalUses).toBe(1);
      expect(stats[0].firstUsed).toBe('2025-02-01T10:00:00.000Z');
      expect(stats[0].lastUsed).toBe('2025-02-01T10:00:00.000Z');
      expect(stats[0].recentUses).toHaveLength(1);
    });

    test('handles records with identical timestamps', () => {
      const records: UsageRecord[] = [
        { commandName: 'claude-a', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'claude-a', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'claude-a', timestamp: '2025-02-01T10:00:00.000Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].totalUses).toBe(3);
      expect(stats[0].firstUsed).toBe(stats[0].lastUsed);
    });

    test('recent uses are capped at 10 even with many records', () => {
      const records: UsageRecord[] = Array.from({ length: 50 }, (_, i) => ({
        commandName: 'test',
        timestamp: `2025-02-01T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`
      }));
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats();
      expect(stats[0].recentUses.length).toBeLessThanOrEqual(10);
    });

    test('null JSON throws (getRecords does not guard against non-array)', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('null');

      // records = null, then null.forEach() throws
      expect(() => tracker.getStats()).toThrow();
    });

    test('stats are sorted by totalUses descending', () => {
      const records: UsageRecord[] = [
        { commandName: 'a', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'b', timestamp: '2025-02-01T11:00:00.000Z' },
        { commandName: 'b', timestamp: '2025-02-01T12:00:00.000Z' },
        { commandName: 'b', timestamp: '2025-02-01T13:00:00.000Z' },
        { commandName: 'c', timestamp: '2025-02-01T14:00:00.000Z' },
        { commandName: 'c', timestamp: '2025-02-01T15:00:00.000Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats();
      expect(stats[0].commandName).toBe('b'); // 3 uses
      expect(stats[1].commandName).toBe('c'); // 2 uses
      expect(stats[2].commandName).toBe('a'); // 1 use
    });

    test('firstUsed and lastUsed are correct with unsorted input', () => {
      const records: UsageRecord[] = [
        { commandName: 'x', timestamp: '2025-02-05T10:00:00.000Z' },
        { commandName: 'x', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'x', timestamp: '2025-02-03T10:00:00.000Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      const stats = tracker.getStats();
      expect(stats[0].firstUsed).toBe('2025-02-01T10:00:00.000Z');
      expect(stats[0].lastUsed).toBe('2025-02-05T10:00:00.000Z');
    });
  });

  describe('clearStats edge cases', () => {
    test('clearing non-existent command leaves all records intact', () => {
      const records: UsageRecord[] = [
        { commandName: 'claude-mini', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'claude-qwen', timestamp: '2025-02-01T11:00:00.000Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      tracker.clearStats('nonexistent');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData).toHaveLength(2);
    });

    test('clearing all writes empty array', () => {
      tracker.clearStats();

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData).toEqual([]);
    });

    test('clearing specific command removes only that command', () => {
      const records: UsageRecord[] = [
        { commandName: 'a', timestamp: '2025-02-01T10:00:00.000Z' },
        { commandName: 'b', timestamp: '2025-02-01T11:00:00.000Z' },
        { commandName: 'a', timestamp: '2025-02-01T12:00:00.000Z' },
        { commandName: 'c', timestamp: '2025-02-01T13:00:00.000Z' },
      ];
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(records));

      tracker.clearStats('a');

      const writeCall = mockFs.writeFileSync.mock.calls[0];
      const writtenData = JSON.parse(writeCall[1] as string);
      expect(writtenData).toHaveLength(2);
      expect(writtenData.every((r: UsageRecord) => r.commandName !== 'a')).toBe(true);
    });
  });
});
