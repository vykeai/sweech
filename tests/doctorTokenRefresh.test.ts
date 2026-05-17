/**
 * T-LU-006: doctor "Token refresh ETA" section.
 *
 * Exercises the rendered output of `runDoctor()` to confirm the new
 * Token refresh ETA section lists each OAuth profile with hours-until-expiry
 * and a status indicator ("due now" / "ok" / "no expiry").
 *
 * Heavy deps (ConfigManager, network probes, account info, CLI detection,
 * symlink/SQLite checks) are mocked out so the test stays fast and hermetic.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('inquirer', () => ({}));
jest.mock('chalk', () => {
  // Pass-through chalk so we can assert on the raw text the user sees.
  const identity = (s: string): string => s;
  const fn = Object.assign(identity, {
    red: identity,
    green: identity,
    yellow: identity,
    cyan: identity,
    gray: identity,
    magenta: identity,
    white: identity,
    dim: identity,
    bold: Object.assign(identity, {
      red: identity, green: identity, cyan: identity, yellow: identity,
    }),
  });
  return { __esModule: true, default: fn, ...fn };
});

jest.mock('../src/config', () => ({
  ConfigManager: jest.fn().mockImplementation(() => ({
    getProfiles: () => mockProfiles,
    getProfileDir: (name: string) => `/mock/home/.${name}`,
    getBinDir: () => '/mock/home/.sweech/bin',
    getConfigFile: () => '/mock/home/.sweech/config.json',
  })),
  SHAREABLE_DIRS: [],
  SHAREABLE_FILES: [],
  CODEX_SHAREABLE_DIRS: [],
  CODEX_SHAREABLE_FILES: [],
  CODEX_SHAREABLE_DBS: [],
  KIMI_SHAREABLE_DIRS: [],
  KIMI_SHAREABLE_FILES: [],
  KEYCHAIN_SERVICE: 'sweech-api-key',
  resolveApiKey: jest.fn(async () => undefined),
}));

jest.mock('../src/credentialStore', () => ({
  getCredentialStore: () => ({ get: async () => null }),
}));

jest.mock('../src/clis', () => ({
  getCLI: () => ({ name: 'claude', displayName: 'Claude Code' }),
}));

jest.mock('../src/providers', () => ({
  getProvider: () => ({ name: 'anthropic', displayName: 'Anthropic' }),
}));

jest.mock('../src/cliDetection', () => ({
  detectInstalledCLIs: jest.fn(async () => []),
}));

jest.mock('../src/profileManagement', () => ({
  renameManagedProfile: jest.fn(),
}));

jest.mock('../src/subscriptions', () => ({
  getKnownAccounts: jest.fn(() => []),
  getAccountInfo: jest.fn(async () => []),
}));

// fs is mocked so doctor's "Usage Cache" / wrapper / profile-dir size checks
// resolve cleanly without touching the host filesystem.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockImplementation((p: string) => {
      // package.json read for version display
      if (typeof p === 'string' && p.endsWith('package.json')) {
        return JSON.stringify({ version: '0.0.0-test' });
      }
      throw new Error('ENOENT (mocked)');
    }),
    statSync: jest.fn(),
    readdirSync: jest.fn(() => []),
    lstatSync: jest.fn(),
    readlinkSync: jest.fn(),
    realpathSync: jest.fn(),
  };
});

// Mock child_process so `du` / `sqlite3` don't actually run.
jest.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    if (cb) cb(new Error('mocked: no execFile'), { stdout: '', stderr: '' });
  },
}));

import { ProfileConfig } from '../src/config';

// Shared profiles fixture — tests reassign mockProfiles per case.
let mockProfiles: ProfileConfig[] = [];

import { runDoctor } from '../src/utilityCommands';
import * as utility from '../src/utilityCommands';

// Replace probeDaemonHealthz so the daemon check doesn't open a socket.
jest.spyOn(utility, 'probeDaemonHealthz').mockResolvedValue({
  status: 'unreachable',
  message: 'daemon offline (mocked)',
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    name: 'oauth-profile',
    commandName: 'oauth-cli',
    cliType: 'claude',
    provider: 'anthropic',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function captureDoctorOutput(): Promise<string> {
  const lines: string[] = [];
  const logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.map(String).join(' '));
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runDoctor();
  } finally {
    logSpy.mockRestore();
  }
  return lines.join('\n');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('doctor — Token refresh ETA section (T-LU-006)', () => {
  afterEach(() => {
    mockProfiles = [];
  });

  test('renders "Token refresh ETA" header when at least one OAuth profile exists', async () => {
    mockProfiles = [
      makeProfile({
        name: 'claude-main',
        oauth: {
          accessToken: 'a',
          refreshToken: 'r',
          tokenType: 'Bearer',
          provider: 'anthropic',
          expiresAt: Date.now() + 48 * HOUR_MS,
        },
      }),
    ];

    const out = await captureDoctorOutput();

    expect(out).toMatch(/Token refresh ETA/);
    expect(out).toMatch(/claude-main/);
  });

  test('omits the section entirely when no profile has OAuth', async () => {
    mockProfiles = [
      makeProfile({ name: 'api-key-only', oauth: undefined }),
    ];

    const out = await captureDoctorOutput();

    expect(out).not.toMatch(/Token refresh ETA/);
  });

  test('flags tokens expiring soon — post-incident: rendered as "managed by CLI"', async () => {
    // Pre-2026-05-17: the doctor rendered "due now" because sweech
    // was about to refresh. Post-incident: sweech does NOT refresh
    // claude/codex/kimi tokens — the CLI itself handles its own
    // refresh against its keychain/auth.json. The doctor surfaces
    // expiry for visibility but does NOT call it a sweech-action.
    mockProfiles = [
      makeProfile({
        name: 'due-soon',
        oauth: {
          accessToken: 'a',
          refreshToken: 'r',
          tokenType: 'Bearer',
          provider: 'anthropic',
          expiresAt: Date.now() + 6 * HOUR_MS,
        },
      }),
    ];

    const out = await captureDoctorOutput();

    expect(out).toMatch(/due-soon/);
    expect(out).toMatch(/managed by CLI/);
    expect(out).toMatch(/h until expiry/);
    expect(out).not.toMatch(/due now/);
  });

  test('tokens far from expiry render as "managed by CLI" (was "ok" pre-incident)', async () => {
    mockProfiles = [
      makeProfile({
        name: 'far-future',
        oauth: {
          accessToken: 'a',
          refreshToken: 'r',
          tokenType: 'Bearer',
          provider: 'anthropic',
          expiresAt: Date.now() + 5 * 24 * HOUR_MS,
        },
      }),
    ];

    const out = await captureDoctorOutput();

    expect(out).toMatch(/far-future/);
    expect(out).toMatch(/managed by CLI/);
    expect(out).toMatch(/(11[89]|120)h until expiry/);
  });

  test('shows hours-until-expiry in the row (post-incident: ISO is no longer rendered)', async () => {
    // Pre-incident the doctor printed the raw ISO timestamp because
    // the operator was supposed to predict the next refresh moment.
    // Post-incident sweech doesn't refresh, so the more useful signal
    // is "how many hours until the CLI will need to refresh on its
    // own" — a relative number, not an absolute timestamp.
    const expiry = Date.now() + 30 * HOUR_MS;
    mockProfiles = [
      makeProfile({
        name: 'hours-check',
        oauth: {
          accessToken: 'a',
          refreshToken: 'r',
          tokenType: 'Bearer',
          provider: 'anthropic',
          expiresAt: expiry,
        },
      }),
    ];

    const out = await captureDoctorOutput();

    expect(out).toMatch(/hours-check/);
    expect(out).toMatch(/(29|30)h until expiry/);
    expect(out).toMatch(/managed by CLI/);
  });

  test('expired tokens still surface — but as "managed by CLI" (sweech does not re-login)', async () => {
    mockProfiles = [
      makeProfile({
        name: 'stale',
        oauth: {
          accessToken: 'a',
          refreshToken: 'r',
          tokenType: 'Bearer',
          provider: 'anthropic',
          expiresAt: Date.now() - 2 * HOUR_MS,
        },
      }),
    ];

    const out = await captureDoctorOutput();

    expect(out).toMatch(/stale/);
    expect(out).toMatch(/managed by CLI/);
    // hoursUntil is negative — we still surface the number so the
    // operator can see "the CLI hasn't refreshed in a while, you
    // may need to re-login".
    expect(out).toMatch(/-?\d+h until expiry/);
  });

  test('skips non-OAuth profiles inside a mixed list', async () => {
    mockProfiles = [
      makeProfile({ name: 'oauth-one', commandName: 'oauth-one',
        oauth: {
          accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer',
          provider: 'anthropic', expiresAt: Date.now() + 48 * HOUR_MS,
        }
      }),
      makeProfile({ name: 'api-key-two', commandName: 'api-key-two', oauth: undefined }),
    ];

    const out = await captureDoctorOutput();

    // OAuth profile shows up in the ETA section
    const etaSection = out.split('Token refresh ETA')[1] ?? '';
    const etaSectionUntilNext = etaSection.split('Profiles (')[0];
    expect(etaSectionUntilNext).toMatch(/oauth-one/);
    expect(etaSectionUntilNext).not.toMatch(/api-key-two/);
  });

  test('handles a profile with no expiry (non-expiring token)', async () => {
    mockProfiles = [
      makeProfile({
        name: 'no-expiry',
        oauth: {
          accessToken: 'a',
          refreshToken: 'r',
          tokenType: 'Bearer',
          provider: 'anthropic',
          expiresAt: undefined,
        },
      }),
    ];

    const out = await captureDoctorOutput();

    expect(out).toMatch(/no-expiry/);
    expect(out).toMatch(/no expiry/);
  });
});
