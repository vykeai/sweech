/**
 * Background token refresh for OAuth profiles.
 *
 * Scope: **codex and kimi only**. Claude Code manages its own OAuth
 * refresh against the keychain entry `Claude Code-credentials[-hash]`
 * (single source of truth that Claude Code itself reads). Sweech used
 * to refresh Claude OAuth too, but:
 *
 *   1. Sweech wrote new tokens to its own `settings.json` — Claude Code
 *      reads the keychain, so sweech's refreshed token was invisible
 *      to Claude Code.
 *   2. Anthropic uses rotating refresh tokens — each refresh response
 *      includes a new refresh token, and the old one is invalidated
 *      server-side on use. Sweech's refresh burned the old refresh
 *      token but Claude Code's keychain still held it → next time
 *      Claude Code tried to refresh, 401 invalid_grant → permanent
 *      re-login required.
 *   3. Compounded by a window bug (see expiresWithin docstring below)
 *      that caused sweech to refresh on every poll instead of once per
 *      token lifetime, sweech raced Claude Code thousands of times per
 *      day per profile.
 *
 * Incident: 2026-05-17 — every Claude session on a MacBook with the
 * post-T-LU-006 daemon running became unauthenticated. Studio (older
 * sweech, 10-minute window) stayed healthy.
 *
 * Codex and kimi don't have this problem: their CLIs read the API key
 * from `settings.env` via sweech's wrapper script, so settings.json IS
 * the source of truth. Sweech's refresh updates the only place those
 * CLIs would look.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProfileConfig } from './config';
import { refreshOAuthToken } from './oauth';
import { sweechEvents } from './events';
import { scrubSecrets } from './scrubSecrets';
import { logAudit } from './auditLog';
import { atomicWriteFileSync } from './atomicWrite';

/**
 * Refresh window — how close to expiry a token must be before we refresh.
 *
 * Old value (T-LU-006): 24 hours. **Buggy** — Anthropic and OpenAI
 * tokens have a ~9-hour TTL, so `expires in <24h` was true 100% of the
 * time after a refresh. Result: refresh fired on every poll (every 5
 * minutes), thousands of times per day per profile, burning rotating
 * refresh tokens and racing the CLI's own refresh logic.
 *
 * New value: 60 minutes. Covers sleep/standby gaps shorter than an
 * hour with a single poll-cycle of slack to retry on transient errors.
 * Gaps longer than an hour just trigger a fresh refresh on wake —
 * same idle behavior as the upstream CLIs themselves.
 */
export const REFRESH_WINDOW_MS = 60 * 60 * 1000;
/** Backwards-compatible alias — old name kept so dist callers don't break. */
export const TWENTY_FOUR_HOURS_MS = REFRESH_WINDOW_MS;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * CLI types whose OAuth refresh is owned by sweech.
 *
 * **Currently empty.** Post-incident (2026-05-17) policy: every
 * supported official CLI (Claude Code, Codex CLI, Kimi CLI) ships with
 * its own OAuth refresh logic against its own canonical credential
 * store (keychain for Claude, ~/.codex-X/auth.json for codex, similar
 * for kimi). Sweech refreshing in parallel:
 *
 *   - races the CLI's own refresh against the same upstream endpoint
 *   - burns the rotating refresh token if sweech's call lands first
 *   - writes the new token to a place the CLI does NOT read
 *     (settings.env / settings.json — not the canonical store)
 *
 * Result: the CLI is left holding a refresh token sweech already
 * burned, so the next CLI refresh attempt 401s with invalid_grant and
 * the user is forced to re-login.
 *
 * The set is kept rather than removed so a future third-party CLI
 * with no built-in refresh can be added back as a single-line change.
 * Empty set means refreshExpiringTokens is a no-op — by design.
 *
 * See file header for the 2026-05-17 incident write-up.
 */
const SWEECH_MANAGED_CLI_TYPES = new Set<string>();

/**
 * Resolve the settings.json path for a given profile.
 */
function getSettingsPath(profile: ProfileConfig): string {
  const profileDir = path.join(os.homedir(), `.${profile.commandName}`);
  return path.join(profileDir, 'settings.json');
}

/**
 * Read and parse the settings.json for a profile.
 * Returns null if the file does not exist or cannot be parsed.
 */
