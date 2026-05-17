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

function makeProfile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    name: 'test-account',
    commandName: 'test-cli',
    cliType: 'claude',
    provider: 'anthropic',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOAuth(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    accessToken: 'access-original',
    refreshToken: 'refresh-original',
    tokenType: 'Bearer',
    provider: 'anthropic',
    expiresAt: Date.now() + 23 * HOUR_MS, // due now by default
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
// TWENTY_FOUR_HOURS_MS constant
// ─────────────────────────────────────────────────────────────────────────────

describe('TWENTY_FOUR_HOURS_MS', () => {
  test('equals 24 * 60 * 60 * 1000', () => {
    expect(TWENTY_FOUR_HOURS_MS).toBe(24 * 60 * 60 * 1000);
    expect(TWENTY_FOUR_HOURS_MS).toBe(86_400_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// refreshExpiringTokens — refresh window
// ─────────────────────────────────────────────────────────────────────────────

describe('refreshExpiringTokens — 24h window', () => {
  test('refreshes when token expires in 23 hours', async () => {
    const profile = makeProfile({
      oauth: makeOAuth({ expiresAt: Date.now() + 23 * HOUR_MS }),
    });

    mockRefreshOAuthToken.mockResolvedValueOnce({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      tokenType: 'Bearer',
      provider: 'anthropic',
      expiresAt: Date.now() + 30 * 24 * HOUR_MS,
    });

    await refreshExpiringTokens([profile]);

    expect(mockRefreshOAuthToken).toHaveBeenCalledTimes(1);
  });

  test('does NOT refresh when token expires in 25 hours', async () => {
    const profile = makeProfile({
      oauth: makeOAuth({ expiresAt: Date.now() + 25 * HOUR_MS }),
    });

    await refreshExpiringTokens([profile]);

    expect(mockRefreshOAuthToken).not.toHaveBeenCalled();
  });

  test('refreshes when token already expired (negative window)', async () => {
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

    expect(mockRefreshOAuthToken).toHaveBeenCalledTimes(1);
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
// Audit logging
// ─────────────────────────────────────────────────────────────────────────────

describe('refreshExpiringTokens — audit log', () => {
  test('writes a token_refresh audit entry on success', async () => {
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

  test('audits failure (not success) when settings.json is unreadable after upstream refresh', async () => {
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

  test('writes a token_refresh_failed audit entry on error', async () => {
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

  test('scrubs secrets out of failure messages', async () => {
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

  test('audits per profile when multiple refreshes happen in one tick', async () => {
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

  test('returns dueNow=false and hoursUntil=null when expiresAt is undefined', () => {
    const profile = makeProfile({ oauth: makeOAuth({ expiresAt: undefined }) });
    const eta = getNextRefreshEta(profile);
    expect(eta).not.toBeNull();
    expect(eta!.expiresAt).toBeNull();
    expect(eta!.hoursUntil).toBeNull();
    expect(eta!.dueNow).toBe(false);
  });

  test('returns dueNow=true when token expires within 24h', () => {
    const profile = makeProfile({
      name: 'soon',
      commandName: 'soon-cli',
      oauth: makeOAuth({ expiresAt: Date.now() + 5 * HOUR_MS }),
    });
    const eta = getNextRefreshEta(profile);
    expect(eta).toEqual({
      profile: 'soon',
      commandName: 'soon-cli',
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      hoursUntil: expect.any(Number),
      dueNow: true,
    });
    expect(eta!.hoursUntil).toBeGreaterThanOrEqual(4);
    expect(eta!.hoursUntil).toBeLessThanOrEqual(5);
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

  test('returns negative hoursUntil for already-expired tokens', () => {
    const profile = makeProfile({
      oauth: makeOAuth({ expiresAt: Date.now() - 3 * HOUR_MS }),
    });
    const eta = getNextRefreshEta(profile);
    expect(eta!.hoursUntil).toBeLessThanOrEqual(-3);
    expect(eta!.dueNow).toBe(true);
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
