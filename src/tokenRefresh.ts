/**
 * Background token refresh for OAuth profiles.
 * Periodically checks for expiring tokens and refreshes them.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProfileConfig } from './config';
import { refreshOAuthToken, OAuthToken } from './oauth';
import { sweechEvents } from './events';

const TEN_MINUTES_MS = 10 * 60 * 1000;
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
 */
function writeSettings(settingsPath: string, settings: Record<string, any>): void {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Check whether a token expires within the given window (default 10 minutes).
 */
function expiresWithin(expiresAt: number | undefined, windowMs: number): boolean {
  if (expiresAt == null) return false;
  return expiresAt - Date.now() < windowMs;
}

/**
 * Iterate profiles and refresh any OAuth tokens expiring within 10 minutes.
 */
export async function refreshExpiringTokens(profiles: ProfileConfig[]): Promise<void> {
  for (const profile of profiles) {
    if (!profile.oauth) continue;
    if (!profile.oauth.refreshToken) continue;
    if (!expiresWithin(profile.oauth.expiresAt, TEN_MINUTES_MS)) continue;

    try {
      const newToken = await refreshOAuthToken(profile.oauth);

      // Update the on-disk settings.json
      const settingsPath = getSettingsPath(profile);
      const settings = readSettings(settingsPath);

      if (settings) {
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
        } else {
          settings.env.ANTHROPIC_AUTH_TOKEN = `bearer_${newToken.accessToken}`;
        }

        writeSettings(settingsPath, settings);
      }

      // Update the in-memory profile reference
      profile.oauth = newToken;

      sweechEvents.emit('token_refreshed', {
        account: profile.name,
        expiresAt: newToken.expiresAt ? new Date(newToken.expiresAt).toISOString() : '',
      });
    } catch {
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
  refreshExpiringTokens(profiles).catch(() => {});

  const timer = setInterval(() => {
    refreshExpiringTokens(profiles).catch(() => {});
  }, intervalMs);

  // Allow the Node process to exit even if the timer is still active
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
