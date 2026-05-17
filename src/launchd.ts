import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { isMacOS } from './platform';

const PLIST_LABEL = 'ai.sweech.serve';
const PLIST_FILENAME = `${PLIST_LABEL}.plist`;
const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(PLIST_DIR, PLIST_FILENAME);
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'sweech-serve.log');

function findNodeBinary(): string {
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not find node binary. Checked: ' + candidates.join(', '));
}

function generatePlist(port: number): string {
  const nodeBin = findNodeBinary();
  const sweechScript = path.resolve(path.join(__dirname, '../dist/cli.js'));

  // T-054: the daemon rotates ~/Library/Logs/sweech-serve.log itself via
  // its LogRotator (size >10 MiB or daily, keep last 5). The plist still
  // redirects stdout/stderr to the same file — no newsyslog config required.
  // SWEECH_LOG_PATH is exported so the rotator and the redirect agree on
  // the path even if a future operator overrides it.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${sweechScript}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SWEECH_LOG_PATH</key>
    <string>${LOG_PATH}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`;
}

export function installLaunchd(port: number): void {
  if (!isMacOS()) {
    console.error(chalk.red('launchd is only available on macOS'));
    throw new Error('launchd is only available on macOS');
  }
  try {
    // T-LU-005: detect re-install so the operator gets explicit feedback
    // that the existing service is being unloaded before reload. Without
    // this, a repeat `sweech serve --install` looks like a silent no-op.
    const isReinstall = fs.existsSync(PLIST_PATH);
    if (isReinstall) {
      console.log(chalk.yellow(`Reinstalling ${PLIST_LABEL} — unloading existing service first`));
    }

    const plistContent = generatePlist(port);

    fs.mkdirSync(PLIST_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(PLIST_PATH, plistContent, 'utf-8');
    console.log(chalk.green(`Wrote plist to ${PLIST_PATH}`));

    try {
      execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    } catch {
      // Ignore — may not be loaded yet
    }

    execSync(`launchctl load "${PLIST_PATH}"`);
    console.log(chalk.green(`Loaded ${PLIST_LABEL} via launchctl`));
    console.log(chalk.gray(`Logs: ${LOG_PATH}`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to install launchd service: ${msg}`));
    throw err;
  }
}

export function uninstallLaunchd(): void {
  if (!isMacOS()) {
    console.error(chalk.red('launchd is only available on macOS'));
    throw new Error('launchd is only available on macOS');
  }
  try {
    if (!fs.existsSync(PLIST_PATH)) {
      console.error(chalk.yellow(`Plist not found at ${PLIST_PATH} — nothing to uninstall`));
      return;
    }

    try {
      execSync(`launchctl unload "${PLIST_PATH}"`);
      console.log(chalk.green(`Unloaded ${PLIST_LABEL} via launchctl`));
    } catch {
      console.error(chalk.yellow(`launchctl unload failed — service may not be loaded`));
    }

    fs.unlinkSync(PLIST_PATH);
    console.log(chalk.green(`Removed ${PLIST_PATH}`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Failed to uninstall launchd service: ${msg}`));
    throw err;
  }
}

export function isLaunchdInstalled(): boolean {
  return fs.existsSync(PLIST_PATH);
}

/**
 * T-LU-005: surface the launchd service's actual runtime state, not just
 * whether the plist file exists on disk. `isLaunchdInstalled()` only checks
 * file presence, which is insufficient for doctor and shell scripting —
 * the service may be installed but stopped (KeepAlive crash-looping, or
 * manually unloaded by the operator).
 *
 * Parses the legacy `launchctl list <label>` plist-dict output:
 *   - Exit code != 0       → not loaded (treated as !installed)
 *   - Output has "PID" key → installed + running
 *   - Otherwise            → installed, not running
 *
 * `installed` here means "loaded into launchd" (not just plist on disk).
 * The doctor row should combine this with `isLaunchdInstalled()` to detect
 * the "plist exists but not loaded" edge case.
 */
export interface LaunchdStatus {
  /** True if the service is currently loaded into launchd. */
  installed: boolean;
  /** True if the service is loaded AND has an active PID. */
  running: boolean;
  /** Active PID if running, otherwise undefined. */
  pid?: number;
}

export function isLaunchdRunning(): LaunchdStatus {
  if (!isMacOS()) {
    return { installed: false, running: false };
  }
  let output: string;
  try {
    output = execSync(`launchctl list ${PLIST_LABEL} 2>/dev/null`, { encoding: 'utf-8' });
  } catch {
    // Non-zero exit (typically 113 "Could not find service") means the
    // service is not loaded into launchd.
    return { installed: false, running: false };
  }
  // Parse `"PID" = 81054;` — when absent, the service is loaded but not
  // currently running (e.g. KeepAlive cooldown after a crash).
  const pidMatch = output.match(/"PID"\s*=\s*(\d+)\s*;/);
  if (pidMatch) {
    const pid = parseInt(pidMatch[1], 10);
    return { installed: true, running: true, pid };
  }
  return { installed: true, running: false };
}

/** T-LU-005: exposed for tests + cli --status so the row text matches. */
export const LAUNCHD_LABEL = PLIST_LABEL;
export const LAUNCHD_PLIST_PATH = PLIST_PATH;
export const LAUNCHD_LOG_PATH = LOG_PATH;
