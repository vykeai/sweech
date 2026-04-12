/**
 * Tests for sweech launch command helpers (buildLaunchArgs, shouldUseTmux)
 * and the tmux module (isTmuxAvailable, isInsideTmux, launchInTmux).
 */

import {
  buildLaunchArgs,
  shouldUseTmux,
  SWEECH_LAUNCH_FLAGS,
  LaunchCommandOpts,
} from '../src/launchCommand';

// ── buildLaunchArgs ──────────────────────────────────────────────────────────

describe('buildLaunchArgs', () => {
  const claudeCLI = {
    yoloFlag: '--dangerously-skip-permissions',
    resumeFlag: '--continue',
  };
  const codexCLI = {
    yoloFlag: '--full-auto',
    resumeFlag: '--continue',
  };

  test('returns empty array when no flags set', () => {
    expect(buildLaunchArgs({}, claudeCLI)).toEqual([]);
  });

  test('expands --yolo to claude yoloFlag', () => {
    expect(buildLaunchArgs({ yolo: true }, claudeCLI))
      .toEqual(['--dangerously-skip-permissions']);
  });

  test('expands --resume to claude resumeFlag', () => {
    expect(buildLaunchArgs({ resume: true }, claudeCLI))
      .toEqual(['--continue']);
  });

  test('expands both flags, yolo before resume', () => {
    expect(buildLaunchArgs({ yolo: true, resume: true }, claudeCLI))
      .toEqual(['--dangerously-skip-permissions', '--continue']);
  });

  test('expands --yolo to codex-native flag', () => {
    expect(buildLaunchArgs({ yolo: true }, codexCLI))
      .toEqual(['--full-auto']);
  });

  test('falls back to --dangerously-skip-permissions when yoloFlag missing', () => {
    expect(buildLaunchArgs({ yolo: true }, {}))
      .toEqual(['--dangerously-skip-permissions']);
  });

  test('falls back to --continue when resumeFlag missing', () => {
    expect(buildLaunchArgs({ resume: true }, {}))
      .toEqual(['--continue']);
  });

  test('appends extra passthrough args after sweech flags', () => {
    const args = buildLaunchArgs(
      { yolo: true, resume: true },
      claudeCLI,
      ['--model', 'claude-opus-4-5'],
    );
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--continue',
      '--model',
      'claude-opus-4-5',
    ]);
  });

  test('passthrough args only when no sweech flags set', () => {
    expect(buildLaunchArgs({}, claudeCLI, ['--debug']))
      .toEqual(['--debug']);
  });

  test('tmux opt does not appear in returned args', () => {
    // tmux is a sweech-internal concern, never forwarded
    const args = buildLaunchArgs({ yolo: true, tmux: false }, claudeCLI);
    expect(args).not.toContain('--no-tmux');
    expect(args).not.toContain('--tmux');
    expect(args).toEqual(['--dangerously-skip-permissions']);
  });
});

// ── SWEECH_LAUNCH_FLAGS ──────────────────────────────────────────────────────

describe('SWEECH_LAUNCH_FLAGS', () => {
  test('contains all sweech-internal flags', () => {
    expect(SWEECH_LAUNCH_FLAGS.has('--yolo')).toBe(true);
    expect(SWEECH_LAUNCH_FLAGS.has('-y')).toBe(true);
    expect(SWEECH_LAUNCH_FLAGS.has('--resume')).toBe(true);
    expect(SWEECH_LAUNCH_FLAGS.has('-r')).toBe(true);
    expect(SWEECH_LAUNCH_FLAGS.has('--no-tmux')).toBe(true);
    expect(SWEECH_LAUNCH_FLAGS.has('--tmux')).toBe(true);
  });

  test('does not swallow CLI-native flags', () => {
    expect(SWEECH_LAUNCH_FLAGS.has('--continue')).toBe(false);
    expect(SWEECH_LAUNCH_FLAGS.has('--dangerously-skip-permissions')).toBe(false);
    expect(SWEECH_LAUNCH_FLAGS.has('--model')).toBe(false);
    expect(SWEECH_LAUNCH_FLAGS.has('--debug')).toBe(false);
  });
});

// ── shouldUseTmux ────────────────────────────────────────────────────────────

describe('shouldUseTmux', () => {
  test('true when tmux available and --no-tmux not passed', () => {
    expect(shouldUseTmux(true, {})).toBe(true);
  });

  test('true when tmux available and tmux opt is explicitly true', () => {
    expect(shouldUseTmux(true, { tmux: true })).toBe(true);
  });

  test('false when tmux available but --no-tmux passed (tmux: false)', () => {
    // Commander sets opts.tmux = false when --no-tmux is passed
    expect(shouldUseTmux(true, { tmux: false })).toBe(false);
  });

  test('false when tmux not available regardless of opt', () => {
    expect(shouldUseTmux(false, {})).toBe(false);
    expect(shouldUseTmux(false, { tmux: true })).toBe(false);
  });

  test('false when tmux not available even with explicit tmux: true', () => {
    expect(shouldUseTmux(false, { tmux: true })).toBe(false);
  });
});

// ── tmux module ──────────────────────────────────────────────────────────────

