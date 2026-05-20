import { execFile } from 'child_process';
import {
  detectInstalledTerminals,
  launchTerminal,
} from '../src/terminalLauncher';

jest.mock('child_process');

const mockExecFile = execFile as unknown as jest.Mock;

function execFileOk(stdout = ''): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, stdout, '');
  });
}

function execFileByCall(handler: (cmd: string, args: string[]) => string | Error): void {
  mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const result = handler(cmd, args);
    if (result instanceof Error) cb(result, '', result.message);
    else cb(null, result, '');
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('detectInstalledTerminals', () => {
  test('detects app terminals with mdfind and generic terminals with which', async () => {
    execFileByCall((cmd, args) => {
      if (cmd === 'mdfind' && args[0].includes('com.mitchellh.ghostty')) return '/Applications/Ghostty.app\n';
      if (cmd === 'mdfind' && args[0].includes('com.googlecode.iterm2')) return '';
      if (cmd === 'mdfind' && args[0].includes('com.apple.Terminal')) return '/System/Applications/Utilities/Terminal.app\n';
      if (cmd === 'which' && args[0] === 'ghostty') return '/opt/homebrew/bin/ghostty\n';
      if (cmd === 'which' && args[0] === 'kitty') return '/usr/local/bin/kitty\n';
      return new Error('not found');
    });

    await expect(detectInstalledTerminals()).resolves.toEqual([
      { terminal: 'ghostty', label: 'Ghostty', bundleId: 'com.mitchellh.ghostty', appPath: '/Applications/Ghostty.app', binary: '/opt/homebrew/bin/ghostty' },
      { terminal: 'terminal', label: 'Terminal.app', bundleId: 'com.apple.Terminal', appPath: '/System/Applications/Utilities/Terminal.app', binary: undefined },
      { terminal: 'kitty', label: 'kitty', binary: '/usr/local/bin/kitty' },
    ]);
  });
});

describe('launchTerminal', () => {
  test('launches Ghostty with URL scheme', async () => {
    execFileByCall((cmd, args) => {
      if (cmd === 'mdfind') return '/Applications/Ghostty.app\n';
      if (cmd === 'which') return '/opt/homebrew/bin/ghostty\n';
      if (cmd === 'open') return '';
      return new Error(`unexpected ${cmd} ${args.join(' ')}`);
    });

    const result = await launchTerminal({
      terminal: 'ghostty',
      command: ['tmux', 'attach', '-t', 'sweech-one;rm -rf /'],
      cwd: '/Users/luke/dev/project one',
      title: 'Sweech One',
    });

    expect(result).toEqual({
      ok: true,
      command: 'open',
      args: ['ghostty://run?command=cd+%27%2FUsers%2Fluke%2Fdev%2Fproject+one%27+%26%26+printf+%27%5C033%5D0%3B%25s%5C007%27+%27Sweech+One%27%3B+%27tmux%27+%27attach%27+%27-t%27+%27sweech-one%3Brm+-rf+%2F%27&working-directory=%2FUsers%2Fluke%2Fdev%2Fproject+one&title=Sweech+One'],
    });
  });

  test('falls back to ghostty -e when URL launch fails', async () => {
    execFileByCall((cmd) => {
      if (cmd === 'mdfind') return '/Applications/Ghostty.app\n';
      if (cmd === 'which') return '/opt/homebrew/bin/ghostty\n';
      if (cmd === 'open') return new Error('no handler');
      if (cmd === '/opt/homebrew/bin/ghostty') return '';
      return new Error(`unexpected ${cmd}`);
    });

    await expect(launchTerminal({ terminal: 'ghostty', command: ['tmux', 'attach', '-t', 's1'] })).resolves.toEqual({
      ok: true,
      command: '/opt/homebrew/bin/ghostty',
      args: ['-e', 'tmux', 'attach', '-t', 's1'],
    });
  });

  test('launches iTerm2 via AppleScript', async () => {
    execFileByCall((cmd) => {
      if (cmd === 'mdfind') return '/Applications/iTerm.app\n';
      if (cmd === 'osascript') return '';
      return new Error(`unexpected ${cmd}`);
    });

    await expect(launchTerminal({ terminal: 'iterm2', command: ['tmux', 'attach', '-t', "team's"], cwd: '/repo' })).resolves.toEqual({
      ok: true,
      command: 'osascript',
      args: ['-e', 'tell application "iTerm2" to create window with default profile command "cd \'/repo\' && \'tmux\' \'attach\' \'-t\' \'team\'\\\\\'\'s\'"'],
    });
  });

  test('launches Terminal.app via AppleScript', async () => {
    execFileByCall((cmd) => {
      if (cmd === 'mdfind') return '/System/Applications/Utilities/Terminal.app\n';
      if (cmd === 'osascript') return '';
      return new Error(`unexpected ${cmd}`);
    });

    await expect(launchTerminal({ terminal: 'terminal', command: ['echo', 'hello world'] })).resolves.toEqual({
      ok: true,
      command: 'osascript',
      args: ['-e', 'tell application "Terminal" to do script "\'echo\' \'hello world\'"'],
    });
  });

  test('launches generic terminals with -e argv and no shell', async () => {
    execFileByCall((cmd, args) => {
      if (cmd === 'which' && args[0] === 'kitty') return '/usr/local/bin/kitty\n';
      if (cmd === '/usr/local/bin/kitty') return '';
      return new Error(`unexpected ${cmd}`);
    });

    await expect(launchTerminal({ terminal: 'kitty', command: ['echo', '$(touch hacked)'], cwd: '/repo' })).resolves.toEqual({
      ok: true,
      command: '/usr/local/bin/kitty',
      args: ['-e', 'echo', '$(touch hacked)'],
    });
    expect(mockExecFile).toHaveBeenLastCalledWith('/usr/local/bin/kitty', ['-e', 'echo', '$(touch hacked)'], { cwd: '/repo', timeout: 5000 }, expect.any(Function));
  });

  test('refuses with actionable hint when binary is missing', async () => {
    execFileByCall(() => new Error('not found'));

    await expect(launchTerminal({ terminal: 'wezterm', command: ['tmux', 'attach', '-t', 's1'] })).resolves.toEqual({
      ok: false,
      reason: 'WezTerm not found. Install WezTerm or choose an installed terminal.',
    });
  });

  test('does not use shell option for injection-sensitive launch paths', async () => {
    execFileOk('/usr/local/bin/alacritty\n');

    await launchTerminal({ terminal: 'alacritty', command: ['echo', 'x; touch /tmp/pwned'] });

    for (const call of mockExecFile.mock.calls) {
      expect(call[2]).not.toHaveProperty('shell');
    }
  });
});
