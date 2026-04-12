"use strict";
/**
 * Live rate limit data from the Claude API.
 *
 * Auth: reads OAuth tokens from macOS Keychain using the same service name
 * pattern as the Claude Code native binary, then calls /v1/messages with
 * anthropic-beta: oauth-2025-04-20 and reads response headers.
 *
 * Results are cached in ~/.sweech/rate-limit-cache.json with a 5-minute TTL
 * to avoid burning message quota on every poll.
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
exports.computeSmartScore = computeSmartScore;
exports.computeTier = computeTier;
exports.getLiveUsage = getLiveUsage;
exports.refreshLiveUsage = refreshLiveUsage;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const platform_1 = require("./platform");
const credentialStore_1 = require("./credentialStore");
/**
 * Smart priority score: higher = use this account first.
 * Uses the "All models" bucket when available. Identical logic for CLI, launcher, and SweechBar.
 */
function computeSmartScore(account) {
    if (account.needsReauth)
        return -2;
    if (account.live?.status === 'limit_reached')
        return -1;
    if (!account.live)
        return 0;
    // Prefer "All models" bucket, fall back to first bucket
    const allModels = account.live.buckets.find(b => b.label === 'All models');
    const bucket = allModels || account.live.buckets[0];
    // If there's no weekly data at all, fall back to session data
    const hasWeekly = bucket?.weekly?.utilization !== undefined || account.live.utilization7d !== undefined;
    if (!hasWeekly) {
        const session = bucket?.session;
        if (session)
            return (1 - session.utilization);
        return 0;
    }
    const remaining7d = 1 - (bucket?.weekly?.utilization ?? account.live.utilization7d ?? 0);
    const reset7dAt = bucket?.weekly?.resetsAt ?? account.live.reset7dAt;
    if (!reset7dAt)
        return remaining7d / 7;
    const hoursLeft = Math.max(0.5, (reset7dAt - Date.now() / 1000) / 3600);
    const daysLeft = hoursLeft / 24;
    const baseScore = remaining7d / daysLeft;
    if (hoursLeft < 72 && remaining7d > 0)
        return 100 + baseScore;
    return baseScore;
}
/**
 * Compute tier label for an account: "use_first", "use_next", or "normal".
 * The "urgent" flag is set when expiring <72h with ≥5% remaining.
 */
function computeTier(account, isTopInGroup) {
    if (!isTopInGroup)
        return { tier: 'normal', urgent: false };
    const score = computeSmartScore(account);
    if (score < 0)
        return { tier: 'normal', urgent: false };
    const allModels = account.live?.buckets.find(b => b.label === 'All models');
    const reset7dAt = allModels?.weekly?.resetsAt ?? account.live?.reset7dAt;
    const remaining7d = 1 - (allModels?.weekly?.utilization ?? account.live?.utilization7d ?? 0);
    const urgent = !!(reset7dAt && ((reset7dAt - Date.now() / 1000) / 3600) < 72 && remaining7d >= 0.05);
    return { tier: 'use_first', urgent };
}
// ── Cache ─────────────────────────────────────────────────────────────────────
const CACHE_FILE = path.join(os.homedir(), '.sweech', 'rate-limit-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
function readCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeCache(store) {
    fs.mkdirSync(path.join(os.homedir(), '.sweech'), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2));
}
function getCached(configDir) {
    const store = readCache();
    const entry = store[configDir];
    if (!entry)
        return null;
    if (Date.now() - entry.capturedAt > CACHE_TTL_MS)
        return null;
    return entry;
}
function getStaleCache(configDir) {
    const store = readCache();
    const entry = store[configDir];
    if (!entry)
        return null;
    return { ...entry, isStale: true };
}
function setCached(configDir, data) {
    const store = readCache();
    store[configDir] = data;
    writeCache(store);
}
// ── Keychain ──────────────────────────────────────────────────────────────────
/**
 * Compute the Keychain service name for a given config dir.
 *
 * Matches the native binary's ZF() function:
 *   - Default profile (no CLAUDE_CONFIG_DIR): "Claude Code-credentials"
 *   - Custom profile: "Claude Code-credentials-{sha256(configDir).slice(0,8)}"
 *
 * The default config dir is ~/.claude; for it the binary doesn't set
 * CLAUDE_CONFIG_DIR, so there's no hash suffix.
 */