describe('tmux module', () => {
  // We re-require the module inside each test block to get fresh mocks

  describe('isTmuxAvailable', () => {
    test('returns true when `which tmux` exits 0', () => {
      jest.resetModules();
      jest.mock('child_process', () => ({
        execSync: jest.fn(() => '/usr/bin/tmux\n'),
        spawnSync: jest.fn(() => ({ status: 0 })),
      }));
      const { isTmuxAvailable } = require('../src/tmux');
      expect(isTmuxAvailable()).toBe(true);
    });

    test('returns false when `which tmux` throws (tmux not installed)', () => {
      jest.resetModules();
      jest.mock('child_process', () => ({
        execSync: jest.fn(() => { throw new Error('not found'); }),
        spawnSync: jest.fn(() => ({ status: 0 })),
      }));
      const { isTmuxAvailable } = require('../src/tmux');
      expect(isTmuxAvailable()).toBe(false);
    });
  });

  describe('isInsideTmux', () => {
    const original = process.env.TMUX;

    afterEach(() => {
      if (original === undefined) delete process.env.TMUX;
      else process.env.TMUX = original;
    });

    test('returns true when TMUX env var is set', () => {
      jest.resetModules();
      process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
      const { isInsideTmux } = require('../src/tmux');
      expect(isInsideTmux()).toBe(true);
    });

    test('returns false when TMUX env var is absent', () => {
      jest.resetModules();
      delete process.env.TMUX;
      const { isInsideTmux } = require('../src/tmux');
      expect(isInsideTmux()).toBe(false);
    });
  });

  describe('launchInTmux', () => {
    beforeEach(() => jest.resetModules());

    function setupMocks(spawnResult: { status: number }) {
      const spawnSync = jest.fn(() => spawnResult);
      jest.mock('child_process', () => ({
        execSync: jest.fn(() => ''), // tmux has-session → no throw = exists
        spawnSync,
      }));
      return spawnSync;
    }

    test('inside tmux: opens a new window and returns its exit status', () => {
      const spawnSync = setupMocks({ status: 0 });
      process.env.TMUX = '/tmp/tmux-1000/default,1234,0';

      const { launchInTmux } = require('../src/tmux');
      const status = launchInTmux({
        command: 'claude',
        args: ['--continue'],
        profileName: 'claude-pole',
      });

      expect(status).toBe(0);
      const call = spawnSync.mock.calls[0] as any[];
      expect(call[0]).toBe('tmux');
      expect(call[1][0]).toBe('new-window');

      delete process.env.TMUX;
    });

    test('outside tmux, session exists: attaches to existing session', () => {
      jest.resetModules();
      const spawnSync = jest.fn(() => ({ status: 0 }));
      // execSync for `which tmux` succeeds, for `has-session` succeeds (session exists)
      const execSync = jest.fn(() => '');
      jest.mock('child_process', () => ({ execSync, spawnSync }));
      delete process.env.TMUX;

      const { launchInTmux } = require('../src/tmux');
      launchInTmux({ command: 'claude', args: [], profileName: 'claude-work' });

      const calls = spawnSync.mock.calls as any[][];
      const attachCall = calls.find(c => c[1] && c[1][0] === 'attach-session');
      expect(attachCall).toBeDefined();
    });

    test('outside tmux, no session: creates new session then attaches', () => {
      jest.resetModules();
      const spawnSync = jest.fn(() => ({ status: 0 }));
      // execSync for `has-session` throws → session does not exist
      const execSync = jest.fn((cmd: string) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });
      jest.mock('child_process', () => ({ execSync, spawnSync }));
      delete process.env.TMUX;

      const { launchInTmux } = require('../src/tmux');
      launchInTmux({ command: 'claude', args: [], profileName: 'claude-new' });

      const calls = spawnSync.mock.calls as any[][];
      const newSession = calls.find(c => c[1] && c[1][0] === 'new-session');
      const attachSession = calls.find(c => c[1] && c[1][0] === 'attach-session');
      expect(newSession).toBeDefined();
      expect(attachSession).toBeDefined();
    });

    test('session name encodes command and profile', () => {
      jest.resetModules();
      const spawnSync = jest.fn(() => ({ status: 0 }));
      const execSync = jest.fn((cmd: string) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });
      jest.mock('child_process', () => ({ execSync, spawnSync }));
      delete process.env.TMUX;

      const { launchInTmux } = require('../src/tmux');
      launchInTmux({ command: 'claude', args: [], profileName: 'claude-pole' });

      const calls = spawnSync.mock.calls as any[][];
      const newSessionCall = calls.find(c => c[1] && c[1][0] === 'new-session');
      expect(newSessionCall).toBeDefined();
      // session name is the -s argument
      const sArgs: string[] = newSessionCall![1];
      const sessionName = sArgs[sArgs.indexOf('-s') + 1];
      expect(sessionName).toMatch(/sweech-claude-pole/);
    });

    test('resume fallback shell cmd includes fallback on failure', () => {
      jest.resetModules();
      const spawnSync = jest.fn(() => ({ status: 0 }));
      const execSync = jest.fn((cmd: string) => {
        if (cmd.includes('has-session')) throw new Error('no session');
        return '';
      });
      jest.mock('child_process', () => ({ execSync, spawnSync }));
      process.env.TMUX = '/tmp/tmux/x,1,0'; // inside tmux → new-window

      const { launchInTmux } = require('../src/tmux');
      launchInTmux({
        command: 'claude',
        args: ['--continue'],
        profileName: 'claude-pole',
        resumeArgs: ['--continue'],
        hasResume: true,
      });

      const calls = spawnSync.mock.calls as any[][];
      const newWinCall = calls.find(c => c[1] && c[1][0] === 'new-window');
      // tmux new-window args: ['new-window', '-n', sessionName, shellCmd]
      const shellCmd: string = newWinCall![1][3];
      // Shell cmd should have fallback (||) to fresh session on resume failure
      expect(shellCmd).toContain('||');
      expect(shellCmd).toContain('--continue');

      delete process.env.TMUX;
    });
  });
});
