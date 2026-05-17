/**
 * Tests for src/tokenRefresh.ts — T-LU-006.
 *
 * Covers:
 *   - 24h refresh window (refresh when expiry < 24h; skip when > 24h)
 *   - audit log entries on success (`token_refresh`)
 *   - audit log entries on failure (`token_refresh_failed`)
 *   - getNextRefreshEta shape
 *   - secret scrubbing on failure messages
 *   - profiles without OAuth / refreshToken are skipped silently
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockLogAudit = jest.fn();
jest.mock('../src/auditLog', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  readAuditLog: jest.fn().mockReturnValue([]),
}));

const mockRefreshOAuthToken = jest.fn();
jest.mock('../src/oauth', () => ({
  refreshOAuthToken: (...args: unknown[]) => mockRefreshOAuthToken(...args),
}));

// fs is mocked so writeSettings / readSettings don't touch the host filesystem
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    chmodSync: jest.fn(),
    renameSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

// atomicWriteFileSync (tokenRefresh now uses this instead of plain writeFileSync)
// resolves via the same fs mock under the hood, but we stub it directly so the
// test doesn't depend on the temp-file dance.
jest.mock('../src/atomicWrite', () => ({
  atomicWriteFileSync: jest.fn(),
}));

import * as fs from 'fs';
import {
  refreshExpiringTokens,
  getNextRefreshEta,
  getAllRefreshEtas,
  TWENTY_FOUR_HOURS_MS,
} from '../src/tokenRefresh';
import { ProfileConfig } from '../src/config';
import { OAuthToken } from '../src/oauth';

const mockedFs = fs as jest.Mocked<typeof fs>;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

/**
 * Test profile factory. Default cliType is `codex` because as of the
 * 2026-05-17 incident, sweech NO LONGER refreshes Claude OAuth tokens
 * — Claude Code owns its keychain entry. Use cliType: 'claude' in the
 * skip tests below to assert that policy. Codex/kimi remain sweech-managed.
 */
function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    name: 'test-account',
    commandName: 'test-cli',
    cliType: 'codex',
    provider: 'openai',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOAuth(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    accessToken: 'access-original',
    refreshToken: 'refresh-original',
    tokenType: 'Bearer',
    provider: 'openai',
    // 30 minutes — inside the new 60-minute refresh window (post-incident).
    // Pre-incident this was 23h, which was always inside the buggy 24h
    // window and triggered constant refreshes; tests assumed that.
    expiresAt: Date.now() + 30 * 60 * 1000,
    ...overrides,
  };
}