function keychainServiceName(configDir) {
    const defaultDir = path.join(os.homedir(), '.claude');
    if (configDir === defaultDir) {
        return 'Claude Code-credentials';
    }
    const hash = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    return `Claude Code-credentials-${hash}`;
}
async function readOAuthToken(configDir) {
    const service = keychainServiceName(configDir);
    const profileName = path.basename(configDir);
    try {
        // Use cross-platform credential store for reading
        const username = process.env.USER || os.userInfo().username;
        let raw = null;
        if ((0, platform_1.isMacOS)()) {
            // macOS: use Keychain directly (existing path — preserves refresh flow)
            try {
                raw = (0, child_process_1.execSync)(`security find-generic-password -a "${username}" -s "${service}" -w 2>/dev/null`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
            }
            catch {
                raw = null;
            }
        }
        else {
            // Linux/Windows: use cross-platform credential store
            raw = await (0, credentialStore_1.readCredential)(service, username);
        }
        if (!raw)
            return { token: null, tokenStatus: 'no_token' };
        const payload = JSON.parse(raw);
        const token = payload.claudeAiOauth;
        if (!token?.accessToken)
            return { token: null, tokenStatus: 'no_token' };
        // Token still valid
        if (!token.expiresAt || token.expiresAt >= Date.now() + 60000) {
            return { token, tokenStatus: 'valid', tokenExpiresAt: token.expiresAt };
        }
        // Token expired — try to refresh silently using the stored refresh token
        if (token.refreshToken) {
            try {
                const params = new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
                    refresh_token: token.refreshToken,
                });
                const res = await fetch('https://platform.claude.com/v1/oauth/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params.toString(),
                    signal: AbortSignal.timeout(8000),
                });
                if (!res.ok)
                    throw new Error('refresh failed');
                const data = await res.json();
                const updatedPayload = {
                    ...payload,
                    claudeAiOauth: {
                        ...payload.claudeAiOauth,
                        accessToken: data.access_token,
                        refreshToken: data.refresh_token ?? token.refreshToken,
                        expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
                    },
                };
                // Write updated token back using platform-appropriate method
                if ((0, platform_1.isMacOS)()) {
                    (0, child_process_1.execFileSync)('security', [
                        'add-generic-password', '-U',
                        '-a', username,
                        '-s', service,
                        '-w', JSON.stringify(updatedPayload),
                    ], { stdio: 'ignore' });
                }
                else {
                    const { getCredentialStore } = require('./credentialStore');
                    const store = getCredentialStore();
                    await store.set(service, username, JSON.stringify(updatedPayload));
                }
                const refreshed = updatedPayload.claudeAiOauth;
                return {
                    token: refreshed,
                    tokenStatus: 'refreshed',
                    tokenRefreshedAt: Date.now(),
                    tokenExpiresAt: refreshed.expiresAt,
                };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[sweech] token refresh failed for ${profileName}:`, msg);
                return { token: null, tokenStatus: 'expired' };
            }
        }
        return { token: null, tokenStatus: 'expired' }; // expired with no refresh token
    }
    catch {
        return { token: null, tokenStatus: 'no_token' };
    }
}
// ── API call ──────────────────────────────────────────────────────────────────
async function fetchRateLimitHeaders(accessToken) {
    try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'oauth-2025-04-20',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'quota' }],
            }),
            signal: AbortSignal.timeout(8000),
        });
        const get = (k) => res.headers.get(k);
        const num = (k) => { const v = get(k); return v !== null ? Number(v) : undefined; };
        const u5h = num('anthropic-ratelimit-unified-5h-utilization');
        const u7d = num('anthropic-ratelimit-unified-7d-utilization');
        const uSonnet7d = num('anthropic-ratelimit-sonnet-7d-utilization');
        const r5h = num('anthropic-ratelimit-unified-5h-reset');
        const r7d = num('anthropic-ratelimit-unified-7d-reset');
        const buckets = [
            {
                label: 'All models',
                session: u5h !== undefined ? { utilization: u5h, resetsAt: r5h } : undefined,
                weekly: u7d !== undefined ? { utilization: u7d, resetsAt: r7d } : undefined,
            },
        ];
        if (uSonnet7d !== undefined) {
            buckets.push({
                label: 'Sonnet only',
                weekly: { utilization: uSonnet7d, resetsAt: r7d },
            });
        }
        // Detect promotions from fallback/overage headers
        const fallback = get('anthropic-ratelimit-unified-fallback');
        const fallbackPct = num('anthropic-ratelimit-unified-fallback-percentage');
        const overageStatus = get('anthropic-ratelimit-unified-overage-status');
        let promotion;
        // If fallback percentage > 0, that's bonus capacity (the "available" header may or may not be present)
        if (fallbackPct && fallbackPct > 0) {
            const multiplier = 1 + fallbackPct; // 0.5 fallback = 1.5x, 1.0 fallback = 2x
            const label = multiplier >= 2 ? `${multiplier}x Tokens` : `+${Math.round(fallbackPct * 100)}% Bonus`;
            promotion = { label, multiplier, source: 'provider' };
        }
        if (overageStatus === 'allowed') {
            promotion = promotion || { label: 'Overage Active', multiplier: undefined, source: 'provider' };
        }
        return {
            buckets,
            status: get('anthropic-ratelimit-unified-status') ?? undefined,
            capturedAt: Date.now(),
            promotion,
            // Legacy
            utilization5h: u5h, utilization7d: u7d, utilizationSonnet7d: uSonnet7d,
            reset5hAt: r5h, reset7dAt: r7d,
            representativeClaim: get('anthropic-ratelimit-unified-representative-claim') ?? undefined,
        };
    }
    catch {
        return null;
    }
}
// ── Codex app-server rate limits ──────────────────────────────────────────────
async function fetchCodexRateLimits(configDir) {
    const { spawn } = require('child_process');
    return new Promise((resolve) => {
        const timeout = setTimeout(() => { proc.kill(); resolve(null); }, 10000);
        const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
            stdio: ['pipe', 'pipe', 'ignore'],
            env: { ...process.env, CODEX_HOME: configDir },
        });
        let buffer = '';
        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === 1) {
                        // Init response — now request rate limits
                        const req = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
                        proc.stdin.write(req + '\n');
                    }
                    else if (msg.id === 2) {
                        clearTimeout(timeout);
                        proc.kill();
                        const byId = msg.result?.rateLimitsByLimitId || {};
                        if (!Object.keys(byId).length) {
                            resolve(null);
                            return;
                        }
                        // Build one bucket per limit ID, each with 5h + 7d
                        const buckets = [];
                        let mainStatus = 'allowed';
                        let mainPlanType;
                        // Legacy fields from the first (main) bucket
                        let u5h, u7d, r5h, r7d;
                        for (const [id, limit] of Object.entries(byId)) {
                            const label = limit.limitName || 'All models';
                            const bucket = { label };
                            if (limit.primary) {
                                bucket.session = { utilization: limit.primary.usedPercent / 100, resetsAt: limit.primary.resetsAt };
                            }
                            if (limit.secondary) {
                                bucket.weekly = { utilization: limit.secondary.usedPercent / 100, resetsAt: limit.secondary.resetsAt };
                                if (limit.secondary.usedPercent >= 100)
                                    mainStatus = 'limit_reached';
                            }
                            if (limit.planType)
                                mainPlanType = limit.planType;
                            buckets.push(bucket);
                            // Legacy: use main (unnamed) limit for top-level fields
                            if (!limit.limitName) {
                                u5h = bucket.session?.utilization;
                                u7d = bucket.weekly?.utilization;
                                r5h = limit.primary?.resetsAt;
                                r7d = limit.secondary?.resetsAt;
                            }
                        }
                        // Detect codex promotions from credits or unlimited fields
                        let codexPromo;
                        for (const [, limit] of Object.entries(byId)) {
                            if (limit.credits?.unlimited) {
                                codexPromo = { label: 'Unlimited', multiplier: undefined, source: 'provider' };
                            }
                            else if (limit.credits?.hasCredits && Number(limit.credits.balance) > 0) {
                                codexPromo = { label: `+${limit.credits.balance} Credits`, multiplier: undefined, source: 'provider' };
                            }
                        }
                        resolve({
                            buckets,
                            status: mainStatus,
                            planType: mainPlanType,
                            capturedAt: Date.now(),
                            promotion: codexPromo,
                            utilization5h: u5h, utilization7d: u7d,
                            reset5hAt: r5h, reset7dAt: r7d,
                        });
                    }
                }
                catch { }
            }
        });
        proc.on('error', () => { clearTimeout(timeout); resolve(null); });
        // Send initialize
        const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'sweech', version: '0.1' } } });
        proc.stdin.write(init + '\n');
    });
}
const PROMOTIONS_FILE = path.join(os.homedir(), '.sweech', 'promotions.json');
function loadPromotions() {
    try {
        const data = JSON.parse(fs.readFileSync(PROMOTIONS_FILE, 'utf-8'));
        return Array.isArray(data) ? data : [];
    }
    catch {
        return [];
    }
}
function getActivePromotion(cliType) {
    const promos = loadPromotions();
    const now = Date.now();
    for (const p of promos) {
        if (p.cliType !== '*' && p.cliType !== cliType)
            continue;
        if (p.expiresAt && new Date(p.expiresAt).getTime() < now)
            continue;
        return {
            label: p.label,
            multiplier: p.multiplier,
            expiresAt: p.expiresAt ? new Date(p.expiresAt).getTime() : undefined,
            source: 'manual',
        };
    }
    return undefined;
}
function inferPromotion(data, cliType) {
    if (cliType !== 'codex')
        return undefined;
    const planType = data.planType?.toLowerCase();
    if (!planType)
        return undefined;
    // Verified April 10, 2026 from OpenAI Help:
    // Plus, Pro, Business, Enterprise, and Edu currently receive 2x Codex rate limits.
    const eligiblePlans = new Set(['plus', 'pro', 'business', 'enterprise', 'edu', 'education']);
    if (!eligiblePlans.has(planType))
        return undefined;
    return {
        label: '2x Limits',
        multiplier: 2,
        source: 'inferred',
    };
}
function applyPromotion(data, cliType) {
    // Manual config overrides API-detected; API-detected is the fallback
    const manual = getActivePromotion(cliType);
    if (manual) {
        data.promotion = manual;
        return data;
    }
    // data.promotion may already be set from provider responses
    if (!data.promotion) {
        data.promotion = inferPromotion(data, cliType);
    }
    return data;
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Get live rate limit data for a profile. Returns cached data if fresh,
 * otherwise fetches from the API (requires Keychain access on macOS).
 *
 * Returns null if no valid token is available or on any error.
 */
async function getLiveUsage(configDir, cliType) {
    const cached = getCached(configDir);
    if (cached)
        return applyPromotion(cached, cliType || 'claude');
    // Codex: use app-server JSON-RPC
    if (cliType === 'codex') {
        const data = await fetchCodexRateLimits(configDir);
        if (data) {
            setCached(configDir, data);
            return applyPromotion(data, 'codex');
        }
        const stale = getStaleCache(configDir);
        return stale ? applyPromotion(stale, 'codex') : null;
    }
    // Claude: use OAuth token + Anthropic API headers
    const result = await readOAuthToken(configDir);
    if (!result.token) {
        const stale = getStaleCache(configDir);
        if (stale) {
            stale.tokenStatus = result.tokenStatus;
            return applyPromotion(stale, 'claude');
        }
        return { buckets: [], capturedAt: Date.now(), tokenStatus: result.tokenStatus };
    }
    const data = await fetchRateLimitHeaders(result.token.accessToken);
    if (data) {
        data.tokenStatus = result.tokenStatus;
        data.tokenRefreshedAt = result.tokenRefreshedAt;
        data.tokenExpiresAt = result.tokenExpiresAt;
        setCached(configDir, data);
        return applyPromotion(data, 'claude');
    }
    const stale = getStaleCache(configDir);
    return stale ? applyPromotion(stale, 'claude') : null;
}
/**
 * Force-refresh live rate limit data, bypassing the cache.
 */
async function refreshLiveUsage(configDir, cliType) {
    if (cliType === 'codex') {
        const data = await fetchCodexRateLimits(configDir);
        if (data) {
            setCached(configDir, data);
            return data;
        }
        return getStaleCache(configDir);
    }
    const result = await readOAuthToken(configDir);
    if (!result.token) {
        const stale = getStaleCache(configDir);
        if (stale) {
            stale.tokenStatus = result.tokenStatus;
            return stale;
        }
        return { buckets: [], capturedAt: Date.now(), tokenStatus: result.tokenStatus };
    }
    const data = await fetchRateLimitHeaders(result.token.accessToken);
    if (data) {
        data.tokenStatus = result.tokenStatus;
        data.tokenRefreshedAt = result.tokenRefreshedAt;
        data.tokenExpiresAt = result.tokenExpiresAt;
        setCached(configDir, data);
        return data;
    }
    return getStaleCache(configDir);
}
