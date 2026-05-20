/**
 * tmux integration for sweech — wraps CLI launches in named tmux sessions
 * so they survive terminal closure and can be re-attached remotely.
 */

import { execFileSync, spawnSync } from 'child_process';
import * as path from 'path';

let cachedTmuxAvailable: boolean | null = null;

export function isTmuxAvailable(): boolean {
  return tmuxAvailable();
}

export function tmuxAvailable(): boolean {
  if (cachedTmuxAvailable !== null) return cachedTmuxAvailable;

  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    cachedTmuxAvailable = true;
  } catch {
    cachedTmuxAvailable = false;
  }

  return cachedTmuxAvailable;
}

export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || fallback;
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function nameForSession(workspace: string, cwd: string, sid?: string | null): string {
  const baseName = baseNameForSession(workspace, cwd);

  if (!tmuxSessionExists(baseName)) return baseName;

  const sid8 = safeSegment(sid || '', 'collision').slice(-8) || 'collision';
  return `${baseName}-${sid8}`;
}

export function baseNameForSession(workspace: string, cwd: string): string {
  const project = safeSegment(path.basename(cwd), 'workspace');
  const commandName = safeSegment(workspace, 'default');
  return `${project}-${commandName}-sweech`;
}

export interface WrappedTmuxCommand {
  command: string;
  args: string[];
}

export interface WrapCommandOpts {
  detached?: boolean;
  cwd?: string;
  env?: Record<string, string | undefined | null>;
}

export function wrapCommand(
  cmd: string,
  args: string[],
  sessionName: string,
  opts: WrapCommandOpts = {},
): WrappedTmuxCommand {
  const envParts = Object.entries(opts.env || {})
    .filter((entry): entry is [string, string] => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(entry[0]) && entry[1] !== undefined && entry[1] !== null)
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const cdPart = opts.cwd ? [`cd`, shellQuote(opts.cwd), '&&'] : [];
  const shellCmd = [
    ...cdPart,
    'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT;',
    ...envParts,
    shellQuote(cmd),
    ...args.map(shellQuote),
  ].join(' ');

  return {
    command: 'tmux',
    args: ['new-session', ...(opts.detached === false ? [] : ['-d']), '-s', sessionName, '--', shellCmd],
  };
}

export interface LiveTmuxSession {
  name: string;
  attached: number;
  activity: number;
}

export function listLiveSessions(): LiveTmuxSession[] {
  try {
    const output = execFileSync('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}|#{session_attached}|#{session_activity}',
    ], { encoding: 'utf8' });

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, attached, activity] = line.split('|');
        return {
          name,
          attached: Number.parseInt(attached || '0', 10) || 0,
          activity: Number.parseInt(activity || '0', 10) || 0,
        };
      });
  } catch {
    return [];
  }
}

export function attachClients(sessionName: string): number {
  try {
    const output = execFileSync('tmux', ['list-clients', '-t', sessionName], { encoding: 'utf8' });
    if (!output.trim()) return 0;
    return output.trim().split('\n').length;
  } catch {
    return 0;
  }
}

export interface TmuxLaunchOpts {
  command: string;
  args: string[];
  configDirEnvVar?: string;
  configDir?: string | null;
  profileName: string;
  resumeArgs?: string[];
  hasResume?: boolean;
  sessionId?: string | null;
  tmuxName?: string | null;
  launchedAfterMs?: number | null;
}

/**
 * Launch a CLI inside a named tmux session.
 *
 * Behaviour:
 *  - Inside tmux: opens a new window named after the profile
 *  - Outside tmux, session exists: attaches to the existing session
 *  - Outside tmux, no session: creates a detached session, then attaches
 */
