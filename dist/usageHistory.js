"use strict";
/**
 * Usage history — hourly utilization snapshots for sparkline rendering.
 *
 * Stores snapshots in ~/.sweech/history.json with a max-once-per-hour dedup
 * and auto-prunes entries older than 7 days.
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
exports._historyFilePath = void 0;
exports._setHistoryFilePath = _setHistoryFilePath;
exports._resetHistoryFilePath = _resetHistoryFilePath;
exports.pruneOldEntries = pruneOldEntries;
exports.appendSnapshot = appendSnapshot;
exports.getHistory = getHistory;
exports.accountSparkline = accountSparkline;
exports.allAccountSparklines = allAccountSparklines;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const charts_1 = require("./charts");
// ── Constants ─────────────────────────────────────────────────────────────────
const HISTORY_FILE = path.join(os.homedir(), '.sweech', 'history.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 168; // 7 days * 24 hours
// ── Internal helpers ──────────────────────────────────────────────────────────
/** Exposed for testing: override the history file path. */
exports._historyFilePath = HISTORY_FILE;
function _setHistoryFilePath(p) {
    exports._historyFilePath = p;
}
function _resetHistoryFilePath() {
    exports._historyFilePath = HISTORY_FILE;
}
function readHistoryFile() {
    try {
        const raw = fs.readFileSync(exports._historyFilePath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data))
            return data;
        return [];
    }
    catch {
        return [];
    }
}
function writeHistoryFile(entries) {
    const dir = path.dirname(exports._historyFilePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(exports._historyFilePath, JSON.stringify(entries, null, 2));
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Prune history entries older than 7 days from the given array.
 * Returns the pruned array (does NOT write to disk).
 */
function pruneOldEntries(entries, now) {
    const cutoff = (now ?? Date.now()) - MAX_AGE_MS;
    return entries.filter(e => e.timestamp >= cutoff);
}
/**
 * Append a utilization snapshot from the given account data.
 *
 * Deduplicates: skips if the last entry was recorded less than 1 hour ago.
 * Auto-prunes entries older than 7 days.
 */
function appendSnapshot(accounts, now) {
    const ts = now ?? Date.now();
    let entries = readHistoryFile();
    // Dedup: skip if last entry is less than MIN_INTERVAL_MS ago
    if (entries.length > 0) {
        const last = entries[entries.length - 1];
        if (ts - last.timestamp < MIN_INTERVAL_MS)
            return;
    }
    // Build accounts map from live data
    const accountsMap = {};
    for (const a of accounts) {
        const u5h = a.live?.utilization5h ?? a.live?.buckets?.[0]?.session?.utilization;
        const u7d = a.live?.utilization7d ?? a.live?.buckets?.[0]?.weekly?.utilization;
        if (u5h !== undefined || u7d !== undefined) {
            accountsMap[a.commandName] = {
                u5h: u5h ?? 0,
                u7d: u7d ?? 0,
            };
        }
    }
    // Only append if there's meaningful data
    if (Object.keys(accountsMap).length === 0)
        return;
    entries.push({ timestamp: ts, accounts: accountsMap });
    // Prune old + enforce max
    entries = pruneOldEntries(entries, ts);
    if (entries.length > MAX_ENTRIES) {
        entries = entries.slice(entries.length - MAX_ENTRIES);
    }
    writeHistoryFile(entries);
}
/**
 * Get history entries for the last N hours (default 24).
 */
function getHistory(hours = 24) {
    const entries = readHistoryFile();
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return entries.filter(e => e.timestamp >= cutoff);
}
/**
 * Build a sparkline string for a given account over the last N hours.
 * Uses the 7d utilization values by default.
 *
 * @param accountName - The commandName of the account
 * @param hours - Number of hours of history to show (default 24)
 * @param field - Which utilization field to chart: 'u5h' or 'u7d' (default 'u7d')
 * @returns The sparkline string, or empty string if no data
 */
function accountSparkline(accountName, hours = 24, field = 'u7d') {
    const entries = getHistory(hours);
    const values = entries
        .map(e => e.accounts[accountName]?.[field])
        .filter((v) => v !== undefined);
    return (0, charts_1.sparkline)(values);
}
/**
 * Get sparkline data for all accounts found in the history.
 * Returns a map of commandName -> sparkline string.
 */
function allAccountSparklines(hours = 24, field = 'u7d') {
    const entries = getHistory(hours);
    const accountNames = new Set();
    for (const e of entries) {
        for (const name of Object.keys(e.accounts)) {
            accountNames.add(name);
        }
    }
    const result = new Map();
    for (const name of accountNames) {
        const values = entries
            .map(e => e.accounts[name]?.[field])
            .filter((v) => v !== undefined);
        if (values.length > 0) {
            result.set(name, (0, charts_1.sparkline)(values));
        }
    }
    return result;
}
