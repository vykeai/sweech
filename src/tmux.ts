/**
 * tmux integration for sweech — wraps CLI launches in named tmux sessions
 * so they survive terminal closure and can be re-attached remotely.
 */

import { execSync, spawnSync } from 'child_process';
import * as path from 'path';

export function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${shellQuote(name)}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface TmuxLaunchOpts {
  command: string;
  args: string[];
  configDirEnvVar?: string;
  configDir?: string | null;
  profileName: string;
  resumeArgs?: string[];
  hasResume?: boolean;
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
  } = opts;

  // Strip redundant command prefix from profile name (e.g. "codex" profile + "codex" command → just use dir)
  const strippedProfile = profileName.replace(new RegExp(`^${command}-?`, 'i'), '') || null;
  const safeProfile = strippedProfile
    ? strippedProfile.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30)
    : null;
  const safeDir = path.basename(process.cwd()).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 20);
  const sessionName = safeProfile
    ? `sweech-${command}-${safeProfile}-${safeDir}`
    : `sweech-${command}-${safeDir}`;

  // Build env prefix — only sweech-specific vars; rest comes from shell
  const envParts: string[] = [];
  if (configDirEnvVar && configDir) {
    envParts.push(`${configDirEnvVar}=${shellQuote(configDir)}`);
  }

  const cmdParts = [...envParts, command, ...args.map(shellQuote)].join(' ');

  let shellCmd: string;
  if (hasResume && resumeArgs.length > 0) {
    const freshArgs = args.filter(a => !resumeArgs.includes(a));
    const freshCmd = [...envParts, command, ...freshArgs.map(shellQuote)].join(' ');
    shellCmd =
      `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ` +
      `${cmdParts} || (echo 'No conversation to resume — starting fresh session'; ${freshCmd})`;
  } else {
    shellCmd = `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; ${cmdParts}`;
  }

  if (isInsideTmux()) {
    const result = spawnSync('tmux', ['new-window', '-n', sessionName, shellCmd], {
      stdio: 'inherit',
    });
    return result.status ?? 0;
  }

  if (tmuxSessionExists(sessionName)) {
    process.stderr.write(`sweech: attaching to existing tmux session '${sessionName}'\n`);
    const result = spawnSync('tmux', ['attach-session', '-t', sessionName], {
      stdio: 'inherit',
    });
    return result.status ?? 0;
  }

  // Create detached session, then attach so the terminal is connected
  spawnSync('tmux', ['new-session', '-d', '-s', sessionName, shellCmd], { stdio: 'pipe' });
  const result = spawnSync('tmux', ['attach-session', '-t', sessionName], { stdio: 'inherit' });
  return result.status ?? 0;
}
