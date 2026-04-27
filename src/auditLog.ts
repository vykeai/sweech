/**
 * Append-only JSONL audit log for sweech operations.
 *
 * Every mutating action (profile add/remove, token refresh, backup, etc.)
 * is recorded as a single JSON line in ~/.sweech/audit.jsonl.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  action: string;
  account?: string;
  details?: Record<string, unknown>;
}

/**
 * Well-known action names. Callers may pass any string, but these are the
 * canonical ones used throughout sweech.
 */
export type AuditAction =
  | 'profile_added'
  | 'profile_removed'
  | 'token_refreshed'
  | 'session_started'
  | 'backup_created'
  | 'config_changed';

export interface ReadAuditOptions {
  /** ISO-8601 timestamp — only return entries at or after this time. */
  since?: string;
  /** Maximum number of entries to return (most recent first). */
  limit?: number;
  /** Filter to a specific action string. */
  action?: string;
}

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
export function logAudit(entry: AuditEntry): void {
  if (!fs.existsSync(SWEECH_DIR)) {
    fs.mkdirSync(SWEECH_DIR, { recursive: true, mode: 0o700 });
  }

  const record: AuditEntry = {
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
export function readAuditLog(options?: ReadAuditOptions): AuditEntry[] {
  if (!fs.existsSync(AUDIT_FILE)) {
    return [];
  }

  const raw = fs.readFileSync(AUDIT_FILE, 'utf-8');
  const lines = raw.split('\n');

  let entries: AuditEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as AuditEntry;
      entries.push(entry);
    } catch {
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