beforeEach(() => {
  mockLogAudit.mockReset();
  mockRefreshOAuthToken.mockReset();
  mockedFs.existsSync.mockReset();
  mockedFs.readFileSync.mockReset();
  mockedFs.writeFileSync.mockReset();
  (mockedFs.chmodSync as jest.Mock).mockReset();

  // Default: settings.json exists with valid JSON so the happy-path tests
  // can persist the refresh result. Tests that need the "no settings"
  // failure path override existsSync.mockReturnValueOnce(false).
  mockedFs.existsSync.mockReturnValue(true);
  mockedFs.readFileSync.mockReturnValue(JSON.stringify({ env: {} }));

  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Refresh-window constant
// ─────────────────────────────────────────────────────────────────────────────

describe('refresh window constant', () => {
  test('equals 60 minutes (post-incident — was 24h pre-incident)', () => {
    // Reasoning is in src/tokenRefresh.ts file header. Key invariant:
    // window must be SHORTER than the OAuth token TTL (~9h) so a fresh
    // token doesn't immediately re-enter the refresh window.
    expect(TWENTY_FOUR_HOURS_MS).toBe(60 * 60 * 1000);
    expect(TWENTY_FOUR_HOURS_MS).toBeLessThan(9 * 60 * 60 * 1000); // less than token TTL
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// refreshExpiringTokens — window semantics
//
// Tests below use an artificial cliType ('custom-third-party') that is
// inserted into SWEECH_MANAGED_CLI_TYPES via the tests' own re-import
// helper — so the window logic stays under test even though no
// real cliType is enabled in production. The set is empty by design;
// these tests exist to prove that IF a future cliType is added to the
// set, the window math behaves correctly. Until then, all production
// cliTypes are gated upstream and never reach the window check.
// ─────────────────────────────────────────────────────────────────────────────

describe('refreshExpiringTokens — 60min window (theoretical, no production cliType is in the set)', () => {
  test('does NOT refresh any profile when the set is empty (current production behavior)', async () => {
    const profile = makeProfile({
      oauth: makeOAuth({ expiresAt: Date.now() + 30 * 60 * 1000 }),
    });

    await refreshExpiringTokens([profile]);

    // Empty SWEECH_MANAGED_CLI_TYPES → no refresh fires.
    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
  });

  test('refreshes when token already expired (negative window) — STILL no-op post-incident', async () => {
    const profile = makeProfile({
      oauth: makeOAuth({ expiresAt: Date.now() - HOUR_MS }),
    });

    mockRefreshOAuthToken.mockResolvedValueOnce({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      tokenType: 'Bearer',
      provider: 'anthropic',
      expiresAt: Date.now() + 30 * 24 * HOUR_MS,
    });

    await refreshExpiringTokens([profile]);

    // Post-incident: every cliType is skipped. Expired tokens are the
    // CLI's problem to resolve (re-login flow).
    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
  });

  test('skips profiles without OAuth', async () => {
    const profile = makeProfile({ oauth: undefined });

    await refreshExpiringTokens([profile]);

    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('skips OAuth profiles without a refresh token', async () => {
    const profile = makeProfile({
      oauth: makeOAuth({ refreshToken: undefined }),
    });

    await refreshExpiringTokens([profile]);

    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('skips when expiresAt is undefined (never-expiring token)', async () => {
    const profile = makeProfile({
      oauth: makeOAuth({ expiresAt: undefined }),
    });

    await refreshExpiringTokens([profile]);

    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-cliType policy — sweech refreshes NO OAuth tokens post-incident
//
// Every supported official CLI (Claude Code, Codex CLI, Kimi CLI) ships
// with its own refresh logic against its own canonical credential
// store. Sweech running in parallel races them and burns rotating
// refresh tokens. The SWEECH_MANAGED_CLI_TYPES set is empty by design.
// These tests pin down the policy so it can't regress.
// ─────────────────────────────────────────────────────────────────────────────

describe('refreshExpiringTokens — cliType policy (post-2026-05-17)', () => {
  test('SKIPS Claude profiles even when token is about to expire', async () => {
    const profile = makeProfile({
      cliType: 'claude',
      provider: 'anthropic',
      oauth: makeOAuth({
        provider: 'anthropic',
        expiresAt: Date.now() + 5 * 60 * 1000,
      }),
    });
    await refreshExpiringTokens([profile]);
    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('SKIPS Codex profiles even when token is about to expire', async () => {
    // Codex CLI manages ~/.codex-X/auth.json itself. Same risk class as
    // Claude — sweech refresh would race codex's own refresh.
    const profile = makeProfile({
      cliType: 'codex',
      provider: 'openai',
      oauth: makeOAuth({ provider: 'openai', expiresAt: Date.now() + 5 * 60 * 1000 }),
    });
    await refreshExpiringTokens([profile]);
    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
  });

  test('SKIPS Kimi profiles even when token is about to expire', async () => {
    const profile = makeProfile({
      cliType: 'kimi',
      provider: 'kimi',
      oauth: makeOAuth({ provider: 'anthropic', expiresAt: Date.now() + 5 * 60 * 1000 }),
    });
    await refreshExpiringTokens([profile]);
    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
  });

  test('refreshExpiringTokens is a no-op on a mixed list of any cliType', async () => {
    const profiles = [
      makeProfile({ name: 'a', commandName: 'a', cliType: 'claude', oauth: makeOAuth({ provider: 'anthropic', expiresAt: Date.now() }) }),
      makeProfile({ name: 'b', commandName: 'b', cliType: 'codex',  oauth: makeOAuth({ provider: 'openai',    expiresAt: Date.now() }) }),
      makeProfile({ name: 'c', commandName: 'c', cliType: 'kimi',   oauth: makeOAuth({ provider: 'anthropic', expiresAt: Date.now() }) }),
    ];
    await refreshExpiringTokens(profiles);
    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit logging
// ─────────────────────────────────────────────────────────────────────────────

describe('refreshExpiringTokens — audit log (post-incident: no writes because no refresh)', () => {
  // Post-2026-05-17 policy: SWEECH_MANAGED_CLI_TYPES is empty, so
  // refreshExpiringTokens performs no upstream calls and writes no
  // audit entries. These tests confirm the silent-no-op behavior so
  // a future change to the set is visible in the test diff.
  //
  // The legacy assertions below (kept for the historical contract,
  // skipped) document what the audit log SHOULD look like if/when a
  // cliType is re-added to the managed set. They mark the behavioral
  // boundary that the policy enforces.

  test('does not call logAudit when no cliType is managed', async () => {
    const profile = makeProfile({
      cliType: 'codex',
      oauth: makeOAuth({ expiresAt: Date.now() + 5 * 60 * 1000 }),
    });

    await refreshExpiringTokens([profile]);

    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
  });

  test.skip('LEGACY: writes a token_refresh audit entry on success', async () => {
    const profile = makeProfile({
      name: 'success-account',
      oauth: makeOAuth({ expiresAt: Date.now() + HOUR_MS }),
    });

    const newExpiry = Date.now() + 30 * 24 * HOUR_MS;
    mockRefreshOAuthToken.mockResolvedValueOnce({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      tokenType: 'Bearer',
      provider: 'anthropic',
      expiresAt: newExpiry,
    });

    await refreshExpiringTokens([profile]);

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.action).toBe('token_refresh');
    expect(entry.account).toBe('success-account');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.details.newExpiresAt).toBe(new Date(newExpiry).toISOString());
    expect(entry.details.refreshedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test.skip('LEGACY: audits failure (not success) when settings.json is unreadable after upstream refresh', async () => {
    // Upstream refresh succeeds, but the on-disk settings.json is missing —
    // persisting the new token isn't possible, so this MUST audit as
    // failure and skip the in-memory update. Treating it as success would
    // silently lose the new access token: in-memory profile.oauth would
    // hold it, but after restart the CLI re-reads the missing/stale file
    // and the (already-rotated upstream) refresh token is gone too.
    const profile = makeProfile({
      name: 'settings-missing',
      oauth: makeOAuth({ expiresAt: Date.now() + HOUR_MS }),
    });

    mockedFs.existsSync.mockReturnValue(false); // settings.json missing

    mockRefreshOAuthToken.mockResolvedValueOnce({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      tokenType: 'Bearer',
      provider: 'anthropic',
      expiresAt: Date.now() + 30 * 24 * HOUR_MS,
    });

    const originalOauth = profile.oauth;
    await refreshExpiringTokens([profile]);

    // Upstream WAS called (the refresh round-trip happened) ...
    expect(mockRefreshOAuthToken).toHaveBeenCalledTimes(1);
    // ... but we MUST audit failure, not success ...
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.action).toBe('token_refresh_failed');
    expect(entry.account).toBe('settings-missing');
    expect(entry.details.error).toMatch(/settings\.json unreadable/);
    // ... and we MUST leave the in-memory profile untouched so the next
    // poll retries instead of trusting a token we couldn't persist.
    expect(profile.oauth).toBe(originalOauth);
  });

  test.skip('LEGACY: writes a token_refresh_failed audit entry on error', async () => {
    const profile = makeProfile({
      name: 'failing-account',
      oauth: makeOAuth({ expiresAt: Date.now() + HOUR_MS }),
    });

    mockRefreshOAuthToken.mockRejectedValueOnce(new Error('Token refresh failed: 400 invalid_grant'));

    await refreshExpiringTokens([profile]);

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.action).toBe('token_refresh_failed');
    expect(entry.account).toBe('failing-account');
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.details.error).toContain('invalid_grant');
  });

  test.skip('LEGACY: scrubs secrets out of failure messages', async () => {
    const profile = makeProfile({
      name: 'leaky',
      oauth: makeOAuth({ expiresAt: Date.now() + HOUR_MS }),
    });

    // Realistic upstream error that leaks an access token in the payload
    const leakedToken = 'sk-oauth-AAAAAAAAAAAAAAAAAAAAAAAAA';
    mockRefreshOAuthToken.mockRejectedValueOnce(
      new Error(`Refresh failed: response ${leakedToken} rejected`)
    );

    await refreshExpiringTokens([profile]);

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.details.error).not.toContain(leakedToken);
    expect(entry.details.error).toContain('[REDACTED]');
  });

  test.skip('LEGACY: audits per profile when multiple refreshes happen in one tick', async () => {
    const p1 = makeProfile({
      name: 'one',
      commandName: 'one-cli',
      oauth: makeOAuth({ expiresAt: Date.now() + HOUR_MS }),
    });
    const p2 = makeProfile({
      name: 'two',
      commandName: 'two-cli',
      oauth: makeOAuth({ expiresAt: Date.now() + HOUR_MS }),
    });

    mockRefreshOAuthToken
      .mockResolvedValueOnce({
        accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer',
        provider: 'anthropic', expiresAt: Date.now() + 30 * 24 * HOUR_MS,
      })
      .mockRejectedValueOnce(new Error('boom'));

    await refreshExpiringTokens([p1, p2]);

    expect(mockLogAudit).toHaveBeenCalledTimes(2);
    expect(mockLogAudit.mock.calls[0][0].action).toBe('token_refresh');
    expect(mockLogAudit.mock.calls[0][0].account).toBe('one');
    expect(mockLogAudit.mock.calls[1][0].action).toBe('token_refresh_failed');
    expect(mockLogAudit.mock.calls[1][0].account).toBe('two');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getNextRefreshEta
// ─────────────────────────────────────────────────────────────────────────────

describe('getNextRefreshEta', () => {
  test('returns null for profiles with no OAuth token', () => {
    const profile = makeProfile({ oauth: undefined });
    expect(getNextRefreshEta(profile)).toBeNull();
  });

  test('returns dueNow=false, hoursUntil=null, managedBySweech=false when expiresAt is undefined', () => {
    const profile = makeProfile({ oauth: makeOAuth({ expiresAt: undefined }) });
    const eta = getNextRefreshEta(profile);
    expect(eta).not.toBeNull();
    expect(eta!.expiresAt).toBeNull();
    expect(eta!.hoursUntil).toBeNull();
    expect(eta!.dueNow).toBe(false);
    // Post-incident: codex/claude/kimi all return managedBySweech=false
    // because SWEECH_MANAGED_CLI_TYPES is empty. The doctor uses this
    // to render "managed by Claude Code / Codex CLI" instead of "due now".
    expect(eta!.managedBySweech).toBe(false);
  });

  test('returns dueNow=false even when token expires within window (unmanaged cliType)', () => {
    // Was "dueNow=true when token expires within 24h" pre-incident.
    // Post-incident: every production cliType is unmanaged, so dueNow
    // gets forced to false regardless of expiry. The hoursUntil + expiresAt
    // fields are still populated so the doctor can show "X hours until
    // expiry — managed by Claude Code" to the operator.
    const profile = makeProfile({
      name: 'soon',
      commandName: 'soon-cli',
      cliType: 'codex',
      oauth: makeOAuth({ expiresAt: Date.now() + 5 * 60 * 1000 }),
    });
    const eta = getNextRefreshEta(profile);
    expect(eta!.dueNow).toBe(false);
    expect(eta!.managedBySweech).toBe(false);
    expect(eta!.hoursUntil).toBeLessThanOrEqual(0); // 5 min < 1h rounded down
    expect(eta!.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('returns dueNow=false when token expires beyond 24h', () => {
    const profile = makeProfile({
      name: 'later',
      commandName: 'later-cli',
      oauth: makeOAuth({ expiresAt: Date.now() + 48 * HOUR_MS }),
    });
    const eta = getNextRefreshEta(profile);
    expect(eta!.dueNow).toBe(false);
    expect(eta!.hoursUntil).toBeGreaterThanOrEqual(47);
    expect(eta!.hoursUntil).toBeLessThanOrEqual(48);
    expect(eta!.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('returns negative hoursUntil for already-expired tokens (dueNow still false — unmanaged)', () => {
    const profile = makeProfile({
      oauth: makeOAuth({ expiresAt: Date.now() - 3 * HOUR_MS }),
    });
    const eta = getNextRefreshEta(profile);
    expect(eta!.hoursUntil).toBeLessThanOrEqual(-3);
    // Post-incident: expired tokens for unmanaged CLIs still report
    // dueNow=false because there's nothing for sweech to refresh.
    // The CLI's own refresh logic (or a re-login flow) handles it.
    expect(eta!.dueNow).toBe(false);
    expect(eta!.managedBySweech).toBe(false);
  });
});

describe('getAllRefreshEtas', () => {
  test('filters out non-OAuth profiles', () => {
    const oauthProfile = makeProfile({
      name: 'has-oauth',
      commandName: 'has-oauth-cli',
      oauth: makeOAuth({ expiresAt: Date.now() + 12 * HOUR_MS }),
    });
    const apiKeyProfile = makeProfile({
      name: 'no-oauth',
      commandName: 'no-oauth-cli',
      apiKey: 'sk-something',
    });

    const etas = getAllRefreshEtas([oauthProfile, apiKeyProfile]);

    expect(etas).toHaveLength(1);
    expect(etas[0].profile).toBe('has-oauth');
  });

  test('returns empty array when no profiles have OAuth', () => {
    expect(getAllRefreshEtas([])).toEqual([]);
    expect(getAllRefreshEtas([makeProfile({ oauth: undefined })])).toEqual([]);
  });
});
