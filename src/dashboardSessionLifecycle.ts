import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { SessionsDb, type DashboardSession } from './sessionsDb';
import { SessionSummarizer } from './sessionSummarizer';

export interface RecordDashboardSessionLaunchInput {
  id?: string | null;
  workspace: string;
  cwd?: string | null;
  configDir?: string | null;
  tmuxName?: string | null;
  pid?: number | null;
  terminalApp?: string | null;
  source?: string | null;
  claudeSid?: string | null;
  jsonlPath?: string | null;
  scanJsonl?: boolean;
  jsonlAfterMs?: number | null;
  dbPath?: string | null;
  now?: number;
}

export interface CloseDashboardSessionInput {
  id?: string | null;
  tmuxName?: string | null;
  dbPath?: string | null;
  now?: number;
}

export function createDashboardLaunchId(workspace: string, cwd = process.cwd()): string {
  const safeWorkspace = safeSegment(workspace, 'workspace');
  const safeCwd = safeSegment(path.basename(cwd), 'cwd');
  return `${safeWorkspace}-${safeCwd}-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export function recordDashboardSessionLaunch(input: RecordDashboardSessionLaunchInput): DashboardSession {
  const cwd = input.cwd || process.cwd();
  const latest = input.claudeSid || input.jsonlPath || input.scanJsonl === false
    ? null
    : findLatestClaudeJsonl(input.configDir, cwd, { afterMs: input.jsonlAfterMs ?? undefined });
  const db = new SessionsDb(input.dbPath || undefined);
  try {
    return db.upsert({
      id: input.id || createDashboardLaunchId(input.workspace, cwd),
      workspace: input.workspace,
      cwd,
      machine: os.hostname(),
      tmuxName: emptyToNull(input.tmuxName),
      claudeSid: emptyToNull(input.claudeSid) ?? latest?.sid ?? null,
      jsonlPath: emptyToNull(input.jsonlPath) ?? latest?.jsonlPath ?? null,
      pid: input.pid ?? process.pid,
      terminalApp: emptyToNull(input.terminalApp) ?? emptyToNull(input.source) ?? process.env.TERM_PROGRAM ?? null,
      launchedAt: input.now,
      lastActiveAt: input.now,
      status: 'live',
    });
  } finally {
    db.close();
  }
}

export function closeDashboardSession(input: CloseDashboardSessionInput): DashboardSession | null {
  const db = new SessionsDb(input.dbPath || undefined);
  try {
    if (input.id) {
      const byId = db.updateStatus(input.id, 'closed', input.now);
      if (byId) {
        summarizeClosedSession(byId.id, input.dbPath || undefined);
        return byId;
      }
    }
    if (input.tmuxName) {
      const byTmux = db.updateStatusByTmuxName(input.tmuxName, 'closed', input.now);
      if (byTmux) summarizeClosedSession(byTmux.id, input.dbPath || undefined);
      return byTmux;
    }
    return null;
  } finally {
    db.close();
  }
}

function summarizeClosedSession(sessionId: string, dbPath?: string | null): void {
  const db = new SessionsDb(dbPath || undefined);
  const summarizer = new SessionSummarizer({ db });
  void summarizer.summarizeNow(sessionId, 'session-end')
    .catch(() => undefined)
    .finally(() => summarizer.close());
}

export function findLatestClaudeJsonl(
  configDir: string | null | undefined,
  cwd: string,
  opts: { afterMs?: number } = {},
): { sid: string; jsonlPath: string } | null {
  if (!configDir) return null;
  const projectDir = path.join(configDir, 'projects', encodeCwdProjectDir(cwd));
  let entries: string[];
  try {
    entries = fs.readdirSync(projectDir);
  } catch {
    return null;
  }

  let newest: { sid: string; jsonlPath: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const jsonlPath = path.join(projectDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (opts.afterMs !== undefined && stat.mtimeMs < opts.afterMs) continue;
    const sid = path.basename(entry, '.jsonl');
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { sid, jsonlPath, mtimeMs: stat.mtimeMs };
  }
  return newest ? { sid: newest.sid, jsonlPath: newest.jsonlPath } : null;
}

function encodeCwdProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || fallback;
}
