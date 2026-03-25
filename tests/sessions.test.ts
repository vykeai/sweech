/**
 * Tests for session detection and management (sessions.ts)
 */

import * as path from 'path';

const MOCK_HOME = '/mock/home';

jest.mock('child_process');
jest.mock('fs');
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: jest.fn(() => MOCK_HOME),
}));

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockFs = fs as jest.Mocked<typeof fs>;

import {
  detectActiveSessions,
  getSessionsForAccount,
  killSession,
  tagSession,
  ActiveSession,
} from '../src/sessions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_TAGS_FILE = path.join(MOCK_HOME, '.sweech', 'session-tags.json');

/** Build a ps-aux header line */
const PS_HEADER = 'USER       PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND';

/** Build a ps-aux process line */
function psLine(pid: number, cmd: string, started = '10:23AM'): string {
  return `user     ${pid}   0.0  0.1  1234567  12345 ??  S    ${started}   0:01.23 ${cmd}`;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// detectActiveSessions
// ---------------------------------------------------------------------------

describe('detectActiveSessions', () => {
  test('returns empty array when ps aux fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('ps: command not found');
    });

    const sessions = detectActiveSessions();
    expect(sessions).toEqual([]);
  });

  test('returns empty array when no matching processes found', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(100, 'node server.js'), psLine(200, 'vim file.txt')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions).toEqual([]);
  });

  test('detects a running claude process', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(1234, 'claude --help')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].pid).toBe(1234);
    expect(sessions[0].cliType).toBe('claude');
    expect(sessions[0].commandName).toBe('claude');
    expect(sessions[0].command).toBe('claude --help');
  });

  test('detects a running codex process', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(5678, 'codex run')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].pid).toBe(5678);
    expect(sessions[0].cliType).toBe('codex');
    expect(sessions[0].commandName).toBe('codex');
  });

  test('detects multiple concurrent sessions', () => {
    mockExecSync.mockReturnValue(
      [
        PS_HEADER,
        psLine(1000, 'claude chat'),
        psLine(2000, 'codex run'),
        psLine(3000, 'claude --continue'),
      ].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(3);
    const pids = sessions.map(s => s.pid).sort();
    expect(pids).toEqual([1000, 2000, 3000]);
  });

  test('extracts config dir from CLAUDE_CONFIG_DIR env var in command', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(999, 'CLAUDE_CONFIG_DIR=/home/.claude-work claude chat')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].configDir).toBe('/home/.claude-work');
    expect(sessions[0].cliType).toBe('claude');
    expect(sessions[0].commandName).toBe('claude-work');
  });

  test('extracts config dir from CODEX_HOME env var in command', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(888, 'CODEX_HOME=/home/.codex-team codex run')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].configDir).toBe('/home/.codex-team');
    expect(sessions[0].cliType).toBe('codex');
    expect(sessions[0].commandName).toBe('codex-team');
  });

  test('skips own process PID', () => {
    const ownPid = process.pid;
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(ownPid, 'claude chat')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions).toEqual([]);
  });

  test('does not match CLI name as substring of another word', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(111, 'claudebot --serve')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions).toEqual([]);
  });

  test('matches CLI command preceded by path separator', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(222, '/usr/local/bin/claude chat')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].cliType).toBe('claude');
  });

  test('handles ps output with malformed lines gracefully', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, 'short line', '', psLine(333, 'claude run')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].pid).toBe(333);
  });

  test('populates startedAt as an ISO 8601 string', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(444, 'claude chat', '2:30PM')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    // Should be a valid ISO date string
    const date = new Date(sessions[0].startedAt);
    expect(date.getTime()).not.toBeNaN();
  });

  test('derives commandName by stripping leading dot from config dir basename', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(555, 'CLAUDE_CONFIG_DIR=/home/.my-profile claude chat')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions[0].commandName).toBe('my-profile');
  });

  test('handles config dir without leading dot in basename', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(666, 'CLAUDE_CONFIG_DIR=/opt/configs/myprofile claude chat')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions[0].commandName).toBe('myprofile');
  });
});

// ---------------------------------------------------------------------------
// getSessionsForAccount
// ---------------------------------------------------------------------------

