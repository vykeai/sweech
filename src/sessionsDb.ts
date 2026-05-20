import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

export type DashboardSessionStatus = 'live' | 'tmux-detached' | 'crash-recoverable' | 'closed';

export interface DashboardSession {
  id: string;
  workspace: string;
  cwd: string;
  cwdBasename: string;
  machine: string;
  tmuxName: string | null;
  claudeSid: string | null;
  jsonlPath: string | null;
  pid: number | null;
  terminalApp: string | null;
  launchedAt: number;
  lastActiveAt: number;
  closedAt: number | null;
  status: DashboardSessionStatus;
  messageCount: number;
  msgCountFirst: number;
  msgCountLast: number;
  summaryOne: string | null;
  summaryBullets: string | null;
  summaryProvider: string | null;
  summaryModel: string | null;
  summaryCostUsd: number | null;
  summaryAt: number | null;
  summaryStale: boolean;
  summaryMsgAt: number | null;
}

export interface InsertDashboardSessionInput {
  id: string;
  workspace: string;
  cwd: string;
  cwdBasename?: string;
  machine?: string;
  tmuxName?: string | null;
  claudeSid?: string | null;
  jsonlPath?: string | null;
  pid?: number | null;
  terminalApp?: string | null;
  launchedAt?: number;
  lastActiveAt?: number;
  closedAt?: number | null;
  status?: DashboardSessionStatus;
  messageCount?: number;
  msgCountFirst?: number;
  msgCountLast?: number;
  summaryOne?: string | null;
  summaryBullets?: string[] | string | null;
  summaryProvider?: string | null;
  summaryModel?: string | null;
  summaryCostUsd?: number | null;
  summaryAt?: number | null;
  summaryStale?: boolean;
  summaryMsgAt?: number | null;
}

export interface ListDashboardSessionsFilter {
  machine?: string;
  workspace?: string;
  status?: DashboardSessionStatus | DashboardSessionStatus[];
  q?: string;
  limit?: number;
  offset?: number;
}

export interface BulkWipeDashboardSessionsFilter {
  status?: DashboardSessionStatus | DashboardSessionStatus[];
  closedOnly?: boolean;
  olderThan?: number;
}

export interface StartupReconcileInput {
  livePids?: Iterable<number>;
  attachedTmuxNames?: Iterable<string>;
  existingTmuxNames?: Iterable<string>;
  now?: number;
}

export interface StartupReconcileResult {
  checked: number;
  live: number;
  tmuxDetached: number;
  crashRecoverable: number;
}

interface SessionRow {
  id: string;
  workspace: string;
  cwd: string;
  cwd_basename: string;
  machine: string;
  tmux_name: string | null;
  claude_sid: string | null;
  jsonl_path: string | null;
  pid: number | null;
  terminal_app: string | null;
  launched_at: number;
  last_active_at: number;
  closed_at: number | null;
  status: DashboardSessionStatus;
  message_count: number;
  msg_count_first: number;
  msg_count_last: number;
  summary_one: string | null;
  summary_bullets: string | null;
  summary_provider: string | null;
  summary_model: string | null;
  summary_cost_usd: number | null;
  summary_at: number | null;
  summary_stale: number;
  summary_msg_at: number | null;
}

const STATUS_VALUES = new Set<DashboardSessionStatus>([
  'live',
  'tmux-detached',
  'crash-recoverable',
  'closed',
]);

export function defaultSessionsDbPath(): string {
  return path.join(os.homedir(), '.sweech', 'sessions.db');
}

export class SessionsDb {
  private readonly db: DatabaseSync;

  constructor(dbPath = defaultSessionsDbPath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = OFF');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  sqliteSettings(): { journalMode: string; synchronous: number } {
    const journal = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const synchronous = this.db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    return { journalMode: journal.journal_mode, synchronous: synchronous.synchronous };
  }

