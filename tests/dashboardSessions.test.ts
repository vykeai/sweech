import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  defaultSessionsDbPath,
  InsertDashboardSessionInput,
  reconcileDashboardSessionsOnDaemonStartup,
  SessionsDb,
} from '../src/sessionsDb';

describe('SessionsDb', () => {
  let tmp: string;
  let dbPath: string;
  let db: SessionsDb;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-dashboard-sessions-'));
    dbPath = path.join(tmp, '.sweech', 'sessions.db');
    db = new SessionsDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function insert(id: string, overrides: Omit<Partial<InsertDashboardSessionInput>, 'id'> = {}) {
    return db.insert({
      id,
      workspace: 'claude-work',
      cwd: path.join(tmp, 'project-a'),
      machine: 'macbook',
      launchedAt: 1000,
      lastActiveAt: 1000,
      ...overrides,
    });
  }

  test('creates sessions.db under a .sweech directory', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  test('default path points at ~/.sweech/sessions.db', () => {
    expect(defaultSessionsDbPath()).toBe(path.join(os.homedir(), '.sweech', 'sessions.db'));
  });

  test('enables WAL journal mode', () => {
    const check = new DatabaseSync(dbPath);
    const row = check.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    check.close();
    expect(row.journal_mode).toBe('wal');
  });

  test('sets synchronous OFF', () => {
    expect(db.sqliteSettings().synchronous).toBe(0);
  });

  test('creates sessions columns from dashboard spec', () => {
    const check = new DatabaseSync(dbPath);
    const rows = check.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    check.close();
    expect(rows.map(row => row.name)).toEqual([
      'id',
      'workspace',
      'cwd',
      'cwd_basename',
      'machine',
      'tmux_name',
      'claude_sid',
      'jsonl_path',
      'pid',
      'terminal_app',
      'launched_at',
      'last_active_at',
      'closed_at',
      'status',
      'message_count',
      'msg_count_first',
      'msg_count_last',
      'summary_one',
      'summary_bullets',
      'summary_provider',
      'summary_model',
      'summary_cost_usd',
      'summary_at',
      'summary_stale',
      'summary_msg_at',
    ]);
  });

  test('creates spec indexes', () => {
    const check = new DatabaseSync(dbPath);
    const rows = check.prepare('PRAGMA index_list(sessions)').all() as Array<{ name: string }>;
    check.close();
    expect(rows.map(row => row.name).sort()).toEqual(expect.arrayContaining([
      'ix_sessions_cwd',
      'ix_sessions_last_active',
      'ix_sessions_machine',
      'ix_sessions_status',
      'ix_sessions_workspace',
    ]));
  });

  test('creates peers table', () => {
    const check = new DatabaseSync(dbPath);
    const row = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peers'").get();
    check.close();
    expect(row).toEqual({ name: 'peers' });
  });

  test('inserts required session fields and defaults', () => {
    const row = insert('s1');
    expect(row).toMatchObject({
      id: 's1',
      workspace: 'claude-work',
      cwdBasename: 'project-a',
      machine: 'macbook',
      status: 'live',
      messageCount: 0,
      summaryStale: true,
    });
    expect(db.byId('s1')).toEqual(row);
  });

  test('inserts nullable tmux and claude metadata', () => {
    insert('s1', {
      tmuxName: 'project-a-claude-work-sweech',
      claudeSid: 'claude-uuid',
      jsonlPath: '/Users/me/.claude/projects/a/claude-uuid.jsonl',
      pid: 123,
      terminalApp: 'ghostty',
    });
    expect(db.byId('s1')).toMatchObject({
      tmuxName: 'project-a-claude-work-sweech',
      claudeSid: 'claude-uuid',
      jsonlPath: '/Users/me/.claude/projects/a/claude-uuid.jsonl',
      pid: 123,
      terminalApp: 'ghostty',
    });
  });

  test('serializes summary bullets arrays as json', () => {
    insert('s1', { summaryBullets: ['opened repo', 'ran tests'] });
    expect(db.byId('s1')?.summaryBullets).toBe('["opened repo","ran tests"]');
  });

  test('rejects missing id', () => {
    expect(() => insert('', {})).toThrow('session id is required');
  });

  test('rejects missing workspace', () => {
    expect(() => db.insert({ id: 's1', workspace: '', cwd: tmp })).toThrow('session workspace is required');
  });

  test('rejects invalid status', () => {
    expect(() => insert('s1', { status: 'missing' as any })).toThrow('invalid dashboard session status');
  });

  test('updates status to closed and sets closed_at', () => {
    insert('s1');
    const row = db.updateStatus('s1', 'closed', 2000);
    expect(row).toMatchObject({ status: 'closed', closedAt: 2000, lastActiveAt: 2000 });
  });

  test('upserts launch rows idempotently without replacing original launch time', () => {
    db.upsert({
      id: 's1',
      workspace: 'claude-work',
      cwd: path.join(tmp, 'project-a'),
      tmuxName: 'project-a-claude-work-sweech',
      launchedAt: 1000,
      lastActiveAt: 1000,
      pid: 111,
    });
    const row = db.upsert({
      id: 's1',
      workspace: 'claude-work',
      cwd: path.join(tmp, 'project-a'),
      tmuxName: 'project-a-claude-work-sweech',
      launchedAt: 2000,
      lastActiveAt: 2000,
      pid: 222,
    });

    expect(row).toMatchObject({
      id: 's1',
      launchedAt: 1000,
      lastActiveAt: 2000,
      pid: 222,
      status: 'live',
      tmuxName: 'project-a-claude-work-sweech',
    });
  });

  test('updates status by tmux name', () => {
    insert('s1', { tmuxName: 'project-a-claude-work-sweech' });
    const row = db.updateStatusByTmuxName('project-a-claude-work-sweech', 'closed', 2000);
    expect(row).toMatchObject({ id: 's1', status: 'closed', closedAt: 2000 });
  });

  test('updates status away from closed and clears closed_at', () => {
    insert('s1', { status: 'closed', closedAt: 1500 });
    const row = db.updateStatus('s1', 'crash-recoverable', 2000);
    expect(row).toMatchObject({ status: 'crash-recoverable', closedAt: null });
  });

  test('returns null when updating missing session status', () => {
    expect(db.updateStatus('missing', 'closed', 2000)).toBeNull();
  });

  test('marks activity with message counters', () => {
    insert('s1');
    const row = db.markActivity('s1', { at: 3000, messageCount: 7 });
    expect(row).toMatchObject({
      lastActiveAt: 3000,
      messageCount: 7,
      msgCountFirst: 7,
      msgCountLast: 7,
    });
  });

  test('preserves first message count after later activity', () => {
    insert('s1', { messageCount: 4, msgCountFirst: 4, msgCountLast: 4 });
    const row = db.markActivity('s1', { at: 3000, messageCount: 9 });
    expect(row).toMatchObject({ msgCountFirst: 4, msgCountLast: 9 });
  });

  test('marks summary stale when message count passes summary message count', () => {
    insert('s1', { summaryStale: false, summaryMsgAt: 4 });
    expect(db.markActivity('s1', { messageCount: 5 })?.summaryStale).toBe(true);
  });

  test('keeps summary freshness when message count has not advanced', () => {
    insert('s1', { summaryStale: false, summaryMsgAt: 5 });
    expect(db.markActivity('s1', { messageCount: 5 })?.summaryStale).toBe(false);
  });

  test('returns null when marking missing session activity', () => {
    expect(db.markActivity('missing', { messageCount: 1 })).toBeNull();
  });

  test('lists sessions newest activity first', () => {
    insert('old', { lastActiveAt: 1000 });
    insert('new', { lastActiveAt: 2000 });
    expect(db.list().map(row => row.id)).toEqual(['new', 'old']);
  });

  test('filters list by machine', () => {
    insert('local', { machine: 'macbook' });
    insert('remote', { machine: 'studio' });
    expect(db.list({ machine: 'studio' }).map(row => row.id)).toEqual(['remote']);
  });

  test('filters list by workspace', () => {
    insert('a', { workspace: 'claude-work' });
    insert('b', { workspace: 'codex-main' });
    expect(db.list({ workspace: 'codex-main' }).map(row => row.id)).toEqual(['b']);
  });

  test('filters list by one status', () => {
    insert('live', { status: 'live' });
    insert('closed', { status: 'closed' });
    expect(db.list({ status: 'closed' }).map(row => row.id)).toEqual(['closed']);
  });

  test('filters list by multiple statuses', () => {
    insert('live', { status: 'live' });
    insert('detached', { status: 'tmux-detached' });
    insert('closed', { status: 'closed' });
    expect(db.list({ status: ['live', 'tmux-detached'] }).map(row => row.id).sort()).toEqual(['detached', 'live']);
  });

  test('filters list by query across workspace cwd basename and summary', () => {
    insert('summary', { workspace: 'one', summaryOne: 'fixed launch bug' });
    insert('cwd', { workspace: 'two', cwd: path.join(tmp, 'billing-tool') });
    insert('miss', { workspace: 'three', summaryOne: 'nothing relevant' });
    expect(db.list({ q: 'launch' }).map(row => row.id)).toEqual(['summary']);
    expect(db.list({ q: 'billing' }).map(row => row.id)).toEqual(['cwd']);
  });

  test('applies limit and offset', () => {
    insert('a', { lastActiveAt: 1000 });
    insert('b', { lastActiveAt: 2000 });
    insert('c', { lastActiveAt: 3000 });
    expect(db.list({ limit: 1, offset: 1 }).map(row => row.id)).toEqual(['b']);
  });

  test('byId returns null when missing', () => {
    expect(db.byId('missing')).toBeNull();
  });

  test('bulkWipe removes closed rows only', () => {
    insert('live', { status: 'live' });
    insert('closed', { status: 'closed' });
    expect(db.bulkWipe({ closedOnly: true })).toBe(1);
    expect(db.list().map(row => row.id)).toEqual(['live']);
  });

  test('bulkWipe removes rows older than cutoff', () => {
    insert('old', { lastActiveAt: 1000 });
    insert('new', { lastActiveAt: 3000 });
    expect(db.bulkWipe({ olderThan: 2000 })).toBe(1);
    expect(db.list().map(row => row.id)).toEqual(['new']);
  });

  test('bulkWipe combines status and age filters', () => {
    insert('old-live', { status: 'live', lastActiveAt: 1000 });
    insert('old-closed', { status: 'closed', lastActiveAt: 1000 });
    insert('new-closed', { status: 'closed', lastActiveAt: 3000 });
    expect(db.bulkWipe({ status: 'closed', olderThan: 2000 })).toBe(1);
    expect(db.list().map(row => row.id).sort()).toEqual(['new-closed', 'old-live']);
  });

  test('reconcile keeps live pid sessions live', () => {
    insert('s1', { pid: 123, status: 'crash-recoverable', lastActiveAt: 1234 });
    const result = db.reconcileOnDaemonStartup({ livePids: [123], now: 5000 });
    expect(result).toEqual({ checked: 1, live: 1, tmuxDetached: 0, crashRecoverable: 0 });
    expect(db.byId('s1')).toMatchObject({ status: 'live', lastActiveAt: 1234 });
  });

  test('reconcile keeps attached tmux sessions live', () => {
    insert('s1', { pid: null, tmuxName: 'attached', status: 'tmux-detached' });
    db.reconcileOnDaemonStartup({ attachedTmuxNames: ['attached'] });
    expect(db.byId('s1')?.status).toBe('live');
  });

  test('reconcile marks existing unattached tmux sessions detached', () => {
    insert('s1', { pid: null, tmuxName: 'detached', status: 'live' });
    db.reconcileOnDaemonStartup({ existingTmuxNames: ['detached'] });
    expect(db.byId('s1')?.status).toBe('tmux-detached');
  });

  test('reconcile marks missing process and tmux crash recoverable', () => {
    insert('s1', { pid: 999, tmuxName: 'gone', status: 'live', lastActiveAt: 1234 });
    db.reconcileOnDaemonStartup({ livePids: [], existingTmuxNames: [], now: 5000 });
    expect(db.byId('s1')).toMatchObject({ status: 'crash-recoverable', lastActiveAt: 1234 });
  });

  test('reconcile skips already closed sessions', () => {
    insert('s1', { status: 'closed' });
    const result = db.reconcileOnDaemonStartup();
    expect(result.checked).toBe(0);
    expect(db.byId('s1')?.status).toBe('closed');
  });

  test('exported daemon startup helper delegates reconcile', () => {
    insert('s1', { pid: 123 });
    const result = reconcileDashboardSessionsOnDaemonStartup(db, { livePids: [123] });
    expect(result.live).toBe(1);
  });

  test('database persists rows across handles', () => {
    insert('s1', { summaryOne: 'persistent' });
    db.close();
    db = new SessionsDb(dbPath);
    expect(db.byId('s1')?.summaryOne).toBe('persistent');
  });
});