describe('getSessionsForAccount', () => {
  test('filters sessions by commandName', () => {
    mockExecSync.mockReturnValue(
      [
        PS_HEADER,
        psLine(100, 'CLAUDE_CONFIG_DIR=/home/.claude-work claude chat'),
        psLine(200, 'CLAUDE_CONFIG_DIR=/home/.claude-personal claude chat'),
        psLine(300, 'CLAUDE_CONFIG_DIR=/home/.claude-work claude --continue'),
      ].join('\n')
    );

    const sessions = getSessionsForAccount('claude-work');
    expect(sessions.length).toBe(2);
    sessions.forEach(s => expect(s.commandName).toBe('claude-work'));
  });

  test('returns empty array when no sessions match', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(100, 'claude chat')].join('\n')
    );

    const sessions = getSessionsForAccount('nonexistent-profile');
    expect(sessions).toEqual([]);
  });

  test('returns empty list when ps fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('fail');
    });

    const sessions = getSessionsForAccount('anything');
    expect(sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// killSession
// ---------------------------------------------------------------------------

describe('killSession', () => {
  const originalKill = process.kill;

  beforeEach(() => {
    process.kill = jest.fn();
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  test('sends SIGTERM to the given PID and returns true', () => {
    (process.kill as jest.Mock).mockImplementation(() => {});

    const result = killSession(1234);
    expect(result).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  test('returns false when process.kill throws (process already exited)', () => {
    (process.kill as jest.Mock).mockImplementation(() => {
      throw new Error('ESRCH');
    });

    const result = killSession(9999);
    expect(result).toBe(false);
  });

  test('returns false when process.kill throws (no permissions)', () => {
    (process.kill as jest.Mock).mockImplementation(() => {
      throw new Error('EPERM');
    });

    const result = killSession(1);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tagSession — persistence
// ---------------------------------------------------------------------------

describe('tagSession', () => {
  test('writes a tag for a session PID to the tags file', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{}');
    mockFs.writeFileSync.mockImplementation(() => {});

    tagSession(1234, 'my-tag');

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
    const [filePath, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    expect(filePath).toContain('session-tags.json');
    const parsed = JSON.parse(content as string);
    expect(parsed['1234']).toBe('my-tag');
  });

  test('appends to existing tags without overwriting', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{"100":"old-tag"}');
    mockFs.writeFileSync.mockImplementation(() => {});

    tagSession(200, 'new-tag');

    const [, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed['100']).toBe('old-tag');
    expect(parsed['200']).toBe('new-tag');
  });

  test('creates the .sweech directory if it does not exist', () => {
    // First existsSync call for session-tags.json (readSessionTags) -> false
    // Second existsSync call for directory (writeSessionTags) -> false
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockImplementation(() => undefined as any);
    mockFs.writeFileSync.mockImplementation(() => {});

    tagSession(555, 'test-tag');

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.sweech'),
      { recursive: true }
    );
  });

  test('handles corrupted tags file gracefully', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('not valid json{{{');
    mockFs.writeFileSync.mockImplementation(() => {});

    // Should not throw
    expect(() => tagSession(777, 'recover')).not.toThrow();

    const [, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed['777']).toBe('recover');
  });

  test('overwrites tag for the same PID', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{"42":"old"}');
    mockFs.writeFileSync.mockImplementation(() => {});

    tagSession(42, 'new');

    const [, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed['42']).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('detectActiveSessions with empty ps output returns empty array', () => {
    mockExecSync.mockReturnValue('');

    const sessions = detectActiveSessions();
    expect(sessions).toEqual([]);
  });

  test('detectActiveSessions with header-only ps output returns empty array', () => {
    mockExecSync.mockReturnValue(PS_HEADER + '\n');

    const sessions = detectActiveSessions();
    expect(sessions).toEqual([]);
  });

  test('config dir with quoted path is extracted correctly', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(700, "CLAUDE_CONFIG_DIR='/home/.claude-quoted' claude chat")].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].configDir).toBe('/home/.claude-quoted');
  });

  test('normalizes AM/PM start times', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(800, 'claude chat', '11:59PM')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    const d = new Date(sessions[0].startedAt);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
  });

  test('normalizes 12:xxAM correctly to 0:xx', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(801, 'claude chat', '12:05AM')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    const d = new Date(sessions[0].startedAt);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(5);
  });

  test('fallback start time when format is unrecognized', () => {
    mockExecSync.mockReturnValue(
      [PS_HEADER, psLine(802, 'claude chat', 'Jan01')].join('\n')
    );

    const sessions = detectActiveSessions();
    expect(sessions.length).toBe(1);
    // Should still be a valid ISO date (falls back to now)
    const d = new Date(sessions[0].startedAt);
    expect(d.getTime()).not.toBeNaN();
  });
});
