"use strict";
/**
 * Auto-update checker — fetches latest version from npm registry,
 * caches the result for 24 hours, and compares against the current version.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isNewerVersion = isNewerVersion;
exports.readCache = readCache;
exports.writeCache = writeCache;
exports.fetchLatestVersion = fetchLatestVersion;
exports.fetchChangelog = fetchChangelog;
exports.checkForUpdate = checkForUpdate;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const https = __importStar(require("https"));
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = path.join(os.homedir(), '.sweech');
const CACHE_FILE = path.join(CACHE_DIR, 'update-check.json');
/**
 * Compare two semver strings: returns true if latest > current.
 */
function isNewerVersion(current, latest) {
    const parseSemver = (v) => {
        const cleaned = v.replace(/^v/, '');
        const parts = cleaned.split('.').map(Number);
        return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
    };
    const c = parseSemver(current);
    const l = parseSemver(latest);
    if (l.major !== c.major)
        return l.major > c.major;
    if (l.minor !== c.minor)
        return l.minor > c.minor;
    return l.patch > c.patch;
}
/**
 * Read the cached update check result. Returns null if cache is missing or stale.
 */
function readCache(now) {
    try {
        const data = fs.readFileSync(CACHE_FILE, 'utf-8');
        const cache = JSON.parse(data);
        const currentTime = now ?? Date.now();
        if (currentTime - cache.timestamp < CACHE_TTL_MS) {
            return cache;
        }
        return null; // stale
    }
    catch {
        return null;
    }
}
/**
 * Write the update check result to cache.
 */
function writeCache(latest, now) {
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        const cache = { timestamp: now ?? Date.now(), latest };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    }
    catch {
        // Silently fail — cache write is best-effort
    }
}
/**
 * Fetch the latest version from the npm registry.
 * Returns the version string or null on failure.
 */
function fetchLatestVersion(timeoutMs = 3000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            resolve(null);
        }, timeoutMs);
        const req = https.get('https://registry.npmjs.org/sweech/latest', {
            headers: { 'Accept': 'application/json' },
            timeout: timeoutMs,
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk.toString(); });
            res.on('end', () => {
                clearTimeout(timer);
                try {
                    const data = JSON.parse(body);
                    resolve(data.version || null);
                }
                catch {
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
function fetchChangelog(currentVersion, latestVersion, timeoutMs = 5000) {
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
            res.on('data', (chunk) => { body += chunk.toString(); });
            res.on('end', () => {
                clearTimeout(timer);
                try {
                    const releases = JSON.parse(body);
                    if (!Array.isArray(releases)) {
                        resolve(null);
                        return;
                    }
                    // Filter releases newer than current version
                    const newer = releases.filter((r) => {
                        const tag = (r.tag_name || '').replace(/^v/, '');
                        return isNewerVersion(currentVersion, tag);
                    });
                    if (newer.length === 0) {
                        resolve(null);
                        return;
                    }
                    const notes = newer.map((r) => {
                        const tag = r.tag_name || 'unknown';
                        const title = r.name || tag;
                        const body = r.body || '(no release notes)';
                        return `## ${title}\n${body}`;
                    }).join('\n\n');
                    resolve(notes);
                }
                catch {
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
async function checkForUpdate(currentVersion, now) {
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
    if (!latest)
        return null;
    // Write cache
    writeCache(latest, now);
    return {
        current: currentVersion,
        latest,
        updateAvailable: isNewerVersion(currentVersion, latest),
    };
}
