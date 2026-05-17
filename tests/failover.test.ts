/**
 * Tests for src/failover.ts — T-LU-003.
 *
 * Covers:
 *  - recordRateLimitCooldown writes the marker + audit + emits event
 *  - getActiveCooldowns filters expired + cleans up disk
 *  - isInCooldown / clearCooldown / clearAllCooldowns
 *  - pickFailoverTarget excludes source profile + cooldowns + extra excludes
 *  - recordFailover emits typed event + audit
 *  - startFailoverListener registers exactly once (idempotent)
 *  - listener auto-records cooldown when `limit_reached` fires
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-failover-'));

// Mock auditLog before failover.ts (and accountSelector) load it.
const mockLogAudit = jest.fn();
jest.mock('../src/auditLog', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  readAuditLog: jest.fn().mockReturnValue([]),
}));

// Mock os.homedir so cooldown file lives under TMP_HOME.
jest.mock('os', () => {
  const real = jest.requireActual('os');
  return { ...real, homedir: () => TMP_HOME };
});
jest.mock('node:os', () => {
  const real = jest.requireActual('node:os');
  return { ...real, homedir: () => TMP_HOME };
});

// Stub accountSelector for pickFailoverTarget — keeps tests isolated from
// the real Keychain / fs probing.
const mockSuggestBestAccount = jest.fn();
jest.mock('../src/accountSelector', () => ({
  suggestBestAccount: (...args: unknown[]) => mockSuggestBestAccount(...args),
}));

import {
  recordRateLimitCooldown,
  getActiveCooldowns,
  isInCooldown,
  clearCooldown,
  clearAllCooldowns,
  pickFailoverTarget,
  recordFailover,
  startFailoverListener,
  stopFailoverListener,
  DEFAULT_COOLDOWN_MS,
} from '../src/failover';
import { sweechEvents } from '../src/events';

const COOLDOWN_FILE = path.join(TMP_HOME, '.sweech', 'failover-cooldowns.json');

beforeEach(() => {
  mockLogAudit.mockReset();
  mockSuggestBestAccount.mockReset();
  // Wipe any leftover cooldowns from the previous test.
  try { fs.rmSync(COOLDOWN_FILE, { force: true }); } catch {}
  stopFailoverListener();
});

afterAll(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
});

// ─── recordRateLimitCooldown ─────────────────────────────────────────────────

describe('recordRateLimitCooldown', () => {
  test('writes marker file + audit entry on first call', () => {
    recordRateLimitCooldown('claude-foo', { reason: 'limit_reached' });

    expect(fs.existsSync(COOLDOWN_FILE)).toBe(true);
    const store = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf-8'));
    expect(store['claude-foo']).toBeDefined();
    expect(store['claude-foo'].commandName).toBe('claude-foo');
    expect(store['claude-foo'].reason).toBe('limit_reached');
    expect(store['claude-foo'].expiresAt).toBeGreaterThan(Date.now());

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit.mock.calls[0][0].action).toBe('rate_limit_cooldown');
    expect(mockLogAudit.mock.calls[0][0].account).toBe('claude-foo');
  });

  test('honours custom resetMs override', () => {
    const entry = recordRateLimitCooldown('codex-bar', { resetMs: 60_000 });
    const expectedExpiry = Date.now() + 60_000;
    // Within 1s of expected
    expect(Math.abs(entry.expiresAt - expectedExpiry)).toBeLessThan(1000);
  });

  test('falls back to DEFAULT_COOLDOWN_MS when resetMs is omitted or zero', () => {
    const e1 = recordRateLimitCooldown('claude-default');
    const e2 = recordRateLimitCooldown('claude-zero', { resetMs: 0 });
    expect(e1.expiresAt - Date.now()).toBeGreaterThan(DEFAULT_COOLDOWN_MS - 1000);
    expect(e2.expiresAt - Date.now()).toBeGreaterThan(DEFAULT_COOLDOWN_MS - 1000);
  });

  test('re-recording the same profile overwrites the old entry', () => {
    recordRateLimitCooldown('claude-x', { resetMs: 1000 });
    const first = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf-8'))['claude-x'];
    recordRateLimitCooldown('claude-x', { resetMs: 1_000_000 });
    const second = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf-8'))['claude-x'];
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
    expect(Object.keys(JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf-8'))).length).toBe(1);
  });

  test('emits limit_reached event when window is provided', () => {
    const listener = jest.fn();
    sweechEvents.on('limit_reached', listener);
    try {
      recordRateLimitCooldown('claude-window', { window: '5h' });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        account: 'claude-window',
        window: '5h',
      }));
    } finally {
      sweechEvents.off('limit_reached', listener);
    }
  });

  test('does NOT emit when window is omitted (avoids feedback loop with the listener)', () => {
    const listener = jest.fn();
    sweechEvents.on('limit_reached', listener);
    try {
      recordRateLimitCooldown('claude-no-window');
      expect(listener).not.toHaveBeenCalled();
    } finally {
      sweechEvents.off('limit_reached', listener);
    }
  });

  test('cooldown file is chmod 0600 after write', () => {
    if (process.platform === 'win32') return; // chmod is no-op on Windows
    recordRateLimitCooldown('claude-perm');
    const stat = fs.statSync(COOLDOWN_FILE);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ─── getActiveCooldowns / isInCooldown ───────────────────────────────────────

describe('getActiveCooldowns', () => {
  test('returns empty when no cooldowns recorded', () => {
    expect(getActiveCooldowns()).toEqual([]);
  });

  test('returns active entries and prunes expired ones from disk', () => {
    recordRateLimitCooldown('still-active', { resetMs: 60_000 });
    recordRateLimitCooldown('expired-soon', { resetMs: 1 });

    // Wait past the 1ms expiry
    const future = Date.now() + 100;
    const active = getActiveCooldowns(future);

    expect(active.map(c => c.commandName)).toEqual(['still-active']);
    // Expired entry should be removed from disk
    const store = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf-8'));
    expect(store['expired-soon']).toBeUndefined();
    expect(store['still-active']).toBeDefined();
  });
});

describe('isInCooldown', () => {
  test('true when cooldown is active', () => {
    recordRateLimitCooldown('cool-1', { resetMs: 60_000 });
    expect(isInCooldown('cool-1')).toBe(true);
  });

  test('false when cooldown has expired', () => {
    recordRateLimitCooldown('cool-2', { resetMs: 1 });
    const future = Date.now() + 100;
    expect(isInCooldown('cool-2', future)).toBe(false);
  });

  test('false for unknown profile', () => {
    expect(isInCooldown('never-seen')).toBe(false);
  });
});

// ─── clearCooldown / clearAllCooldowns ───────────────────────────────────────

describe('clearCooldown', () => {
  test('returns true and removes the entry when present', () => {
    recordRateLimitCooldown('to-clear', { resetMs: 60_000 });
    expect(clearCooldown('to-clear')).toBe(true);
    expect(isInCooldown('to-clear')).toBe(false);
    // Audit should record the clear
    const clearCall = mockLogAudit.mock.calls.find(c => c[0].action === 'rate_limit_cooldown_cleared');
    expect(clearCall).toBeDefined();
  });

  test('returns false when no entry exists', () => {
    expect(clearCooldown('not-here')).toBe(false);
  });
});

describe('clearAllCooldowns', () => {
  test('returns count and clears every entry', () => {
    recordRateLimitCooldown('a');
    recordRateLimitCooldown('b');
    recordRateLimitCooldown('c');
    expect(clearAllCooldowns()).toBe(3);
    expect(getActiveCooldowns()).toEqual([]);
    const clearCall = mockLogAudit.mock.calls.find(c => c[0].action === 'rate_limit_cooldown_cleared_all');
    expect(clearCall).toBeDefined();
    expect(clearCall[0].details.count).toBe(3);
  });

  test('returns 0 and skips audit when nothing to clear', () => {
    const count = clearAllCooldowns();
    expect(count).toBe(0);
    expect(mockLogAudit.mock.calls.find(c => c[0].action === 'rate_limit_cooldown_cleared_all')).toBeUndefined();
  });
});

// ─── pickFailoverTarget ──────────────────────────────────────────────────────

describe('pickFailoverTarget', () => {
  function makeRec(commandName: string, score = 50) {
    return {
      account: { name: commandName, commandName, cliType: 'claude', configDir: `/h/.${commandName}`, isDefault: false, isManaged: true },
      score,
      reason: `pick:${commandName}`,
    };
  }

  test('returns suggestBestAccount candidate when nothing excluded', async () => {
    mockSuggestBestAccount.mockResolvedValueOnce(makeRec('claude-best'));
    const target = await pickFailoverTarget(undefined, { profiles: [] });
    expect(target?.account.commandName).toBe('claude-best');
  });

  test('excludes the source profile from the search', async () => {
    mockSuggestBestAccount.mockResolvedValueOnce(makeRec('claude-other'));
    await pickFailoverTarget('claude-main', { profiles: [
      { name: 'claude-main', commandName: 'claude-main', cliType: 'claude', createdAt: '' },
      { name: 'claude-other', commandName: 'claude-other', cliType: 'claude', createdAt: '' },
    ] as any });
    const filtered = mockSuggestBestAccount.mock.calls[0][1];
    expect(filtered.map((p: any) => p.commandName)).not.toContain('claude-main');
    expect(filtered.map((p: any) => p.commandName)).toContain('claude-other');
  });

  test('excludes profiles currently in cooldown', async () => {
    recordRateLimitCooldown('claude-busy', { resetMs: 60_000 });
    mockSuggestBestAccount.mockResolvedValueOnce(makeRec('claude-free'));
    await pickFailoverTarget(undefined, { profiles: [
      { name: 'claude-busy', commandName: 'claude-busy', cliType: 'claude', createdAt: '' },
      { name: 'claude-free', commandName: 'claude-free', cliType: 'claude', createdAt: '' },
    ] as any });
    const filtered = mockSuggestBestAccount.mock.calls[0][1];
    expect(filtered.map((p: any) => p.commandName)).not.toContain('claude-busy');
    expect(filtered.map((p: any) => p.commandName)).toContain('claude-free');
  });

  test('honours --exclude in addition to source + cooldowns', async () => {
    mockSuggestBestAccount.mockResolvedValueOnce(makeRec('claude-d'));
    await pickFailoverTarget('claude-a', {
      profiles: [
        { name: 'claude-a', commandName: 'claude-a', cliType: 'claude', createdAt: '' },
        { name: 'claude-b', commandName: 'claude-b', cliType: 'claude', createdAt: '' },
        { name: 'claude-c', commandName: 'claude-c', cliType: 'claude', createdAt: '' },
        { name: 'claude-d', commandName: 'claude-d', cliType: 'claude', createdAt: '' },
      ] as any,
      exclude: ['claude-b', 'claude-c'],
    });
    const filtered = mockSuggestBestAccount.mock.calls[0][1];
    expect(filtered.map((p: any) => p.commandName).sort()).toEqual(['claude-d']);
  });

  test('returns undefined when no accounts remain', async () => {
    mockSuggestBestAccount.mockResolvedValueOnce(undefined);
    const target = await pickFailoverTarget('claude-only', { profiles: [
      { name: 'claude-only', commandName: 'claude-only', cliType: 'claude', createdAt: '' },
    ] as any });
    expect(target).toBeUndefined();
  });

  test('returns undefined when default account collides with the source', async () => {
    // Even when filtered profiles are empty, suggestBestAccount may return
    // the default account (e.g. "claude"). If that IS the source, we surface
    // "no failover target" rather than recommending the very thing that just
    // hit the rate limit.
    mockSuggestBestAccount.mockResolvedValueOnce(makeRec('claude'));
    const target = await pickFailoverTarget('claude', { profiles: [] });
    expect(target).toBeUndefined();
  });
});

// ─── recordFailover ──────────────────────────────────────────────────────────

describe('recordFailover', () => {
  test('writes audit entry with action failover_rotated', () => {
    recordFailover('claude-a', 'claude-b', 'limit_reached');
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.action).toBe('failover_rotated');
    expect(entry.account).toBe('claude-b');
    expect(entry.details).toEqual({ from: 'claude-a', to: 'claude-b', reason: 'limit_reached' });
  });

  test('emits failover_rotated event with from/to/reason/timestamp', () => {
    const listener = jest.fn();
    sweechEvents.on('failover_rotated', listener);
    try {
      recordFailover('a', 'b', 'r');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        from: 'a',
        to: 'b',
        reason: 'r',
      }));
    } finally {
      sweechEvents.off('failover_rotated', listener);
    }
  });
});

// ─── startFailoverListener ───────────────────────────────────────────────────

describe('startFailoverListener', () => {
  test('registers a listener that records cooldown on limit_reached', () => {
    const stop = startFailoverListener();
    try {
      sweechEvents.emit('limit_reached', {
        account: 'claude-flood',
        window: '5h',
        timestamp: new Date().toISOString(),
      });
      expect(isInCooldown('claude-flood')).toBe(true);
    } finally {
      stop();
    }
  });

  test('idempotent: calling twice does NOT double-fire on a single event', () => {
    const stop1 = startFailoverListener();
    const stop2 = startFailoverListener();
    try {
      sweechEvents.emit('limit_reached', {
        account: 'claude-once',
        window: '5h',
        timestamp: new Date().toISOString(),
      });
      // Both audit entries: 1 from recordRateLimitCooldown's audit call
      // (NOT 2). If we double-fired, we'd see 2 audits.
      const audits = mockLogAudit.mock.calls.filter(c => c[0].action === 'rate_limit_cooldown' && c[0].account === 'claude-once');
      expect(audits.length).toBe(1);
    } finally {
      stop1();
      stop2();
    }
  });

  test('stopFailoverListener unregisters the listener', () => {
    const stop = startFailoverListener();
    stop();
    sweechEvents.emit('limit_reached', {
      account: 'claude-after-stop',
      window: '5h',
      timestamp: new Date().toISOString(),
    });
    expect(isInCooldown('claude-after-stop')).toBe(false);
  });

  test('5h window → 15min cooldown; 7d window → 60min cooldown', () => {
    const stop = startFailoverListener();
    try {
      sweechEvents.emit('limit_reached', {
        account: 'short-window',
        window: '5h',
        timestamp: new Date().toISOString(),
      });
      sweechEvents.emit('limit_reached', {
        account: 'long-window',
        window: '7d',
        timestamp: new Date().toISOString(),
      });

      const store = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf-8'));
      const short = store['short-window'].expiresAt - store['short-window'].recordedAt;
      const long = store['long-window'].expiresAt - store['long-window'].recordedAt;
      expect(short).toBe(15 * 60 * 1000);
      expect(long).toBe(60 * 60 * 1000);
    } finally {
      stop();
    }
  });
});
