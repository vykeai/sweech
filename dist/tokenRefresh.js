"use strict";
/**
 * Background token refresh for OAuth profiles.
 * Periodically checks for expiring tokens and refreshes them.
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
exports.refreshExpiringTokens = refreshExpiringTokens;
exports.startTokenRefreshLoop = startTokenRefreshLoop;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const oauth_1 = require("./oauth");
const events_1 = require("./events");
const TEN_MINUTES_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Resolve the settings.json path for a given profile.
 */
function getSettingsPath(profile) {
    const profileDir = path.join(os.homedir(), `.${profile.commandName}`);
    return path.join(profileDir, 'settings.json');
}
/**
 * Read and parse the settings.json for a profile.
 * Returns null if the file does not exist or cannot be parsed.
 */
function readSettings(settingsPath) {
    try {
        if (!fs.existsSync(settingsPath))
            return null;
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Write settings back to the profile's settings.json.
 */
function writeSettings(settingsPath, settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
/**
 * Check whether a token expires within the given window (default 10 minutes).
 */
function expiresWithin(expiresAt, windowMs) {
    if (expiresAt == null)
        return false;
    return expiresAt - Date.now() < windowMs;
}
/**
 * Iterate profiles and refresh any OAuth tokens expiring within 10 minutes.
 */
async function refreshExpiringTokens(profiles) {
    for (const profile of profiles) {
        if (!profile.oauth)
            continue;
        if (!profile.oauth.refreshToken)
            continue;
        if (!expiresWithin(profile.oauth.expiresAt, TEN_MINUTES_MS))
            continue;
        try {
            const newToken = await (0, oauth_1.refreshOAuthToken)(profile.oauth);
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
                if (!settings.env)
                    settings.env = {};
                if (profile.cliType === 'codex') {
                    settings.env.OPENAI_API_KEY = `sk-oauth-${newToken.accessToken}`;
                }
                else {
                    settings.env.ANTHROPIC_AUTH_TOKEN = `bearer_${newToken.accessToken}`;
                }
                writeSettings(settingsPath, settings);
            }
            // Update the in-memory profile reference
            profile.oauth = newToken;
            events_1.sweechEvents.emit('token_refreshed', {
                account: profile.name,
                expiresAt: newToken.expiresAt ? new Date(newToken.expiresAt).toISOString() : '',
            });
        }
        catch (err) {
            console.error(`[sweech] token refresh failed for ${profile.name}:`, err?.message ?? err);
            events_1.sweechEvents.emit('token_expired', {
                account: profile.name,
            });
        }
    }
}
/**
 * Start a background loop that refreshes expiring tokens on a fixed interval.
 * Returns a cleanup function that stops the loop.
 */
function startTokenRefreshLoop(profiles, intervalMs = DEFAULT_INTERVAL_MS) {
    // Run immediately on start, then on the interval
    refreshExpiringTokens(profiles).catch(() => { });
    const timer = setInterval(() => {
        refreshExpiringTokens(profiles).catch(() => { });
    }, intervalMs);
    // Allow the Node process to exit even if the timer is still active
    timer.unref();
    return () => {
        clearInterval(timer);
    };
}
