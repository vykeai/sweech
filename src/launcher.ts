/**
 * Interactive launcher TUI for sweech
 *
 * Arrow keys: select profile
 * y: toggle yolo mode
 * r: toggle resume last chat
 * Enter: launch
 */

import chalk from 'chalk';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager } from './config';
import { getProvider } from './providers';
import { getCLI } from './clis';

interface LaunchEntry {
  name: string;
  command: string;
  configDir: string | null;
  label: string;
  yoloFlag: string;
  sharedWith?: string;
  model?: string;
}

interface LaunchState {
  selectedIndex: number;
  yolo: boolean;
  resume: boolean;
}

const STATE_FILE = path.join(os.homedir(), '.sweech', 'last-launch.json');

function loadLastState(): LaunchState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { selectedIndex: 0, yolo: false, resume: false };
}

function saveState(state: LaunchState): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

function buildCommandPreview(entry: LaunchEntry, state: LaunchState): string {
  let cmd = entry.command;
  const args: string[] = [];

  if (state.yolo) args.push(entry.yoloFlag);
  if (state.resume) args.push('--continue');

  return `${cmd}${args.length ? ' ' + args.join(' ') : ''}`;
}

function render(entries: LaunchEntry[], state: LaunchState): void {
  const lines: string[] = [];

  lines.push(chalk.bold('🍭 Sweech'));
  lines.push('');

  entries.forEach((entry, i) => {
    const selected = i === state.selectedIndex;
    const pointer = selected ? chalk.cyan('❯') : ' ';
    const name = selected ? chalk.cyan.bold(entry.name) : chalk.white(entry.name);
    const sharedIndicator = entry.sharedWith ? chalk.gray(' [shared]') : '';
    const modelPart = entry.model ? chalk.gray(` · ${entry.model}`) : '';
    const label = chalk.gray(`(${entry.label}`) + modelPart + chalk.gray(')');
    lines.push(`${pointer} ${name}${sharedIndicator} ${label}`);
  });

  lines.push('');

  // Toggles
  const yoloBox = state.yolo ? chalk.red('[✓]') : chalk.gray('[ ]');
  const resumeBox = state.resume ? chalk.green('[✓]') : chalk.gray('[ ]');
  lines.push(`  ${yoloBox} ${chalk.white('yolo')} ${chalk.gray('(y)')}    ${resumeBox} ${chalk.white('resume')} ${chalk.gray('(r)')}`);

  lines.push('');

  // Command preview
  const entry = entries[state.selectedIndex];
  const preview = buildCommandPreview(entry, state);
  lines.push(chalk.gray('  → ') + chalk.bold.white(preview));

  lines.push('');
  lines.push(chalk.gray('  ↑↓ select  y yolo  r resume  ⏎ launch  q quit'));

  // Clear screen area and render
  const output = lines.join('\n');
  process.stdout.write(output);

  return;
}

export async function runLauncher(): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();

  const entries: LaunchEntry[] = [
    {
      name: 'claude',
      command: 'claude',
      configDir: null,
      label: 'default account',
      yoloFlag: getCLI('claude')?.yoloFlag || '--dangerously-skip-permissions'
    },
    ...profiles.map(p => {
      const cliType = p.cliType === 'codex' ? 'codex' : 'claude';
      const cli = getCLI(cliType);
      return {
        name: p.commandName,
        command: cliType,
        configDir: config.getProfileDir(p.commandName),
        label: getProvider(p.provider)?.displayName || p.provider,
        yoloFlag: cli?.yoloFlag || '--dangerously-skip-permissions',
        sharedWith: p.sharedWith,
        model: p.model
      };
    })
  ];

  const state = loadLastState();
  // Clamp index to valid range
  if (state.selectedIndex >= entries.length) {
    state.selectedIndex = 0;
  }

  // Set up raw mode for key input
  if (!process.stdin.isTTY) {
    console.error(chalk.red('Error: sweech launcher requires a TTY'));
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Track how many lines we rendered so we can clear them
  let lastLineCount = 0;

  const draw = () => {
    // Move up and clear previous render
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A`);
      for (let i = 0; i < lastLineCount; i++) {
        process.stdout.write('\x1b[2K\n');
      }
      process.stdout.write(`\x1b[${lastLineCount}A`);
    }

    // Count lines before rendering
    const entry = entries[state.selectedIndex];
    const totalLines = entries.length + 7; // header + spacers + toggles + preview + help
    lastLineCount = totalLines;

    render(entries, state);
  };

  // Initial render
  console.log(); // blank line before TUI
  draw();

  return new Promise((resolve) => {
    const onKeypress = (str: string | undefined, key: readline.Key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        console.log();
        process.exit(0);
      }

      if (key.name === 'up') {
        state.selectedIndex = (state.selectedIndex - 1 + entries.length) % entries.length;
        draw();
      } else if (key.name === 'down') {
        state.selectedIndex = (state.selectedIndex + 1) % entries.length;
        draw();
      } else if (str === 'y' || str === 'Y') {
        state.yolo = !state.yolo;
        draw();
      } else if (str === 'r' || str === 'R') {
        state.resume = !state.resume;
        draw();
      } else if (key.name === 'return') {
        cleanup();
        launch();
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const launch = () => {
      saveState(state);

      const entry = entries[state.selectedIndex];
      const preview = buildCommandPreview(entry, state);
      console.log(chalk.gray(`\n→ ${preview}\n`));

      const env = { ...process.env };
      const launchArgs: string[] = [];

      if (entry.configDir) {
        const cli = getCLI(entry.command === 'codex' ? 'codex' : 'claude');
        if (cli) {
          env[cli.configDirEnvVar] = entry.configDir;
        }
      }

      if (state.yolo) launchArgs.push(entry.yoloFlag);
      if (state.resume) launchArgs.push('--continue');

      const { spawnSync } = require('child_process');
      const result = spawnSync(entry.command, launchArgs, {
        env,
        stdio: 'inherit'
      });
      process.exit(result.status || 0);
    };

    process.stdin.on('keypress', onKeypress);
  });
}
