import { execFile } from 'child_process';

export type TerminalName = 'ghostty' | 'iterm2' | 'terminal' | 'alacritty' | 'kitty' | 'wezterm';

export interface DetectedTerminal {
  terminal: TerminalName;
  label: string;
  binary?: string;
  bundleId?: string;
  appPath?: string;
}

export interface LaunchTerminalOptions {
  terminal: TerminalName;
  command: readonly [string, ...string[]];
  cwd?: string;
  newWindow?: boolean;
  title?: string;
}

export interface LaunchTerminalResult {
  ok: boolean;
  reason?: string;
  command?: string;
  args?: string[];
}

const APP_TERMINALS: Record<'ghostty' | 'iterm2' | 'terminal', { label: string; bundleId: string }> = {
  ghostty: { label: 'Ghostty', bundleId: 'com.mitchellh.ghostty' },
  iterm2: { label: 'iTerm2', bundleId: 'com.googlecode.iterm2' },
  terminal: { label: 'Terminal.app', bundleId: 'com.apple.Terminal' },
};

const GENERIC_TERMINALS: Array<{ terminal: 'alacritty' | 'kitty' | 'wezterm'; label: string; binary: string }> = [
  { terminal: 'alacritty', label: 'Alacritty', binary: 'alacritty' },
  { terminal: 'kitty', label: 'kitty', binary: 'kitty' },
  { terminal: 'wezterm', label: 'WezTerm', binary: 'wezterm' },
];

export async function detectInstalledTerminals(): Promise<DetectedTerminal[]> {
  const detected: DetectedTerminal[] = [];
  for (const terminal of Object.keys(APP_TERMINALS) as Array<keyof typeof APP_TERMINALS>) {
    const app = APP_TERMINALS[terminal];
    const appPath = await findAppByBundleId(app.bundleId);
    const binary = terminal === 'ghostty' ? await which('ghostty') : undefined;
    if (appPath || binary) {
      detected.push({ terminal, label: app.label, bundleId: app.bundleId, appPath, binary });
    }
  }
  for (const terminal of GENERIC_TERMINALS) {
    const binary = await which(terminal.binary);
    if (binary) {
      detected.push({ terminal: terminal.terminal, label: terminal.label, binary });
    }
  }
  return detected;
}

export async function launchTerminal(options: LaunchTerminalOptions): Promise<LaunchTerminalResult> {
  if (options.terminal === 'ghostty') return launchGhostty(options);
  if (options.terminal === 'iterm2') return launchIterm2(options);
  if (options.terminal === 'terminal') return launchTerminalApp(options);
  return launchGeneric(options);
}

async function launchGhostty(options: LaunchTerminalOptions): Promise<LaunchTerminalResult> {
  const [appPath, binary] = await Promise.all([
    findAppByBundleId(APP_TERMINALS.ghostty.bundleId),
    which('ghostty'),
  ]);
  if (!appPath && !binary) {
    return missing('Ghostty', 'Install Ghostty or choose an installed terminal such as iTerm2, Terminal.app, kitty, alacritty, or wezterm.');
  }

  if (appPath) {
    const url = ghosttyUrl(options);
    try {
      await execFileAsync('open', [url], { timeout: 5000 });
      return launched('open', [url]);
    } catch {
      if (!binary) {
        return missing('Ghostty URL handler', 'Ghostty is installed but its URL handler failed; install the ghostty CLI or re-register Ghostty as the ghostty:// handler.');
      }
    }
  }

  const args = ['-e', ...options.command];
  await execFileAsync(binary || 'ghostty', args, { cwd: options.cwd, timeout: 5000 });
  return launched(binary || 'ghostty', args);
}

async function launchIterm2(options: LaunchTerminalOptions): Promise<LaunchTerminalResult> {
  const appPath = await findAppByBundleId(APP_TERMINALS.iterm2.bundleId);
  if (!appPath) {
    return missing('iTerm2', 'Install iTerm2 or choose Ghostty, Terminal.app, kitty, alacritty, or wezterm.');
  }
  const script = options.newWindow === false
    ? `tell application "iTerm2" to tell current window to create tab with default profile command "${appleScriptString(shellCommand(options))}"`
    : `tell application "iTerm2" to create window with default profile command "${appleScriptString(shellCommand(options))}"`;
  const args = ['-e', script];
  await execFileAsync('osascript', args, { timeout: 5000 });
  return launched('osascript', args);
}

async function launchTerminalApp(options: LaunchTerminalOptions): Promise<LaunchTerminalResult> {
  const appPath = await findAppByBundleId(APP_TERMINALS.terminal.bundleId);
  if (!appPath) {
    return missing('Terminal.app', 'Terminal.app was not found; restore it from macOS or choose an installed terminal.');
  }
  const script = `tell application "Terminal" to do script "${appleScriptString(shellCommand(options))}"`;
  const args = ['-e', script];
  await execFileAsync('osascript', args, { timeout: 5000 });
  return launched('osascript', args);
}

async function launchGeneric(options: LaunchTerminalOptions): Promise<LaunchTerminalResult> {
  const terminal = GENERIC_TERMINALS.find((candidate) => candidate.terminal === options.terminal);
  if (!terminal) {
    return missing(options.terminal, 'Choose one of: ghostty, iterm2, terminal, alacritty, kitty, wezterm.');
  }
  const binary = await which(terminal.binary);
  if (!binary) {
    return missing(terminal.label, `Install ${terminal.label} or choose an installed terminal.`);
  }
  const args = ['-e', ...options.command];
  await execFileAsync(binary, args, { cwd: options.cwd, timeout: 5000 });
  return launched(binary, args);
}

async function findAppByBundleId(bundleId: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 1000 });
    return firstLine(stdout);
  } catch {
    return undefined;
  }
}

async function which(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('which', [binary], { timeout: 1000 });
    return firstLine(stdout);
  } catch {
    return undefined;
  }
}

function firstLine(value: string | Buffer): string | undefined {
  const line = value.toString().split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line || undefined;
}

function ghosttyUrl(options: LaunchTerminalOptions): string {
  const params = new URLSearchParams();
  params.set('command', shellCommand(options));
  if (options.cwd) params.set('working-directory', options.cwd);
  if (options.title) params.set('title', options.title);
  if (options.newWindow === false) params.set('new-window', 'false');
  return `ghostty://run?${params.toString()}`;
}

function shellCommand(options: LaunchTerminalOptions): string {
  const command = options.command.map(posixQuote).join(' ');
  const titled = options.title ? `printf '\\033]0;%s\\007' ${posixQuote(options.title)}; ${command}` : command;
  return options.cwd ? `cd ${posixQuote(options.cwd)} && ${titled}` : titled;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function missing(name: string, hint: string): LaunchTerminalResult {
  return { ok: false, reason: `${name} not found. ${hint}` };
}

function launched(command: string, args: string[]): LaunchTerminalResult {
  return { ok: true, command, args };
}

function execFileAsync(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}