function readSettings(settingsPath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(settingsPath)) return null;
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write settings back to the profile's settings.json.
 *
 * Atomic write (temp file + rename) — concurrent readers (the wrapper
 * script's python3 hoist, getCurrentApiKey, peer sweech invocations)
 * never observe a truncated half-written file. mode 0o600 is applied to
 * the TEMP file BEFORE rename so the freshly-rotated refresh token never
 * appears as world-readable, even for the rename↔chmod window.
 */
function writeSettings(settingsPath: string, settings: Record<string, any>): void {
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

/**
 * Check whether a token's remaining TTL has dropped below `windowMs`.
 *
 * Returns `true` when the token expires within the next `windowMs`,
 * i.e. it is time to refresh.
 *
 * Important: callers must use a window SHORTER than the token's TTL.
 * Anthropic and OpenAI tokens have ~9-hour TTLs; a 24-hour window
 * matches every freshly-refreshed token and triggers refresh on every
 * poll — see the file header for the incident this caused.
 */
function expiresWithin(expiresAt: number | undefined, windowMs: number): boolean {
  if (expiresAt == null) return false;
  return expiresAt - Date.now() < windowMs;
}

/**
 * Shape returned by getNextRefreshEta — used by the doctor command to render
 * the per-profile "Token refresh ETA" section.
 */
export interface RefreshEta {
  /** Profile name (display label, not commandName). */
  profile: string;
  /** Profile command name (for `sweech auth <cmd>` suggestions). */
  commandName: string;
  /** OAuth expiry as an ISO-8601 timestamp, or null if no expiry is known. */
  expiresAt: string | null;
  /** Whole hours until the token expires. May be negative if already expired. */
  hoursUntil: number | null;
  /** True when the token is within the refresh window (or already expired). */
  dueNow: boolean;
  /**
   * True when sweech is responsible for refreshing this token. False
   * for Claude profiles — Claude Code owns its own keychain entry, so
   * sweech reports the expiry but does NOT refresh. The doctor uses
   * this to show "(managed by Claude Code)" rather than "due now".
   */
  managedBySweech: boolean;
}

/**
 * Compute the next-refresh ETA for a single profile.
 *
 * Returns null when the profile has no OAuth token at all — callers should
 * filter those out before rendering. Profiles without an `expiresAt` (e.g.
 * non-expiring tokens) get `dueNow: false` and `hoursUntil: null` so they
 * render as "no expiry" in doctor.
 */
export function getNextRefreshEta(profile: ProfileConfig): RefreshEta | null {
  if (!profile.oauth) return null;

  const managedBySweech = SWEECH_MANAGED_CLI_TYPES.has(profile.cliType);
  const expiresAtMs = profile.oauth.expiresAt;
  if (expiresAtMs == null) {
    return {
      profile: profile.name,
      commandName: profile.commandName,
      expiresAt: null,
      hoursUntil: null,
      dueNow: false,
      managedBySweech,
    };
  }

  const hoursUntil = Math.floor((expiresAtMs - Date.now()) / (60 * 60 * 1000));
  // dueNow only signals an actionable refresh when sweech manages this
  // CLI's tokens. For Claude profiles, "due" would be misleading —
  // there's nothing for sweech to do; Claude Code will refresh on its
  // own schedule via its own keychain entry.
  return {
    profile: profile.name,
    commandName: profile.commandName,
    expiresAt: new Date(expiresAtMs).toISOString(),
    hoursUntil,
    dueNow: managedBySweech && expiresWithin(expiresAtMs, REFRESH_WINDOW_MS),
    managedBySweech,
  };
}

/**
 * Compute next-refresh ETAs for every OAuth-backed profile.
 * Non-OAuth profiles are filtered out.
 */
export function getAllRefreshEtas(profiles: ProfileConfig[]): RefreshEta[] {
  const result: RefreshEta[] = [];
  for (const profile of profiles) {
    const eta = getNextRefreshEta(profile);
    if (eta) result.push(eta);
  }
  return result;
}

/**
 * Iterate profiles and refresh any OAuth tokens expiring within 24 hours.
 *
 * Every attempt is logged to ~/.sweech/audit.jsonl — `token_refresh` on
 * success, `token_refresh_failed` on error. Errors are scrubbed of any
 * leaked secrets before being written to the audit log or stderr.
 */
export async function refreshExpiringTokens(profiles: ProfileConfig[]): Promise<void> {
  for (const profile of profiles) {
    if (!profile.oauth) continue;
    if (!profile.oauth.refreshToken) continue;
    // Incident 2026-05-17: never refresh Claude OAuth. Claude Code is
    // the canonical owner of its keychain credential entry — sweech
    // refreshing here races CC's own refresh, burns rotating refresh
    // tokens, and writes the result to settings.json (which CC never
    // reads). Codex and kimi DO use settings.env as the source of
    // truth via the wrapper script, so refreshing them is correct.
    if (!SWEECH_MANAGED_CLI_TYPES.has(profile.cliType)) continue;
    if (!expiresWithin(profile.oauth.expiresAt, REFRESH_WINDOW_MS)) continue;

    try {
      const newToken = await refreshOAuthToken(profile.oauth);

      // Update the on-disk settings.json
      const settingsPath = getSettingsPath(profile);
      const settings = readSettings(settingsPath);

      if (!settings) {
        // The refresh succeeded against the upstream OAuth server but the
        // on-disk settings.json is missing/unreadable, so persisting the new
        // access token isn't possible. Treating this as success would leak:
        // in-memory profile.oauth would be updated, but after restart the
        // CLI re-reads the (stale or empty) file and the new token is
        // silently lost — and the old refresh token, having been used once,
        // may already be rotated by the upstream server, locking the user
        // out. Audit as failure and skip the in-memory update so the next
        // poll retries instead of believing the refresh is good.
        const msg = `settings.json unreadable at ${settingsPath} — refresh discarded`;
        console.error(`[sweech] token refresh failed for ${profile.name}:`, msg);
        logAudit({
          timestamp: new Date().toISOString(),
          action: 'token_refresh_failed',
          account: profile.name,
          details: { error: msg },
        });
        sweechEvents.emit('token_expired', { account: profile.name });
        continue;
      }

      // Update the stored OAuth metadata
      settings.oauth = {
        provider: newToken.provider,
        refreshToken: newToken.refreshToken,
        expiresAt: newToken.expiresAt,
      };

      // Update the auth env var with the fresh access token
      if (!settings.env) settings.env = {};

      if (profile.cliType === 'codex') {
        settings.env.OPENAI_API_KEY = `sk-oauth-${newToken.accessToken}`;
      } else if (profile.cliType === 'kimi') {
        settings.env.KIMI_API_KEY = `bearer_${newToken.accessToken}`;
      } else {
        settings.env.ANTHROPIC_AUTH_TOKEN = `bearer_${newToken.accessToken}`;
      }

      writeSettings(settingsPath, settings);

      // Update the in-memory profile reference
      profile.oauth = newToken;

      const refreshedAt = new Date().toISOString();
      const newExpiresAt = newToken.expiresAt
        ? new Date(newToken.expiresAt).toISOString()
        : null;

      // T-LU-006: audit success. `details` is intentionally minimal — no
      // tokens or refresh material so the log is safe to share.
      logAudit({
        timestamp: refreshedAt,
        action: 'token_refresh',
        account: profile.name,
        details: { newExpiresAt, refreshedAt },
      });

      sweechEvents.emit('token_refreshed', {
        account: profile.name,
        expiresAt: newExpiresAt ?? '',
      });
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg = scrubSecrets(rawMsg);
      console.error(`[sweech] token refresh failed for ${profile.name}:`, msg);

      // T-LU-006: audit failure with scrubbed error so operators can see
      // *why* refresh keeps failing without exposing token material.
      logAudit({
        timestamp: new Date().toISOString(),
        action: 'token_refresh_failed',
        account: profile.name,
        details: { error: msg },
      });

      sweechEvents.emit('token_expired', {
        account: profile.name,
      });
    }
  }
}

/**
 * Start a background loop that refreshes expiring tokens on a fixed interval.
 * Returns a cleanup function that stops the loop.
 */
export function startTokenRefreshLoop(
  profiles: ProfileConfig[],
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => void {
  // Run immediately on start, then on the interval
  refreshExpiringTokens(profiles).catch(err => console.error('[sweech] token refresh:', scrubSecrets(err.message || String(err))));

  const timer = setInterval(() => {
    refreshExpiringTokens(profiles).catch(err => console.error('[sweech] token refresh:', scrubSecrets(err.message || String(err))));
  }, intervalMs);

  // Allow the Node process to exit even if the timer is still active
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
