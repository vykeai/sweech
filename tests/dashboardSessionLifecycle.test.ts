import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockSummarizeNow = jest.fn();
const mockSummarizerClose = jest.fn();

jest.mock('../src/sessionSummarizer', () => ({
  SessionSummarizer: jest.fn().mockImplementation(() => ({
    summarizeNow: mockSummarizeNow,
    close: mockSummarizerClose,
  })),
}));

import { closeDashboardSession, findLatestClaudeJsonl, recordDashboardSessionLaunch } from '../src/dashboardSessionLifecycle';
import { SessionsDb } from '../src/sessionsDb';

describe('dashboard session lifecycle', () => {
  let tmp: string;
  let dbPath: string;
  let cwd: string;
  let configDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-dashboard-lifecycle-'));
    dbPath = path.join(tmp, '.sweech', 'sessions.db');
    cwd = path.join(tmp, 'project-a');
    configDir = path.join(tmp, '.claude-work');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    mockSummarizeNow.mockResolvedValue(null);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('records a launch row and closes it by tmux name', () => {
    const row = recordDashboardSessionLaunch({
      id: 'launch-1',
      workspace: 'claude-work',
      cwd,
      configDir,
      tmuxName: 'project-a-claude-work-sweech',
      pid: 123,
      terminalApp: 'ghostty',
      dbPath,
      now: 1000,
    });
    expect(row).toMatchObject({
      id: 'launch-1',
      workspace: 'claude-work',
      cwd,
      tmuxName: 'project-a-claude-work-sweech',
      status: 'live',
    });

    const closed = closeDashboardSession({ tmuxName: 'project-a-claude-work-sweech', dbPath, now: 2000 });
    expect(closed).toMatchObject({ id: 'launch-1', status: 'closed', closedAt: 2000 });
    expect(mockSummarizeNow).toHaveBeenCalledWith('launch-1', 'session-end');
  });

  test('attaches the newest claude jsonl metadata when present', () => {
    const projectDir = path.join(configDir, 'projects', cwd.replace(/\//g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    const oldPath = path.join(projectDir, 'old-session.jsonl');
    const newPath = path.join(projectDir, 'new-session.jsonl');
    fs.writeFileSync(oldPath, '{}\n');
    fs.writeFileSync(newPath, '{}\n');
    fs.utimesSync(oldPath, new Date(1000), new Date(1000));
    fs.utimesSync(newPath, new Date(2000), new Date(2000));

    expect(findLatestClaudeJsonl(configDir, cwd)).toEqual({ sid: 'new-session', jsonlPath: newPath });
    recordDashboardSessionLaunch({ id: 'launch-1', workspace: 'claude-work', cwd, configDir, dbPath });

    const db = new SessionsDb(dbPath);
    try {
      expect(db.byId('launch-1')).toMatchObject({ claudeSid: 'new-session', jsonlPath: newPath });
    } finally {
      db.close();
    }
  });

  test('can skip prelaunch jsonl scan and later attach only postlaunch jsonls', () => {
    const projectDir = path.join(configDir, 'projects', cwd.replace(/\//g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    const stalePath = path.join(projectDir, 'stale-session.jsonl');
    const freshPath = path.join(projectDir, 'fresh-session.jsonl');
    fs.writeFileSync(stalePath, '{}\n');
    fs.utimesSync(stalePath, new Date(1000), new Date(1000));

    recordDashboardSessionLaunch({
      id: 'launch-1',
      workspace: 'claude-work',
      cwd,
      configDir,
      dbPath,
      scanJsonl: false,
      now: 1500,
    });

    let db = new SessionsDb(dbPath);
    try {
      expect(db.byId('launch-1')).toMatchObject({ claudeSid: null, jsonlPath: null });
    } finally {
      db.close();
    }

    fs.writeFileSync(freshPath, '{}\n');
    fs.utimesSync(freshPath, new Date(3000), new Date(3000));
    recordDashboardSessionLaunch({
      id: 'launch-1',
      workspace: 'claude-work',
      cwd,
      configDir,
      dbPath,
      jsonlAfterMs: 2000,
      now: 3500,
    });

    db = new SessionsDb(dbPath);
    try {
      expect(db.byId('launch-1')).toMatchObject({ claudeSid: 'fresh-session', jsonlPath: freshPath });
    } finally {
      db.close();
    }
  });
});
