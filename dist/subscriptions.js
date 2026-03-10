"use strict";
/**
 * Claude Code subscription tracker.
 *
 * Data sources (all local, no API calls):
 *   ~/.claude-{name}/history.jsonl   — per-message timestamps for 5h/7d windows
 *   ~/.claude-{name}/.claude.json    — account metadata, subscriptionCreatedAt
 *   ~/.sweech/subscriptions.json     — user-configured plan labels
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
exports.setMeta = setMeta;
exports.getConfigDir = getConfigDir;
exports.getAccountInfo = getAccountInfo;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// ── Storage ───────────────────────────────────────────────────────────────────
const SUBSCRIPTIONS_FILE = path.join(os.homedir(), '.sweech', 'subscriptions.json');
function readMeta() {
    try {
        return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeMeta(data) {
    fs.mkdirSync(path.join(os.homedir(), '.sweech'), { recursive: true });
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(data, null, 2));
}
function setMeta(commandName, config) {
    const meta = readMeta();
    meta[commandName] = { ...(meta[commandName] ?? {}), ...config };
    writeMeta(meta);
}
// ── Config dir resolution ─────────────────────────────────────────────────────
function getConfigDir(commandName) {
    // commandName is the full dir suffix: 'claude' → ~/.claude, 'claude-pole' → ~/.claude-pole
    return path.join(os.homedir(), `.${commandName}`);
}
function readClaudeJson(configDir) {
    const file = path.join(configDir, '.claude.json');
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    catch {
        return {};
    }
}
function readHistory(configDir) {
    const file = path.join(configDir, 'history.jsonl');
    if (!fs.existsSync(file))
        return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const entries = [];
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        try {
            entries.push(JSON.parse(line));
        }
        catch { /* skip */ }
    }
    return entries;
}
// ── Window calculations ───────────────────────────────────────────────────────
function computeWindows(entries) {
    const now = Date.now();
    const cutoff5h = now - 5 * 60 * 60 * 1000;
    const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
    let messages5h = 0;
    let messages7d = 0;
    let lastTs = null;
    let oldest5hTs = null;
    for (const e of entries) {
        if (!e.timestamp)
            continue;
        if (e.timestamp > (lastTs ?? 0))
            lastTs = e.timestamp;
        if (e.timestamp >= cutoff7d)
            messages7d++;
        if (e.timestamp >= cutoff5h) {
            messages5h++;
            if (!oldest5hTs || e.timestamp < oldest5hTs)
                oldest5hTs = e.timestamp;
        }
    }
    const minutesUntilFirstCapacity = oldest5hTs
        ? Math.max(0, Math.round(((oldest5hTs + 5 * 60 * 60 * 1000) - now) / 60000))
        : undefined;
    return {
        messages5h,
        messages7d,
        totalMessages: entries.length,
        oldest5hMessageAt: oldest5hTs ? new Date(oldest5hTs).toISOString() : undefined,
        lastActive: lastTs ? new Date(lastTs).toISOString() : undefined,
        minutesUntilFirstCapacity,
    };
}
/**
 * Compute the next weekly reset based on the subscription's creation weekday + time-of-day.
 * e.g. if sub was created on a Tuesday at 17:42 UTC, it resets every Tuesday at 17:42.
 */
function computeWeeklyReset(subscriptionCreatedAt) {
    const created = new Date(subscriptionCreatedAt);
    const now = new Date();
    // Anchor: day-of-week + time-of-day from creation
    const anchorDow = created.getUTCDay(); // 0=Sun..6=Sat
    const anchorMs = (created.getUTCHours() * 3600 +
        created.getUTCMinutes() * 60 +
        created.getUTCSeconds()) * 1000;
    // Find next occurrence of that weekday+time after now
    const nowMs = now.getTime();
    const nowDow = now.getUTCDay();
    const nowDayMs = (now.getUTCHours() * 3600 +
        now.getUTCMinutes() * 60 +
        now.getUTCSeconds()) * 1000;
    let daysAhead = (anchorDow - nowDow + 7) % 7;
    if (daysAhead === 0 && nowDayMs >= anchorMs)
        daysAhead = 7; // same weekday but already past time
    const resetMs = nowMs + daysAhead * 86400000 + (anchorMs - nowDayMs);
    const reset = new Date(resetMs);
    const hoursUntilWeeklyReset = Math.round((resetMs - nowMs) / 3600000);
    return {
        weeklyResetAt: reset.toISOString(),
        hoursUntilWeeklyReset,
    };
}
// ── Main export ───────────────────────────────────────────────────────────────
function getAccountInfo(profiles) {
    const allMeta = readMeta();
    return profiles.map(p => {
        const configDir = getConfigDir(p.commandName);
        const meta = allMeta[p.commandName] ?? {};
        const claude = readClaudeJson(configDir);
        const history = readHistory(configDir);
        const windows = computeWindows(history);
        const sub = claude.oauthAccount;
        const weeklyReset = sub?.subscriptionCreatedAt
            ? computeWeeklyReset(sub.subscriptionCreatedAt)
            : undefined;
        return {
            name: p.name,
            commandName: p.commandName,
            configDir,
            displayName: sub?.displayName,
            emailAddress: sub?.emailAddress,
            billingType: sub?.billingType,
            subscriptionCreatedAt: sub?.subscriptionCreatedAt,
            meta,
            ...windows,
            ...(weeklyReset ?? {}),
        };
    });
}
