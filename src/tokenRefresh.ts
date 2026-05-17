/**
 * Background token refresh for OAuth profiles.
 * Periodically checks for expiring tokens and refreshes them.
 *
 * T-LU-006: refresh window widened from 10 minutes to 24 hours so
 * Anthropic/OpenAI tokens are rotated well before they expire even when
 * the daemon only wakes every few minutes. Each attempt (success or
 * failure) is recorded in the audit log so operators can confirm the
 * daemon is alive without tailing stderr.
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
 * T-LU-006: refresh OAuth tokens 24h before expiry (was 10 minutes).
 * Wider window survives long sleep/standby periods and gives the daemon
 * multiple polling intervals to recover from transient refresh failures.
 */
export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

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
 * never observe a truncated half-written file. chmod 0600 because the
 * file holds the refresh token + access token after this rewrite.
 */
function writeSettings(settingsPath: string, settings: Record<string, any>): void {
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2));
  try { fs.chmodSync(settingsPath, 0o600); } catch { /* best-effort */ }
}

/**
 * Check whether a token expires within the given window (default 24 hours).
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
  /** True when the token is within the 24h refresh window (or already expired). */
  dueNow: boolean;
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

  const expiresAtMs = profile.oauth.expiresAt;
  if (expiresAtMs == null) {
    return {
      profile: profile.name,
      commandName: profile.commandName,
      expiresAt: null,
      hoursUntil: null,
      dueNow: false,
    };
  }

  const hoursUntil = Math.floor((expiresAtMs - Date.now()) / (60 * 60 * 1000));
  return {
    profile: profile.name,
    commandName: profile.commandName,
    expiresAt: new Date(expiresAtMs).toISOString(),
    hoursUntil,
    dueNow: expiresWithin(expiresAtMs, TWENTY_FOUR_HOURS_MS),
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
    if (!expiresWithin(profile.oauth.expiresAt, TWENTY_FOUR_HOURS_MS)) continue;

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
