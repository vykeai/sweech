"use strict";
/**
 * Append-only JSONL audit log for sweech operations.
 *
 * Every mutating action (profile add/remove, token refresh, backup, etc.)
 * is recorded as a single JSON line in ~/.sweech/audit.jsonl.
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
exports.logAudit = logAudit;
exports.readAuditLog = readAuditLog;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// ── Paths ────────────────────────────────────────────────────────────────────
const SWEECH_DIR = path.join(os.homedir(), '.sweech');
const AUDIT_FILE = path.join(SWEECH_DIR, 'audit.jsonl');
// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Append a single audit entry to the log file.
 *
 * The entry is serialised as one JSON line with a trailing newline.
 * If the directory or file doesn't exist yet it will be created.
 */
function logAudit(entry) {
    if (!fs.existsSync(SWEECH_DIR)) {
        fs.mkdirSync(SWEECH_DIR, { recursive: true });
    }
    const record = {
        timestamp: entry.timestamp || new Date().toISOString(),
        action: entry.action,
        ...(entry.account !== undefined && { account: entry.account }),
        ...(entry.details !== undefined && { details: entry.details }),
    };
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(AUDIT_FILE, line, 'utf-8');
}
/**
 * Read audit log entries, optionally filtered by time range, action, or count.
 *
 * Entries are returned in chronological order (oldest first). When `limit` is
 * specified, the *most recent* N entries that match the other filters are
 * returned (still sorted oldest-first).
 */
function readAuditLog(options) {
    if (!fs.existsSync(AUDIT_FILE)) {
        return [];
    }
    const raw = fs.readFileSync(AUDIT_FILE, 'utf-8');
    const lines = raw.split('\n');
    let entries = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const entry = JSON.parse(trimmed);
            entries.push(entry);
        }
        catch {
            // Skip malformed lines — the log is append-only so partial writes
            // at the tail are expected after an unclean shutdown.
        }
    }
    // Apply filters
    if (options?.since) {
        const sinceTime = new Date(options.since).getTime();
        entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
    }
    if (options?.action) {
        entries = entries.filter(e => e.action === options.action);
    }
    // Limit: take the most recent N, but return them in chronological order
    if (options?.limit !== undefined && options.limit > 0 && entries.length > options.limit) {
        entries = entries.slice(-options.limit);
    }
    return entries;
}
