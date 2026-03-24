import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import chalk from 'chalk';

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
  try {
    const plistContent = generatePlist(port);

    fs.mkdirSync(PLIST_DIR, { recursive: true });
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
