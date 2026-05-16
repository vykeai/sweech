/**
 * Structured launch logging — appends one JSONL line per launch to
 * ~/.sweech/launches.log so we can answer "what was launched, where, when,
 * with which profile and flags". This is separate from audit.log (which only
 * records --force overrides).
 *
 * Best-effort: any error is swallowed so logging never blocks a launch.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type LaunchSource = 'cli' | 'tui' | 'tmux';

export interface LaunchLogEntry {
  source: LaunchSource;
  profile: string;
  cliCommand: string;
  cliArgs: string[];
  configDir: string | null;
  cwd: string;
  resume: boolean;
  yolo: boolean;
  tmux: boolean;
  forced?: boolean;
}

export function logLaunch(entry: LaunchLogEntry): void {
  try {
    const dir = join(homedir(), '.sweech');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    });
    appendFileSync(join(dir, 'launches.log'), line + '\n');
  } catch {
    // best effort — never crash the launch
  }
}
