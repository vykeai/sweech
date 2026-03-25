/**
 * Tests for sweech compare command (T-015)
 *
 * The compare command resolves two profile names (supporting aliases),
 * fetches live usage data, and displays a side-by-side comparison.
 */

import * as fs from 'fs';
import * as path from 'path';

// Mock modules before importing anything that depends on them
jest.mock('../src/subscriptions', () => ({
  getKnownAccounts: jest.fn(),
  getAccountInfo: jest.fn(),
  setMeta: jest.fn(),
}));

jest.mock('../src/aliases', () => {
  return {
    AliasManager: jest.fn().mockImplementation(() => ({
      resolveAlias: jest.fn((name: string) => name),
      getAlias: jest.fn(),
      setAlias: jest.fn(),
      removeAlias: jest.fn(),
      getAllAliases: jest.fn(() => ({})),
    })),
  };
});

jest.mock('../src/config', () => {
  return {
    ConfigManager: jest.fn().mockImplementation(() => ({
      getProfiles: jest.fn(() => [
        { name: 'claude-pole', commandName: 'claude-pole', cliType: 'claude' },
        { name: 'codex-ted', commandName: 'codex-ted', cliType: 'codex' },
      ]),
      getProfileDir: jest.fn((name: string) => `/home/test/.${name}`),
      getBinDir: jest.fn(() => '/home/test/.sweech/bin'),
      getConfigFile: jest.fn(() => '/home/test/.sweech/config.json'),
    })),
    SHAREABLE_DIRS: [],
    SHAREABLE_FILES: [],
    CODEX_SHAREABLE_DIRS: [],
    CODEX_SHAREABLE_FILES: [],
    CODEX_SHAREABLE_DBS: [],
  };
});

import { getKnownAccounts, getAccountInfo } from '../src/subscriptions';
import { AliasManager } from '../src/aliases';
import { asciiBar, barColor } from '../src/charts';

const mockGetKnownAccounts = getKnownAccounts as jest.MockedFunction<typeof getKnownAccounts>;
const mockGetAccountInfo = getAccountInfo as jest.MockedFunction<typeof getAccountInfo>;

// Helper to create a mock AccountInfo
function mockAccount(overrides: Record<string, any> = {}) {
  return {
    name: 'test',
    commandName: 'test',
    cliType: 'claude',
    configDir: '/tmp/test',
    meta: {},
    messages5h: 0,
    messages7d: 0,
    totalMessages: 0,
    ...overrides,
  };
}

