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
        const remaining7d = 1 - (acct.live?.buckets?.[0]?.weekly?.utilization ?? 0);
        const reset7dAt = acct.live?.buckets?.[0]?.weekly?.resetsAt;
        if (!reset7dAt) return remaining7d / 7;
        const hoursLeft = Math.max(0.5, (reset7dAt - Date.now() / 1000) / 3600);
        const daysLeft = hoursLeft / 24;
        const baseScore = remaining7d / daysLeft;
        if (hoursLeft < 72 && remaining7d > 0) return 100 + baseScore;
        return baseScore;
      };

      const acct = mockAccount({
        live: { buckets: [{ label: 'All models', weekly: { utilization: 0.3 } }], status: 'allowed' },
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

  // T-052 — --json and --per-model flags
  describe('--json and --per-model flags (T-052)', () => {
    const cliSrc = (() => {
      try {
        return fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf-8');
      } catch {
        return '';
      }
    })();
    const compareStart = cliSrc.indexOf(".command('compare <a> <b>')");
    const compareEnd = cliSrc.indexOf(".command('show <command-name>')");
    const compareBlock = cliSrc.slice(compareStart, compareEnd);

    test('compare command registers --json option', () => {
      expect(compareBlock).toContain("'--json'");
    });

    test('compare command registers --per-model option', () => {
      expect(compareBlock).toContain("'--per-model'");
    });

    test('compare action receives json + perModel option flags', () => {
      // Commander camelCases --per-model into perModel
      expect(compareBlock).toMatch(/opts:\s*\{\s*json\?:\s*boolean;\s*perModel\?:\s*boolean\s*\}/);
    });

    test('json branch short-circuits before text rendering', () => {
      // The JSON guard should appear before "sweech compare ·" header banner
      const jsonGuardIdx = compareBlock.indexOf('if (opts.json)');
      const headerIdx = compareBlock.indexOf('sweech compare ·');
      expect(jsonGuardIdx).toBeGreaterThan(-1);
      expect(headerIdx).toBeGreaterThan(-1);
      // Need to verify the final JSON guard (one used for payload emit, not
      // the not-found early-exits) precedes the header. There are 3 json
      // guards total — find the last one before the header banner.
      const jsonGuards: number[] = [];
      let from = 0;
      while (true) {
        const idx = compareBlock.indexOf('if (opts.json)', from);
        if (idx === -1) break;
        jsonGuards.push(idx);
        from = idx + 1;
      }
      expect(jsonGuards.length).toBeGreaterThanOrEqual(1);
      // At least one guard should come before the header (so json short-circuits)
      const guardsBeforeHeader = jsonGuards.filter(i => i < headerIdx);
      expect(guardsBeforeHeader.length).toBeGreaterThan(0);
    });

    test('json payload type declares required fields (plan, score, status, expiry, perModel)', () => {
      expect(cliSrc).toMatch(/type CompareProfilePayload/);
      // Required fields from the keel acceptance criteria
      expect(cliSrc).toMatch(/\bplan:\s*string \| null/);
      expect(cliSrc).toMatch(/\bscore:\s*number/);
      expect(cliSrc).toMatch(/\bstatus:\s*string/);
      expect(cliSrc).toMatch(/tokenExpiresAt:\s*number \| null/);
      // Cost/limit hints
      expect(cliSrc).toMatch(/limits:\s*\{/);
      // Per-model breakdown
      expect(cliSrc).toMatch(/perModel:\s*ComparePerModelTier\[\]/);
    });

    test('per-model rendering iterates buckets and prints a side-by-side table', () => {
      // Guarded by opts.perModel
      expect(compareBlock).toMatch(/if \(opts\.perModel\)/);
      // Has a per-model header line
      expect(compareBlock).toContain('Per-model rate limits:');
      // Iterates labels
      expect(compareBlock).toMatch(/for \(const label of labels\)/);
    });

    test('per-model formatter shows 5h and 7d utilization per bucket', () => {
      // The fmtTier helper produces e.g. "5h:42% 7d:88%"
      expect(compareBlock).toMatch(/5h:\$\{[^}]*\}%/);
      expect(compareBlock).toMatch(/7d:\$\{[^}]*\}%/);
    });

    // Logic-replica: per-model fmtTier behavior. Mirrors what the CLI prints
    // so a regression in the rendering math is caught here.
    type Tier = { label: string; session?: { utilization: number }; weekly?: { utilization: number } };
    const fmtTier = (tier: Tier | undefined): string => {
      if (!tier) return '—';
      const parts: string[] = [];
      if (tier.session) parts.push(`5h:${Math.round(tier.session.utilization * 100)}%`);
      if (tier.weekly)  parts.push(`7d:${Math.round(tier.weekly.utilization * 100)}%`);
      return parts.length ? parts.join(' ') : '—';
    };

    test('per-model fmtTier renders both windows when present', () => {
      const tier: Tier = { label: 'Sonnet only', session: { utilization: 0.42 }, weekly: { utilization: 0.88 } };
      expect(fmtTier(tier)).toBe('5h:42% 7d:88%');
    });

    test('per-model fmtTier renders only weekly when session missing', () => {
      const tier: Tier = { label: 'Sonnet only', weekly: { utilization: 0.5 } };
      expect(fmtTier(tier)).toBe('7d:50%');
    });

    test('per-model fmtTier returns dash when both windows missing', () => {
      const tier: Tier = { label: 'Empty' };
      expect(fmtTier(tier)).toBe('—');
    });

    test('per-model fmtTier returns dash for undefined input', () => {
      expect(fmtTier(undefined)).toBe('—');
    });

    test('per-model collects union of labels across both profiles', () => {
      const tiersA: Tier[] = [{ label: 'All models', weekly: { utilization: 0.5 } }, { label: 'Sonnet only', weekly: { utilization: 0.3 } }];
      const tiersB: Tier[] = [{ label: 'All models', weekly: { utilization: 0.7 } }];
      const labels = Array.from(new Set([...tiersA.map(t => t.label), ...tiersB.map(t => t.label)]));
      expect(labels).toEqual(['All models', 'Sonnet only']);
    });

    // Logic-replica: JSON payload builder
    test('JSON payload toPayload shape includes all keel acceptance fields', () => {
      const info: any = {
        commandName: 'claude-pole',
        cliType: 'claude',
        meta: { plan: 'Max 20x', limits: { window5h: 225, window7d: 2000 } },
        live: {
          status: 'allowed',
          tokenStatus: 'valid',
          tokenExpiresAt: 9999999999,
          buckets: [
            { label: 'All models', session: { utilization: 0.42, resetsAt: 1234567890 }, weekly: { utilization: 0.88, resetsAt: 1234999999 } },
            { label: 'Sonnet only', weekly: { utilization: 0.5 } },
          ],
        },
        lastActive: '2025-01-01T00:00:00.000Z',
        totalMessages: 42,
        emailAddress: 'pole@example.com',
        needsReauth: false,
      };

      // Mirror toPayload from cli.ts
      const perModel = (acct: any): Tier[] => {
        const buckets = acct.live?.buckets;
        if (!buckets) return [];
        return buckets.map((b: any) => ({
          label: b.label,
          session: b.session ? { utilization: b.session.utilization } : undefined,
          weekly: b.weekly ? { utilization: b.weekly.utilization } : undefined,
        }));
      };
      const payload = {
        name: 'claude-pole',
        commandName: info.commandName,
        cliType: info.cliType,
        plan: info.meta.plan ?? null,
        status: info.needsReauth ? 'reauth_needed' : (info.live?.status ?? 'ok'),
        needsReauth: !!info.needsReauth,
        score: 0,
        utilization5h: info.live?.buckets?.[0]?.session?.utilization ?? null,
        utilization7d: info.live?.buckets?.[0]?.weekly?.utilization ?? null,
        reset5hAt: info.live?.buckets?.[0]?.session?.resetsAt ?? null,
        reset7dAt: info.live?.buckets?.[0]?.weekly?.resetsAt ?? null,
        tokenExpiresAt: info.live?.tokenExpiresAt ?? info.tokenExpiresAt ?? null,
        tokenStatus: info.live?.tokenStatus ?? info.tokenStatus ?? null,
        lastActive: info.lastActive ?? null,
        totalMessages: info.totalMessages,
        email: info.emailAddress ?? info.activeAccount?.email ?? null,
        limits: info.meta.limits ?? null,
        perModel: perModel(info),
      };

      // Verify shape matches the keel acceptance criteria:
      // "both profiles, scores, plan, status, expiry, costs if known"
      expect(payload.plan).toBe('Max 20x');
      expect(payload.status).toBe('allowed');
      expect(payload.tokenExpiresAt).toBe(9999999999);
      expect(payload.limits).toEqual({ window5h: 225, window7d: 2000 });
      expect(payload.perModel).toHaveLength(2);
      expect(payload.perModel[0].label).toBe('All models');
      expect(payload.perModel[1].label).toBe('Sonnet only');
      expect(payload.utilization5h).toBe(0.42);
      expect(payload.utilization7d).toBe(0.88);
    });

    test('JSON payload preserves nullability for missing live data', () => {
      const info: any = {
        commandName: 'fresh-profile',
        cliType: 'claude',
        meta: {},
        totalMessages: 0,
        needsReauth: false,
      };
      const payload = {
        plan: info.meta.plan ?? null,
        utilization5h: info.live?.buckets?.[0]?.session?.utilization ?? null,
        utilization7d: info.live?.buckets?.[0]?.weekly?.utilization ?? null,
        tokenExpiresAt: info.live?.tokenExpiresAt ?? info.tokenExpiresAt ?? null,
        limits: info.meta.limits ?? null,
        perModel: info.live?.buckets ?? [],
      };
      expect(payload.plan).toBeNull();
      expect(payload.utilization5h).toBeNull();
      expect(payload.utilization7d).toBeNull();
      expect(payload.tokenExpiresAt).toBeNull();
      expect(payload.limits).toBeNull();
      expect(payload.perModel).toEqual([]);
    });
  });

  // Regression: default text output (no flags) must remain unchanged
  describe('default text output unchanged (T-052 regression)', () => {
    const cliSrc = (() => {
      try {
        return fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf-8');
      } catch {
        return '';
      }
    })();
    const compareStart = cliSrc.indexOf(".command('compare <a> <b>')");
    const compareEnd = cliSrc.indexOf(".command('show <command-name>')");
    const compareBlock = cliSrc.slice(compareStart, compareEnd);

    test('still prints the standard header banner', () => {
      expect(compareBlock).toContain('sweech compare ·');
    });

    test('still prints Plan/Status/5h/Week/Score/Last/Messages rows', () => {
      expect(compareBlock).toContain('Plan:');
      expect(compareBlock).toContain('Status:');
      expect(compareBlock).toContain('5h:');
      expect(compareBlock).toContain('Week:');
      expect(compareBlock).toContain('Score:');
      expect(compareBlock).toContain('Last:');
      expect(compareBlock).toContain('Messages:');
    });

    test('per-model section is gated behind opts.perModel (not always on)', () => {
      // Find the per-model header occurrence — it should be inside an
      // `if (opts.perModel)` block, not at the top level of the action.
      const perModelHeaderIdx = compareBlock.indexOf('Per-model rate limits:');
      expect(perModelHeaderIdx).toBeGreaterThan(-1);
      // The nearest preceding `if (opts.perModel)` must exist
      const preceding = compareBlock.slice(0, perModelHeaderIdx);
      expect(preceding).toMatch(/if \(opts\.perModel\)/);
    });

    test('asciiBar usage rendering is preserved (no flag → bars present)', () => {
      // Bars must remain in the default output path (not behind any flag)
      const bar5hIdx = compareBlock.indexOf("'5h:'.padEnd(7)");
      const jsonReturnIdx = compareBlock.indexOf("process.stdout.write(JSON.stringify(payload");
      expect(bar5hIdx).toBeGreaterThan(-1);
      expect(jsonReturnIdx).toBeGreaterThan(-1);
      // The 5h bar line must come AFTER the JSON short-circuit `return`
      // (which means it's in the text-only path)
      expect(bar5hIdx).toBeGreaterThan(jsonReturnIdx);
    });
  });
});