export function launchInTmux(opts: TmuxLaunchOpts): number {
  const {
    command,
    args,
    configDirEnvVar,
    configDir,
    profileName,
    resumeArgs = [],
    hasResume = false,
    sessionId = null,
    tmuxName = null,
    launchedAfterMs = null,
  } = opts;

  const sessionName = tmuxName || baseNameForSession(profileName, process.cwd());

  const envParts: string[] = [];
  if (configDirEnvVar && configDir) {
    envParts.push(`${configDirEnvVar}=${shellQuote(configDir)}`);
  }
  if (sessionId) {
    envParts.push(`SWEECH_SESSION_ID=${shellQuote(sessionId)}`);
  }
  envParts.push(`SWEECH_TMUX_NAME=${shellQuote(sessionName)}`);
  envParts.push(`SWEECH_WORKSPACE_NAME=${shellQuote(profileName)}`);
  if (launchedAfterMs) {
    envParts.push(`SWEECH_LAUNCHED_AFTER_MS=${shellQuote(String(launchedAfterMs))}`);
  }

  const cmdParts = [...envParts, shellQuote(command), ...args.map(shellQuote)].join(' ');
  const openSessionCommand = sessionId
    ? [
        'if command -v sweech >/dev/null 2>&1; then',
        'sweech _session-launched --quiet --no-scan-jsonl',
        `--id ${shellQuote(sessionId)}`,
        `--workspace ${shellQuote(profileName)}`,
        '--cwd "$PWD"',
        configDir ? `--config-dir ${shellQuote(configDir)}` : '',
        `--tmux-name ${shellQuote(sessionName)}`,
        '--pid "$$"',
        '--terminal-app "${TERM_PROGRAM:-tmux}"',
        '2>/dev/null || true; fi',
      ].filter(Boolean).join(' ')
    : '';
  const refreshSessionCommand = sessionId
    ? [
          'sweech _session-launched --quiet',
          `--id ${shellQuote(sessionId)}`,
          `--workspace ${shellQuote(profileName)}`,
          '--cwd "$PWD"',
          configDir ? `--config-dir ${shellQuote(configDir)}` : '',
          `--tmux-name ${shellQuote(sessionName)}`,
          '--pid "$$"',
          '--terminal-app "${TERM_PROGRAM:-tmux}"',
          launchedAfterMs ? `--jsonl-after-ms ${shellQuote(String(launchedAfterMs))}` : '',
        ].filter(Boolean).join(' ')
    : '';
  const closeParts = sessionId
    ? [
        '_SWEECH_EXIT=$?',
        'if command -v sweech >/dev/null 2>&1; then',
        `${refreshSessionCommand} 2>/dev/null || true`,
        `sweech _session-closed --quiet --id ${shellQuote(sessionId)} --tmux-name ${shellQuote(sessionName)} 2>/dev/null || true`,
        'fi',
        'exit "$_SWEECH_EXIT"',
      ].join('; ')
    : '';

  let shellCmd: string;
  let bodyCmd: string;
  if (hasResume && resumeArgs.length > 0) {
    const freshArgs = args.filter(a => !resumeArgs.includes(a));
    const freshCmd = [...envParts, shellQuote(command), ...freshArgs.map(shellQuote)].join(' ');
    bodyCmd = `${cmdParts} || (echo 'No conversation to resume — starting fresh session'; ${freshCmd})`;
  } else {
    bodyCmd = cmdParts;
  }
  shellCmd = [
    'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT',
    openSessionCommand,
    bodyCmd,
    closeParts,
  ].filter(Boolean).join('; ');

  if (isInsideTmux()) {
    if (tmuxSessionExists(sessionName)) {
      process.stderr.write(`sweech: switching to existing tmux session '${sessionName}'\n`);
      const result = spawnSync('tmux', ['switch-client', '-t', sessionName], {
        stdio: 'inherit',
      });
      return result.status ?? 0;
    }

    const createResult = spawnSync('tmux', ['new-session', '-d', '-s', sessionName, shellCmd], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (createResult.error) {
      process.stderr.write(`sweech: failed to create tmux session '${sessionName}': ${createResult.error.message}\n`);
      return 1;
    }
    if ((createResult.status ?? 0) !== 0) {
      const stderr = String(createResult.stderr || '').trim();
      process.stderr.write(`sweech: failed to create tmux session '${sessionName}'${stderr ? `: ${stderr}` : ''}\n`);
      return createResult.status ?? 1;
    }
    const result = spawnSync('tmux', ['switch-client', '-t', sessionName], { stdio: 'inherit' });
    return result.status ?? 0;
  }

  if (tmuxSessionExists(sessionName)) {
    process.stderr.write(`sweech: attaching to existing tmux session '${sessionName}'\n`);
    const result = spawnSync('tmux', ['attach-session', '-t', sessionName], {
      stdio: 'inherit',
    });
    return result.status ?? 0;
  }

  const createResult = spawnSync('tmux', ['new-session', '-d', '-s', sessionName, shellCmd], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (createResult.error) {
    process.stderr.write(`sweech: failed to create tmux session '${sessionName}': ${createResult.error.message}\n`);
    return 1;
  }
  if ((createResult.status ?? 0) !== 0) {
    const stderr = String(createResult.stderr || '').trim();
    process.stderr.write(`sweech: failed to create tmux session '${sessionName}'${stderr ? `: ${stderr}` : ''}\n`);
    return createResult.status ?? 1;
  }
  const result = spawnSync('tmux', ['attach-session', '-t', sessionName], { stdio: 'inherit' });
  return result.status ?? 0;
}