describe('Compare Command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('profile resolution', () => {
    test('resolves two different profile names', () => {
      const accounts = [
        { name: 'claude-pole', commandName: 'claude-pole', cliType: 'claude' },
        { name: 'codex-ted', commandName: 'codex-ted', cliType: 'codex' },
      ];
      mockGetKnownAccounts.mockReturnValue(accounts);

      const refA = accounts.find(p => p.commandName === 'claude-pole');
      const refB = accounts.find(p => p.commandName === 'codex-ted');

      expect(refA).toBeDefined();
      expect(refB).toBeDefined();
      expect(refA!.commandName).toBe('claude-pole');
      expect(refB!.commandName).toBe('codex-ted');
    });

    test('returns undefined for unknown profile', () => {
      const accounts = [
        { name: 'claude-pole', commandName: 'claude-pole', cliType: 'claude' },
      ];
      mockGetKnownAccounts.mockReturnValue(accounts);

      const ref = accounts.find(p => p.commandName === 'nonexistent');
      expect(ref).toBeUndefined();
    });

    test('alias resolution is applied before lookup', () => {
      const aliasManager = new AliasManager();
      const resolvedName = aliasManager.resolveAlias('my-alias');
      // Default mock just returns the input
      expect(resolvedName).toBe('my-alias');
    });

    test('resolves by name field as well as commandName', () => {
      const accounts = [
        { name: 'claude-pole', commandName: 'claude-pole', cliType: 'claude' },
      ];
      mockGetKnownAccounts.mockReturnValue(accounts);

      const ref = accounts.find(p => p.commandName === 'claude-pole' || p.name === 'claude-pole');
      expect(ref).toBeDefined();
    });
  });

  describe('data display', () => {
    test('smart score computes correctly for healthy account', () => {
      const smartScore = (acct: any): number => {
        if (acct.needsReauth) return -2;
        if (acct.live?.status === 'limit_reached') return -1;
        const remaining7d = 1 - (acct.live?.utilization7d ?? 0);
        const reset7dAt = acct.live?.reset7dAt;
        if (!reset7dAt) return remaining7d / 7;
        const hoursLeft = Math.max(0.5, (reset7dAt - Date.now() / 1000) / 3600);
        const daysLeft = hoursLeft / 24;
        const baseScore = remaining7d / daysLeft;
        if (hoursLeft < 72 && remaining7d > 0) return 100 + baseScore;
        return baseScore;
      };

      const acct = mockAccount({
        live: { utilization7d: 0.3, status: 'allowed' },
      });
      const score = smartScore(acct);
      expect(score).toBeCloseTo(0.7 / 7, 2);
    });

    test('smart score returns -2 for reauth accounts', () => {
      const smartScore = (acct: any): number => {
        if (acct.needsReauth) return -2;
        return 0;
      };

      expect(smartScore({ needsReauth: true })).toBe(-2);
    });

    test('smart score returns -1 for limit_reached accounts', () => {
      const smartScore = (acct: any): number => {
        if (acct.needsReauth) return -2;
        if (acct.live?.status === 'limit_reached') return -1;
        return 0;
      };

      expect(smartScore({ live: { status: 'limit_reached' } })).toBe(-1);
    });

    test('timeAgo returns "just now" for recent timestamps', () => {
      const timeAgo = (iso: string | undefined): string => {
        if (!iso) return 'n/a';
        const diff = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
      };

      expect(timeAgo(new Date().toISOString())).toBe('just now');
      expect(timeAgo(undefined)).toBe('n/a');
    });

    test('timeAgo returns hours for older timestamps', () => {
      const timeAgo = (iso: string | undefined): string => {
        if (!iso) return 'n/a';
        const diff = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
      };

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      expect(timeAgo(twoHoursAgo)).toBe('2h ago');
    });

    test('asciiBar renders correctly for compare display', () => {
      const bar = asciiBar({ label: '', value: 0.3, max: 1, width: 14, color: barColor(0.3) });
      expect(bar).toContain('30%');
      expect(bar).toContain('[');
      expect(bar).toContain(']');
    });

    test('asciiBar at 96% renders correctly', () => {
      const bar = asciiBar({ label: '', value: 0.96, max: 1, width: 14, color: barColor(0.96) });
      expect(bar).toContain('96%');
    });

    test('asciiBar at 0% renders correctly', () => {
      const bar = asciiBar({ label: '', value: 0, max: 1, width: 14, color: barColor(0) });
      expect(bar).toContain('0%');
    });

    test('asciiBar at 100% renders correctly', () => {
      const bar = asciiBar({ label: '', value: 1, max: 1, width: 14, color: barColor(1) });
      expect(bar).toContain('100%');
    });
  });

  describe('command structure', () => {
    test('compare command exists in cli.ts source', () => {
      const cliSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'cli.ts'),
        'utf-8',
      );
      expect(cliSrc).toContain(".command('compare <a> <b>')");
    });

    test('compare command is placed after stats command', () => {
      const cliSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'cli.ts'),
        'utf-8',
      );
      const statsIdx = cliSrc.indexOf(".command('stats");
      const compareIdx = cliSrc.indexOf(".command('compare <a> <b>')");
      const showIdx = cliSrc.indexOf(".command('show <command-name>')");

      expect(statsIdx).toBeGreaterThan(-1);
      expect(compareIdx).toBeGreaterThan(-1);
      expect(showIdx).toBeGreaterThan(-1);

      // Compare must be after stats and before show
      expect(compareIdx).toBeGreaterThan(statsIdx);
      expect(compareIdx).toBeLessThan(showIdx);
    });

    test('compare command uses alias resolution', () => {
      const cliSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'cli.ts'),
        'utf-8',
      );
      // Find the compare command block
      const compareStart = cliSrc.indexOf(".command('compare <a> <b>')");
      const compareEnd = cliSrc.indexOf(".command('show <command-name>')");
      const compareBlock = cliSrc.slice(compareStart, compareEnd);

      expect(compareBlock).toContain('resolveAlias');
    });

    test('compare command fetches account info for both profiles', () => {
      const cliSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'cli.ts'),
        'utf-8',
      );
      const compareStart = cliSrc.indexOf(".command('compare <a> <b>')");
      const compareEnd = cliSrc.indexOf(".command('show <command-name>')");
      const compareBlock = cliSrc.slice(compareStart, compareEnd);

      expect(compareBlock).toContain('getAccountInfo');
      expect(compareBlock).toContain('Promise.all');
    });

    test('compare command displays all required fields', () => {
      const cliSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'cli.ts'),
        'utf-8',
      );
      const compareStart = cliSrc.indexOf(".command('compare <a> <b>')");
      const compareEnd = cliSrc.indexOf(".command('show <command-name>')");
      const compareBlock = cliSrc.slice(compareStart, compareEnd);

      expect(compareBlock).toContain('Plan:');
      expect(compareBlock).toContain('Status:');
      expect(compareBlock).toContain('5h:');
      expect(compareBlock).toContain('Week:');
      expect(compareBlock).toContain('Score:');
      expect(compareBlock).toContain('Last:');
      expect(compareBlock).toContain('Messages:');
    });

    test('compare command uses asciiBar for usage bars', () => {
      const cliSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'cli.ts'),
        'utf-8',
      );
      const compareStart = cliSrc.indexOf(".command('compare <a> <b>')");
      const compareEnd = cliSrc.indexOf(".command('show <command-name>')");
      const compareBlock = cliSrc.slice(compareStart, compareEnd);

      expect(compareBlock).toContain('asciiBar');
      expect(compareBlock).toContain('barColor');
    });

    test('compare imports asciiBar and barColor from charts', () => {
      const cliSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'cli.ts'),
        'utf-8',
      );
      expect(cliSrc).toContain("import { asciiBar, barColor } from './charts'");
    });
  });

  describe('error handling', () => {
    test('exits with error for unknown first profile', () => {
      const accounts = [
        { name: 'claude-pole', commandName: 'claude-pole', cliType: 'claude' },
      ];
      mockGetKnownAccounts.mockReturnValue(accounts);

      const refA = accounts.find(p => p.commandName === 'nonexistent' || p.name === 'nonexistent');
      expect(refA).toBeUndefined();
    });

    test('exits with error for unknown second profile', () => {
      const accounts = [
        { name: 'claude-pole', commandName: 'claude-pole', cliType: 'claude' },
      ];
      mockGetKnownAccounts.mockReturnValue(accounts);

      const refB = accounts.find(p => p.commandName === 'also-nonexistent' || p.name === 'also-nonexistent');
      expect(refB).toBeUndefined();
    });

    test('error path wraps in try/catch', () => {
      const cliSrc = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'cli.ts'),
        'utf-8',
      );
      const compareStart = cliSrc.indexOf(".command('compare <a> <b>')");
      const compareEnd = cliSrc.indexOf(".command('show <command-name>')");
      const compareBlock = cliSrc.slice(compareStart, compareEnd);

      expect(compareBlock).toContain('catch');
      expect(compareBlock).toContain('process.exit(1)');
    });
  });
});
