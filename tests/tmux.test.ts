describe('tmux integration', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.TMUX;
  });

  function mockChildProcess(execFileSyncImpl: jest.Mock, spawnSyncImpl = jest.fn(() => ({ status: 0 }))) {
    jest.doMock('child_process', () => ({
      execFileSync: execFileSyncImpl,
      spawnSync: spawnSyncImpl,
    }));
    return { execFileSync: execFileSyncImpl, spawnSync: spawnSyncImpl };
  }

  test('tmuxAvailable returns true and caches the result', () => {
    const execFileSync = jest.fn(() => 'tmux 3.4\n');
    mockChildProcess(execFileSync);
    const { tmuxAvailable, isTmuxAvailable } = require('../src/tmux');

    expect(tmuxAvailable()).toBe(true);
    expect(isTmuxAvailable()).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  test('tmuxAvailable returns false when tmux is missing', () => {
    mockChildProcess(jest.fn(() => { throw new Error('missing'); }));
    const { tmuxAvailable } = require('../src/tmux');

    expect(tmuxAvailable()).toBe(false);
  });

  test('nameForSession uses project workspace suffix without collision', () => {
    const execFileSync = jest.fn(() => { throw new Error('missing session'); });
    mockChildProcess(execFileSync);
    const { nameForSession } = require('../src/tmux');

    expect(nameForSession('claude', '/Users/luke/dev/sweech', 'abcdef123456')).toBe('sweech-claude-sweech');
  });

  test('nameForSession appends sid8 on collision', () => {
    mockChildProcess(jest.fn(() => ''));
    const { nameForSession } = require('../src/tmux');

    expect(nameForSession('claude', '/Users/luke/dev/sweech', 'abcdef123456')).toBe('sweech-claude-sweech-abcdef12');
  });

  test('nameForSession sanitizes unsafe characters', () => {
    const execFileSync = jest.fn(() => { throw new Error('missing session'); });
    mockChildProcess(execFileSync);
    const { nameForSession } = require('../src/tmux');

    expect(nameForSession('my workspace;rm -rf', '/tmp/weird project', 'sid')).toBe('weird-project-my-workspace-rm-rf-sweech');
  });

  test('nameForSession falls back for empty segments', () => {
    const execFileSync = jest.fn(() => { throw new Error('missing session'); });
    mockChildProcess(execFileSync);
    const { nameForSession } = require('../src/tmux');

    expect(nameForSession('!!!', '/', 'sid')).toBe('workspace-default-sweech');
  });

  test('wrapCommand returns tmux new-session command args', () => {
    mockChildProcess(jest.fn());
    const { wrapCommand } = require('../src/tmux');

    expect(wrapCommand('claude', ['--continue'], 'sweech-claude-sweech')).toEqual({
      command: 'tmux',
      args: ['new-session', '-d', '-s', 'sweech-claude-sweech', '--', 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; claude --continue'],
    });
  });

  test('wrapCommand supports foreground mode', () => {
    mockChildProcess(jest.fn());
    const { wrapCommand } = require('../src/tmux');

    expect(wrapCommand('claude', [], 'name', { detached: false }).args).toEqual([
      'new-session',
      '-s',
      'name',
      '--',
      'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; claude',
    ]);
  });

  test('wrapCommand quotes args, cwd, and env values', () => {
    mockChildProcess(jest.fn());
    const { wrapCommand } = require('../src/tmux');

    const wrapped = wrapCommand('claude', ['a;b', "it's"], 'name', {
      cwd: '/tmp/my project',
      env: { CODEX_HOME: '/tmp/codex home', EMPTY: null },
    });

    expect(wrapped.args[wrapped.args.length - 1]).toBe("cd '/tmp/my project' && unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; CODEX_HOME='/tmp/codex home' claude 'a;b' 'it'\\''s'");
  });

  test('wrapCommand drops unsafe env keys', () => {
    mockChildProcess(jest.fn());
    const { wrapCommand } = require('../src/tmux');

    const wrapped = wrapCommand('claude', [], 'name', {
      env: { 'BAD;KEY': 'x', GOOD_KEY: 'safe' },
    });

    expect(wrapped.args[wrapped.args.length - 1]).toBe('unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; GOOD_KEY=safe claude');
  });

  test('listLiveSessions parses tmux output', () => {
    mockChildProcess(jest.fn(() => 'one|1|1710000000\ntwo|0|1710000042\n'));
    const { listLiveSessions } = require('../src/tmux');

    expect(listLiveSessions()).toEqual([
      { name: 'one', attached: 1, activity: 1710000000 },
      { name: 'two', attached: 0, activity: 1710000042 },
    ]);
  });

  test('listLiveSessions returns empty array when tmux fails', () => {
    mockChildProcess(jest.fn(() => { throw new Error('no server'); }));
    const { listLiveSessions } = require('../src/tmux');

    expect(listLiveSessions()).toEqual([]);
  });

  test('attachClients counts client lines', () => {
    const execFileSync = jest.fn(() => 'client-a\nclient-b\n');
    mockChildProcess(execFileSync);
    const { attachClients } = require('../src/tmux');

    expect(attachClients('session;bad')).toBe(2);
    expect(execFileSync).toHaveBeenCalledWith('tmux', ['list-clients', '-t', 'session;bad'], { encoding: 'utf8' });
  });

  test('attachClients returns zero for no clients', () => {
    mockChildProcess(jest.fn(() => '\n'));
    const { attachClients } = require('../src/tmux');

    expect(attachClients('session')).toBe(0);
  });

  test('attachClients returns zero when tmux fails', () => {
    mockChildProcess(jest.fn(() => { throw new Error('no session'); }));
    const { attachClients } = require('../src/tmux');

    expect(attachClients('session')).toBe(0);
  });
});
