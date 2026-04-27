/**
 * Auto-update checker — fetches latest version from npm registry,
 * caches the result for 24 hours, and compares against the current version.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

interface UpdateCheckCache {
  timestamp: number;
  latest: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = path.join(os.homedir(), '.sweech');
const CACHE_FILE = path.join(CACHE_DIR, 'update-check.json');

/**
 * Compare two semver strings: returns true if latest > current.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parseSemver = (v: string) => {
    const cleaned = v.replace(/^v/, '');
    const parts = cleaned.split('.').map(Number);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  };
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  return l.patch > c.patch;
}

/**
 * Read the cached update check result. Returns null if cache is missing or stale.
 */
export function readCache(now?: number): UpdateCheckCache | null {
  try {
    const data = fs.readFileSync(CACHE_FILE, 'utf-8');
    const cache: UpdateCheckCache = JSON.parse(data);
    const currentTime = now ?? Date.now();
    if (currentTime - cache.timestamp < CACHE_TTL_MS) {
      return cache;
    }
    return null; // stale
  } catch {
    return null;
  }
}

/**
 * Write the update check result to cache.
 */
export function writeCache(latest: string, now?: number): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    }
    const cache: UpdateCheckCache = { timestamp: now ?? Date.now(), latest };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // Silently fail — cache write is best-effort
  }
}

/**
 * Fetch the latest version from the npm registry.
 * Returns the version string or null on failure.
 */
export function fetchLatestVersion(timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);

    const req = https.get('https://registry.npmjs.org/sweech/latest', {
      headers: { 'Accept': 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const data = JSON.parse(body);
          resolve(data.version || null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Fetch release notes / changelog from GitHub for a given version range.
 * Returns a string of what's new, or null on failure.
 */
export function fetchChangelog(currentVersion: string, latestVersion: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);

    const options = {
      hostname: 'api.github.com',
      path: '/repos/vykeai/sweech/releases?per_page=10',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'sweech-cli',
      },
      timeout: timeoutMs,
    };

    const req = https.get(options, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const releases = JSON.parse(body);
          if (!Array.isArray(releases)) {
            resolve(null);
            return;
          }
          // Filter releases newer than current version
          const newer = releases.filter((r: { tag_name?: string }) => {
            const tag = (r.tag_name || '').replace(/^v/, '');
            return isNewerVersion(currentVersion, tag);
          });
          if (newer.length === 0) {
            resolve(null);
            return;
          }
          const notes = newer.map((r: { tag_name?: string; name?: string; body?: string }) => {
            const tag = r.tag_name || 'unknown';
            const title = r.name || tag;
            const body = r.body || '(no release notes)';
            return `## ${title}\n${body}`;
          }).join('\n\n');
          resolve(notes);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Check for updates. Uses cache when available (24h TTL).
 * Returns the check result, or null on network/parse failure.
 */
export async function checkForUpdate(currentVersion: string, now?: number): Promise<UpdateCheckResult | null> {
  // Check cache first
  const cached = readCache(now);
  if (cached) {
    return {
      current: currentVersion,
      latest: cached.latest,
      updateAvailable: isNewerVersion(currentVersion, cached.latest),
    };
  }

  // Fetch from npm registry
  const latest = await fetchLatestVersion();
  if (!latest) return null;

  // Write cache
  writeCache(latest, now);

  return {
    current: currentVersion,
    latest,
    updateAvailable: isNewerVersion(currentVersion, latest),
  };
}