  insert(input: InsertDashboardSessionInput): DashboardSession {
    const now = Date.now();
    const session = normalizeInsert(input, now);

    this.db.prepare(`
      INSERT INTO sessions (
        id, workspace, cwd, cwd_basename, machine, tmux_name, claude_sid,
        jsonl_path, pid, terminal_app, launched_at, last_active_at, closed_at,
        status, message_count, msg_count_first, msg_count_last, summary_one,
        summary_bullets, summary_provider, summary_model, summary_cost_usd,
        summary_at, summary_stale, summary_msg_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.workspace,
      session.cwd,
      session.cwdBasename,
      session.machine,
      session.tmuxName,
      session.claudeSid,
      session.jsonlPath,
      session.pid,
      session.terminalApp,
      session.launchedAt,
      session.lastActiveAt,
      session.closedAt,
      session.status,
      session.messageCount,
      session.msgCountFirst,
      session.msgCountLast,
      session.summaryOne,
      session.summaryBullets,
      session.summaryProvider,
      session.summaryModel,
      session.summaryCostUsd,
      session.summaryAt,
      session.summaryStale ? 1 : 0,
      session.summaryMsgAt
    );

    return session;
  }

  upsert(input: InsertDashboardSessionInput): DashboardSession {
    const now = Date.now();
    const session = normalizeInsert(input, now);

    this.db.prepare(`
      INSERT INTO sessions (
        id, workspace, cwd, cwd_basename, machine, tmux_name, claude_sid,
        jsonl_path, pid, terminal_app, launched_at, last_active_at, closed_at,
        status, message_count, msg_count_first, msg_count_last, summary_one,
        summary_bullets, summary_provider, summary_model, summary_cost_usd,
        summary_at, summary_stale, summary_msg_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace = excluded.workspace,
        cwd = excluded.cwd,
        cwd_basename = excluded.cwd_basename,
        machine = excluded.machine,
        tmux_name = excluded.tmux_name,
        claude_sid = COALESCE(excluded.claude_sid, sessions.claude_sid),
        jsonl_path = COALESCE(excluded.jsonl_path, sessions.jsonl_path),
        pid = excluded.pid,
        terminal_app = COALESCE(excluded.terminal_app, sessions.terminal_app),
        last_active_at = excluded.last_active_at,
        closed_at = excluded.closed_at,
        status = excluded.status,
        message_count = MAX(sessions.message_count, excluded.message_count),
        msg_count_first = CASE
          WHEN sessions.msg_count_first = 0 THEN excluded.msg_count_first
          ELSE sessions.msg_count_first
        END,
        msg_count_last = MAX(sessions.msg_count_last, excluded.msg_count_last),
        summary_stale = CASE
          WHEN excluded.message_count > sessions.summary_msg_at OR sessions.summary_msg_at IS NULL THEN 1
          ELSE sessions.summary_stale
        END
    `).run(
      session.id,
      session.workspace,
      session.cwd,
      session.cwdBasename,
      session.machine,
      session.tmuxName,
      session.claudeSid,
      session.jsonlPath,
      session.pid,
      session.terminalApp,
      session.launchedAt,
      session.lastActiveAt,
      session.closedAt,
      session.status,
      session.messageCount,
      session.msgCountFirst,
      session.msgCountLast,
      session.summaryOne,
      session.summaryBullets,
      session.summaryProvider,
      session.summaryModel,
      session.summaryCostUsd,
      session.summaryAt,
      session.summaryStale ? 1 : 0,
      session.summaryMsgAt
    );

    return this.byId(session.id) ?? session;
  }

  updateStatus(id: string, status: DashboardSessionStatus, now = Date.now()): DashboardSession | null {
    assertStatus(status);
    const closedAt = status === 'closed' ? now : null;

    this.db.prepare(`
      UPDATE sessions
      SET status = ?, closed_at = ?, last_active_at = ?
      WHERE id = ?
    `).run(status, closedAt, now, id);

    return this.byId(id);
  }

  markActivity(id: string, input: { at?: number; messageCount?: number }): DashboardSession | null {
    const at = input.at ?? Date.now();
    const current = this.byId(id);
    if (!current) return null;

    const messageCount = input.messageCount ?? current.messageCount;
    const msgCountFirst = current.msgCountFirst || messageCount;

    this.db.prepare(`
      UPDATE sessions
      SET last_active_at = ?,
          message_count = ?,
          msg_count_first = ?,
          msg_count_last = ?,
          summary_stale = CASE WHEN summary_msg_at IS NULL OR summary_msg_at < ? THEN 1 ELSE summary_stale END
      WHERE id = ?
    `).run(at, messageCount, msgCountFirst, messageCount, messageCount, id);

    return this.byId(id);
  }

  list(filter: ListDashboardSessionsFilter = {}): DashboardSession[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.machine) {
      clauses.push('machine = ?');
      params.push(filter.machine);
    }
    if (filter.workspace) {
      clauses.push('workspace = ?');
      params.push(filter.workspace);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      statuses.forEach(assertStatus);
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filter.q) {
      clauses.push('(workspace LIKE ? OR cwd LIKE ? OR cwd_basename LIKE ? OR summary_one LIKE ?)');
      const q = `%${filter.q}%`;
      params.push(q, q, q, q);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampLimit(filter.limit);
    const offset = Math.max(0, Math.floor(filter.offset ?? 0));
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      ${where}
      ORDER BY last_active_at DESC, launched_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SessionRow[];

    return rows.map(rowToSession);
  }

  byId(id: string): DashboardSession | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  byTmuxName(tmuxName: string): DashboardSession | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE tmux_name = ? ORDER BY last_active_at DESC LIMIT 1').get(tmuxName) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  updateStatusByTmuxName(tmuxName: string, status: DashboardSessionStatus, now = Date.now()): DashboardSession | null {
    const row = this.byTmuxName(tmuxName);
    if (!row) return null;
    return this.updateStatus(row.id, status, now);
  }

  bulkWipe(filter: BulkWipeDashboardSessionsFilter = {}): number {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.closedOnly) {
      clauses.push('status = ?');
      params.push('closed');
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      statuses.forEach(assertStatus);
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filter.olderThan !== undefined) {
      clauses.push('last_active_at < ?');
      params.push(filter.olderThan);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = this.db.prepare(`DELETE FROM sessions ${where}`).run(...params);
    return result.changes;
  }

  reconcileOnDaemonStartup(input: StartupReconcileInput = {}): StartupReconcileResult {
    const livePids = new Set(input.livePids ?? []);
    const attachedTmuxNames = new Set(input.attachedTmuxNames ?? []);
    const existingTmuxNames = new Set(input.existingTmuxNames ?? []);
    const rows = this.list({ status: ['live', 'tmux-detached', 'crash-recoverable'], limit: Number.MAX_SAFE_INTEGER });
    const result: StartupReconcileResult = { checked: rows.length, live: 0, tmuxDetached: 0, crashRecoverable: 0 };

    for (const row of rows) {
      let nextStatus: DashboardSessionStatus;
      if (row.pid !== null && livePids.has(row.pid)) {
        nextStatus = 'live';
      } else if (row.tmuxName && attachedTmuxNames.has(row.tmuxName)) {
        nextStatus = 'live';
      } else if (row.tmuxName && existingTmuxNames.has(row.tmuxName)) {
        nextStatus = 'tmux-detached';
      } else {
        nextStatus = 'crash-recoverable';
      }

      this.db.prepare(`
        UPDATE sessions
        SET status = ?, closed_at = NULL
        WHERE id = ?
      `).run(nextStatus, row.id);
      if (nextStatus === 'live') result.live++;
      if (nextStatus === 'tmux-detached') result.tmuxDetached++;
      if (nextStatus === 'crash-recoverable') result.crashRecoverable++;
    }

    return result;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        workspace       TEXT NOT NULL,
        cwd             TEXT NOT NULL,
        cwd_basename    TEXT NOT NULL,
        machine         TEXT NOT NULL,
        tmux_name       TEXT,
        claude_sid      TEXT,
        jsonl_path      TEXT,
        pid             INTEGER,
        terminal_app    TEXT,
        launched_at     INTEGER NOT NULL,
        last_active_at  INTEGER NOT NULL,
        closed_at       INTEGER,
        status          TEXT NOT NULL,
        message_count   INTEGER DEFAULT 0,
        msg_count_first INTEGER DEFAULT 0,
        msg_count_last  INTEGER DEFAULT 0,
        summary_one     TEXT,
        summary_bullets TEXT,
        summary_provider TEXT,
        summary_model   TEXT,
        summary_cost_usd REAL,
        summary_at      INTEGER,
        summary_stale   INTEGER DEFAULT 1,
        summary_msg_at  INTEGER
      );

      CREATE INDEX IF NOT EXISTS ix_sessions_workspace ON sessions(workspace);
      CREATE INDEX IF NOT EXISTS ix_sessions_cwd ON sessions(cwd);
      CREATE INDEX IF NOT EXISTS ix_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS ix_sessions_last_active ON sessions(last_active_at);
      CREATE INDEX IF NOT EXISTS ix_sessions_machine ON sessions(machine);

      CREATE TABLE IF NOT EXISTS peers (
        hostname    TEXT PRIMARY KEY,
        url         TEXT NOT NULL,
        last_seen   INTEGER NOT NULL,
        capabilities TEXT
      );
    `);
  }
}

export function reconcileDashboardSessionsOnDaemonStartup(
  db: SessionsDb,
  input: StartupReconcileInput = {}
): StartupReconcileResult {
  return db.reconcileOnDaemonStartup(input);
}

function normalizeInsert(input: InsertDashboardSessionInput, now: number): DashboardSession {
  if (!input.id) throw new Error('session id is required');
  if (!input.workspace) throw new Error('session workspace is required');
  if (!input.cwd) throw new Error('session cwd is required');
  const status = input.status ?? 'live';
  assertStatus(status);

  const messageCount = input.messageCount ?? 0;
  return {
    id: input.id,
    workspace: input.workspace,
    cwd: input.cwd,
    cwdBasename: input.cwdBasename ?? path.basename(input.cwd),
    machine: input.machine ?? os.hostname(),
    tmuxName: input.tmuxName ?? null,
    claudeSid: input.claudeSid ?? null,
    jsonlPath: input.jsonlPath ?? null,
    pid: input.pid ?? null,
    terminalApp: input.terminalApp ?? null,
    launchedAt: input.launchedAt ?? now,
    lastActiveAt: input.lastActiveAt ?? input.launchedAt ?? now,
    closedAt: input.closedAt ?? null,
    status,
    messageCount,
    msgCountFirst: input.msgCountFirst ?? messageCount,
    msgCountLast: input.msgCountLast ?? messageCount,
    summaryOne: input.summaryOne ?? null,
    summaryBullets: Array.isArray(input.summaryBullets)
      ? JSON.stringify(input.summaryBullets)
      : input.summaryBullets ?? null,
    summaryProvider: input.summaryProvider ?? null,
    summaryModel: input.summaryModel ?? null,
    summaryCostUsd: input.summaryCostUsd ?? null,
    summaryAt: input.summaryAt ?? null,
    summaryStale: input.summaryStale ?? true,
    summaryMsgAt: input.summaryMsgAt ?? null,
  };
}

function rowToSession(row: SessionRow): DashboardSession {
  return {
    id: row.id,
    workspace: row.workspace,
    cwd: row.cwd,
    cwdBasename: row.cwd_basename,
    machine: row.machine,
    tmuxName: row.tmux_name,
    claudeSid: row.claude_sid,
    jsonlPath: row.jsonl_path,
    pid: row.pid,
    terminalApp: row.terminal_app,
    launchedAt: row.launched_at,
    lastActiveAt: row.last_active_at,
    closedAt: row.closed_at,
    status: row.status,
    messageCount: row.message_count,
    msgCountFirst: row.msg_count_first,
    msgCountLast: row.msg_count_last,
    summaryOne: row.summary_one,
    summaryBullets: row.summary_bullets,
    summaryProvider: row.summary_provider,
    summaryModel: row.summary_model,
    summaryCostUsd: row.summary_cost_usd,
    summaryAt: row.summary_at,
    summaryStale: row.summary_stale === 1,
    summaryMsgAt: row.summary_msg_at,
  };
}

function assertStatus(status: string): asserts status is DashboardSessionStatus {
  if (!STATUS_VALUES.has(status as DashboardSessionStatus)) {
    throw new Error(`invalid dashboard session status: ${status}`);
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 500;
  if (!Number.isFinite(limit)) return 500;
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(limit)));
}
