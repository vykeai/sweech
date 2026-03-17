/**
 * Interactive launcher TUI for sweech
 */

import chalk from 'chalk';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager } from './config';
import { getProvider } from './providers';
import { getCLI, SUPPORTED_CLIS } from './clis';
import { getAccountInfo, type AccountInfo } from './subscriptions';

interface UsageBar {
  label: string;
  pct: number;           // 0–100 used
  resetLabel: string;    // e.g. "resets in 3h 17m"
  resetsAt?: number;     // epoch seconds
  windowMins: number;    // 300 (5h) or 10080 (7d)
}

interface LaunchEntry {
  name: string;
  command: string;
  configDir: string | null;
  label: string;
  yoloFlag: string;
  resumeFlag: string;
  sharedWith?: string;
  model?: string;
  isDefault: boolean;
  // Stats
  dataDir: string;
  dataSizeMB: string;
  authType: string;
  needsReauth: boolean;
  lastActive: string;
  bars: UsageBar[];     // session, all models, sonnet only
}

interface LaunchState {
  selectedIndex: number;
  yolo: boolean;
  resume: boolean;
  usage: boolean;
}

type UsageLoadState = 'idle' | 'loading' | 'loaded' | 'error';

const STATE_FILE = path.join(os.homedir(), '.sweech', 'last-launch.json');

function loadLastState(): LaunchState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { selectedIndex: 0, yolo: false, resume: false, usage: false };
}

function saveState(state: LaunchState): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

function buildCommandPreview(entry: LaunchEntry, state: LaunchState): string {
  const args: string[] = [];
  if (state.yolo) args.push(entry.yoloFlag);
  if (state.resume) args.push(entry.resumeFlag);
  return `${entry.name}${args.length ? ' ' + args.join(' ') : ''}`;
}

function getDirSize(dir: string): string {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`du -sh "${dir}" 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
    return out.split('\t')[0].trim();
  } catch {
    return '?';
  }
}

/**
 * Render a usage bar colored by burn rate — how fast you're using
 * relative to how much time has elapsed in the window.
 *
 * Green: on pace or under  |  Yellow: burning faster than sustainable  |  Red: will hit limit
 */
function renderBar(pct: number, width: number, ub: UsageBar): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const free = Math.max(0, 100 - pct);
  const usedStr = `${pct}%`;
  const freeStr = chalk.dim(`${free}%`);

  // At limit → always red
  if (pct >= 100) return chalk.red(usedStr) + ' ' + chalk.red(bar) + ' ' + freeStr;
  // Nothing used → green
  if (pct === 0) return chalk.dim(usedStr) + ' ' + chalk.green(bar) + ' ' + chalk.green(freeStr);

  // Calculate what % of the window has elapsed
  let elapsed = 0.5;
  if (ub.resetsAt && ub.windowMins > 0) {
    const now = Date.now() / 1000;
    const windowSec = ub.windowMins * 60;
    const windowStartSec = ub.resetsAt - windowSec;
    elapsed = Math.max(0, Math.min(1, (now - windowStartSec) / windowSec));
  }

  // Burn ratio: usage% / elapsed%
  const usageFrac = pct / 100;
  const ratio = elapsed > 0.01 ? usageFrac / elapsed : (usageFrac > 0 ? 10 : 0);

  const isWeekly = ub.windowMins > 1000;
  const warnThreshold = isWeekly ? 1.1 : 1.3;
  const dangerThreshold = isWeekly ? 1.5 : 2.0;

  if (ratio >= dangerThreshold || pct >= 90) {
    return chalk.red(usedStr) + ' ' + chalk.red(bar) + ' ' + freeStr;
  }
  if (ratio >= warnThreshold || pct >= 70) {
    return chalk.yellow(usedStr) + ' ' + chalk.yellow(bar) + ' ' + freeStr;
  }
  return chalk.dim(usedStr) + ' ' + chalk.green(bar) + ' ' + chalk.green(freeStr);
}

function formatReset(epochSec: number | undefined): string {
  if (!epochSec) return '';
  const diff = epochSec * 1000 - Date.now();
  if (diff <= 0) return 'resetting...';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `resets in ${hours}h ${remMins}m`;
  // Show day + time
  const d = new Date(epochSec * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `resets ${days[d.getDay()]} ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function resolveAuthType(account: AccountInfo, command: string): string {
  // Claude accounts — check rateLimitTier (from Keychain or .credentials.json)
  if (command !== 'codex') {
    if (account.rateLimitTier) {
      const tier = account.rateLimitTier;
      if (tier.includes('max_20x')) return 'Max 20x';
      if (tier.includes('max_5x')) return 'Max 5x';
      if (tier.includes('max')) return 'Max';
      if (tier.includes('pro')) return 'Pro';
    }
    if (account.billingType === 'max') return 'Max';
    if (account.billingType === 'stripe_subscription') return 'Subscription';
    if (account.billingType) return account.billingType;
    if (account.meta?.plan) return account.meta.plan;
    return 'Subscription';
  }
  // Codex accounts — use planType from live data (app-server), fallback to auth.json
  const livePlan = account.live?.planType;
  if (livePlan) {
    const label = livePlan.charAt(0).toUpperCase() + livePlan.slice(1);
    return `ChatGPT ${label}`; // "ChatGPT Pro", "ChatGPT Plus"
  }
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(account.configDir, 'auth.json'), 'utf-8'));
    if (auth.auth_mode === 'chatgpt') return 'ChatGPT';
    if (auth.OPENAI_API_KEY) return 'API Key';
  } catch {}
  return 'Subscription';
}

function buildEntry(
  name: string, command: string, configDir: string | null, label: string,
  yoloFlag: string, resumeFlag: string, isDefault: boolean, account: AccountInfo,
  opts?: { sharedWith?: string; model?: string }
): LaunchEntry {
  const dataDir = account.configDir;
  const lastActive = account.lastActive ? timeAgo(account.lastActive) : '';

  // Build usage bars from buckets
  const bars: UsageBar[] = [];
  const live = account.live;
  if (live?.buckets) {
    for (const bucket of live.buckets) {
      // Shorten long model names for display
      let label = bucket.label;
      if (label.length > 14) {
        label = label.replace('GPT-5.3-Codex-', '').replace('GPT-', '');
      }

      if (bucket.session) {
        bars.push({
          label: `${label} 5h`,
          pct: Math.round(bucket.session.utilization * 100),
          resetLabel: formatReset(bucket.session.resetsAt),
          resetsAt: bucket.session.resetsAt,
          windowMins: 300,
        });
      }
      if (bucket.weekly) {
        bars.push({
          label: `${label} 7d`,
          pct: Math.round(bucket.weekly.utilization * 100),
          resetLabel: formatReset(bucket.weekly.resetsAt),
          resetsAt: bucket.weekly.resetsAt,
          windowMins: 10080,
        });
      }
    }
  }

  return {
    name, command, configDir, label, yoloFlag, resumeFlag, isDefault,
    sharedWith: opts?.sharedWith,
    model: opts?.model,
    dataDir,
    dataSizeMB: getDirSize(dataDir),
    authType: resolveAuthType(account, command),
    needsReauth: account.needsReauth || false,
    lastActive,
    bars,
  };
}

function render(entries: LaunchEntry[], state: LaunchState, usageLoad: UsageLoadState = 'idle'): string[] {
  const lines: string[] = [];
  const W = 56; // frame width

  lines.push(chalk.bold('🍭 Sweech') + chalk.dim('  —  ↑↓ to select, ⏎ to launch'));
  lines.push('');

  // Group entries by CLI type, render with section headers
  let lastCliType = '';
  entries.forEach((entry, i) => {
    const cliType = entry.command === 'codex' ? 'codex' : 'claude';
    if (cliType !== lastCliType) {
      const cliLabel = cliType === 'codex' ? 'Codex (OpenAI)' : 'Claude (Anthropic)';
      lines.push(chalk.dim(`  ── ${cliLabel} ${'─'.repeat(Math.max(0, 42 - cliLabel.length))}`));
      lines.push('');
      lastCliType = cliType;
    }
    const selected = i === state.selectedIndex;

    // Tags
    const authBadge = entry.authType ? ` [${entry.authType}]` : '';
    const sharedBadge = entry.sharedWith ? ` [shared ↔ ${entry.sharedWith}]` : '';
    const reauthBadge = entry.needsReauth ? ' ⚠ re-auth' : '';

    // Provider line
    const providerStr = entry.isDefault
      ? (entry.command === 'codex' ? 'OpenAI' : 'Anthropic')
      : entry.label;
    const modelStr = entry.model ? ` · ${entry.model}` : '';
    const dirStr = entry.dataDir.replace(os.homedir(), '~');
    const lastStr = entry.lastActive ? ` · last: ${entry.lastActive}` : '';
    const infoLine = `${providerStr}${modelStr} · ${dirStr} · ${entry.dataSizeMB}${lastStr}`;

    if (selected) {
      // ── Framed selected entry ──
      lines.push(chalk.yellowBright(`  ┏${'━'.repeat(W)}┓`));
      lines.push(chalk.yellowBright('  ┃ ') + chalk.yellowBright.bold(entry.name) + chalk.yellowBright(authBadge) + (sharedBadge ? chalk.magenta(sharedBadge) : '') + (reauthBadge ? chalk.red(reauthBadge) : ''));
      lines.push(chalk.yellowBright('  ┃ ') + chalk.gray(infoLine));

      if (state.usage) {
        const BAR_WIDTH = 20;
        if (usageLoad === 'loading') {
          lines.push(chalk.yellowBright('  ┃ ') + chalk.dim('fetching usage...'));
        } else if (usageLoad === 'error') {
          lines.push(chalk.yellowBright('  ┃ ') + chalk.red('usage unavailable'));
        } else {
          const maxBars = 4;
          for (let b = 0; b < maxBars; b++) {
            if (b < entry.bars.length) {
              const ub = entry.bars[b];
              const label = ub.label.padEnd(14);
              const barStr = renderBar(ub.pct, BAR_WIDTH, ub);
              const reset = ub.resetLabel ? chalk.dim(`  ${ub.resetLabel}`) : '';
              lines.push(chalk.yellowBright('  ┃ ') + chalk.gray(`${label} `) + barStr + reset);
            } else if (entry.bars.length === 0 && b === 0) {
              lines.push(chalk.yellowBright('  ┃ ') + chalk.dim('no live usage data'));
            } else {
              lines.push(chalk.yellowBright('  ┃'));
            }
          }
        }
      }

      lines.push(chalk.yellowBright(`  ┗${'━'.repeat(W)}┛`));
    } else {
      // ── Unselected entry ──
      lines.push(chalk.dim('  │ ') + chalk.bold.white(entry.name) + chalk.dim(authBadge) + (sharedBadge ? chalk.magenta(sharedBadge) : '') + (reauthBadge ? chalk.red(reauthBadge) : ''));
      lines.push(chalk.dim('  │ ') + chalk.gray(infoLine));

      if (state.usage) {
        const BAR_WIDTH = 20;
        if (usageLoad === 'loading') {
          lines.push(chalk.dim('  │ ') + chalk.dim('fetching...'));
        } else if (usageLoad !== 'error') {
          const maxBars = 4;
          for (let b = 0; b < maxBars; b++) {
            if (b < entry.bars.length) {
              const ub = entry.bars[b];
              const label = ub.label.padEnd(14);
              const barStr = renderBar(ub.pct, BAR_WIDTH, ub);
              const reset = ub.resetLabel ? chalk.dim(`  ${ub.resetLabel}`) : '';
              lines.push(chalk.dim('  │ ') + chalk.gray(`${label} `) + barStr + reset);
            } else if (entry.bars.length === 0 && b === 0) {
              lines.push(chalk.dim('  │ ') + chalk.dim('no live usage data'));
            } else {
              lines.push(chalk.dim('  │'));
            }
          }
        }
      }
    }
    lines.push('');
  });

  // Separator + toggles
  lines.push(chalk.dim('  ─────────────────────────────────────────────────'));
  lines.push('');

  const yoloBox = state.yolo ? chalk.red('[✓]') : chalk.gray('[ ]');
  const resumeBox = state.resume ? chalk.green('[✓]') : chalk.gray('[ ]');
  const usageLabel = usageLoad === 'loading'
    ? chalk.dim('loading...')
    : usageLoad === 'loaded' && state.usage
      ? chalk.yellow('usage')
      : chalk.dim('usage');
  lines.push(`  ${yoloBox} ${chalk.white('yolo')} ${chalk.dim('(y)')}    ${resumeBox} ${chalk.white('resume')} ${chalk.dim('(r)')}    ${usageLabel} ${chalk.dim('(u)')}`);

  if (state.usage && usageLoad === 'loaded') {
    lines.push('');
    lines.push(chalk.dim('  Bars show burn rate: ') + chalk.green('green') + chalk.dim(' = on pace  ') + chalk.yellow('yellow') + chalk.dim(' = ahead  ') + chalk.red('red') + chalk.dim(' = will hit limit'));
  }

  lines.push('');

  // Command preview
  const entry = entries[state.selectedIndex];
  const preview = buildCommandPreview(entry, state);
  lines.push(chalk.white('  → ') + chalk.bold.cyan(preview));
  lines.push('');

  // Shortcuts
  const key = (k: string) => chalk.bold.white(k);
  const desc = (d: string) => chalk.dim(d);
  lines.push(`  ${key('↑↓')} ${desc('select')}   ${key('y')} ${desc('yolo')}   ${key('r')} ${desc('resume')}   ${key('u')} ${desc('usage')}   ${key('⏎')} ${desc('launch')}   ${key('q')} ${desc('quit')}`);
  lines.push(`  ${key('a')}  ${desc('add')}      ${key('e')} ${desc('edit')}`);

  process.stdout.write(lines.join('\n'));
  return lines;
}

/** Build a placeholder entry from static data only — no I/O, instant. */
function buildStaticEntry(
  name: string, command: string, configDir: string | null, label: string,
  yoloFlag: string, resumeFlag: string, isDefault: boolean,
  opts?: { sharedWith?: string; model?: string }
): LaunchEntry {
  const dataDir = configDir ?? path.join(os.homedir(), `.${name}`);
  return {
    name, command, configDir, label, yoloFlag, resumeFlag, isDefault,
    sharedWith: opts?.sharedWith,
    model: opts?.model,
    dataDir,
    dataSizeMB: '',
    authType: '',
    needsReauth: false,
    lastActive: '',
    bars: [],
  };
}

export async function runLauncher(): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const { execFileSync } = require('child_process');

  // ── Build entries instantly from static data (no I/O) ──────────────────────
  const accountList: Array<{ name: string; commandName: string; command: string; isDefault: boolean }> = [];
  for (const cli of Object.values(SUPPORTED_CLIS)) {
    try {
      execFileSync('which', [cli.command], { stdio: 'ignore' });
      accountList.push({ name: cli.command, commandName: cli.name, command: cli.command, isDefault: true });
    } catch {}
  }
  for (const p of profiles) {
    const cliType = p.cliType === 'codex' ? 'codex' : 'claude';
    accountList.push({ name: p.name || p.commandName, commandName: p.commandName, command: cliType, isDefault: false });
  }

  const unsorted: LaunchEntry[] = accountList.map(a => {
    const cli = getCLI(a.command);
    if (a.isDefault) {
      return buildStaticEntry(
        a.command, a.command, null, 'default',
        cli?.yoloFlag || '--dangerously-skip-permissions',
        cli?.resumeFlag || '--continue',
        true
      );
    }
    const profile = profiles.find(p => p.commandName === a.commandName)!;
    return buildStaticEntry(
      profile.commandName, a.command, config.getProfileDir(profile.commandName),
      getProvider(profile.provider)?.displayName || profile.provider,
      cli?.yoloFlag || '--dangerously-skip-permissions',
      cli?.resumeFlag || '--continue',
      false,
      { sharedWith: profile.sharedWith, model: profile.model }
    );
  });

  const entries: LaunchEntry[] = [
    ...unsorted.filter(e => e.command !== 'codex' && e.isDefault),
    ...unsorted.filter(e => e.command !== 'codex' && !e.isDefault),
    ...unsorted.filter(e => e.command === 'codex' && e.isDefault),
    ...unsorted.filter(e => e.command === 'codex' && !e.isDefault),
  ];

  const state = loadLastState();
  state.usage = false; // always start with usage hidden
  if (state.selectedIndex >= entries.length) state.selectedIndex = 0;

  if (!process.stdin.isTTY) {
    console.error(chalk.red('Error: sweech launcher requires a TTY'));
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let usageLoad: UsageLoadState = 'idle';

  const draw = () => {
    // Move to top-left and clear to end of screen — works in alternate buffer
    process.stdout.write('\x1b[H\x1b[J');
    render(entries, state, usageLoad);
  };

  /** Fetch usage data async, patch entries in-place, redraw. */
  const fetchUsage = () => {
    if (usageLoad === 'loading' || usageLoad === 'loaded') return;
    usageLoad = 'loading';
    draw();

    getAccountInfo(accountList.map(a => ({ name: a.name, commandName: a.commandName })))
      .then(accounts => {
        const accountMap = new Map(accounts.map(a => [a.commandName, a]));
        for (const entry of entries) {
          const account = accountMap.get(entry.name);
          if (!account) continue;
          entry.lastActive = account.lastActive ? timeAgo(account.lastActive) : '';
          entry.needsReauth = account.needsReauth || false;
          entry.authType = resolveAuthType(account, entry.command);
          entry.dataSizeMB = getDirSize(entry.dataDir);
          // Rebuild bars
          entry.bars = [];
          const live = account.live;
          if (live?.buckets) {
            for (const bucket of live.buckets) {
              let lbl = bucket.label;
              if (lbl.length > 14) lbl = lbl.replace('GPT-5.3-Codex-', '').replace('GPT-', '');
              if (bucket.session) {
                entry.bars.push({
                  label: `${lbl} 5h`,
                  pct: Math.round(bucket.session.utilization * 100),
                  resetLabel: formatReset(bucket.session.resetsAt),
                  resetsAt: bucket.session.resetsAt,
                  windowMins: 300,
                });
              }
              if (bucket.weekly) {
                entry.bars.push({
                  label: `${lbl} 7d`,
                  pct: Math.round(bucket.weekly.utilization * 100),
                  resetLabel: formatReset(bucket.weekly.resetsAt),
                  resetsAt: bucket.weekly.resetsAt,
                  windowMins: 10080,
                });
              }
            }
          }
        }
        usageLoad = 'loaded';
        draw();
      })
      .catch(() => {
        usageLoad = 'error';
        draw();
      });
  };

  // Enter alternate screen + hide cursor — no more scroll jumping
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  draw();

  return new Promise((resolve) => {
    const onKeypress = (str: string | undefined, key: readline.Key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup(); process.exit(0);
      }
      if (key.name === 'up') {
        state.selectedIndex = (state.selectedIndex - 1 + entries.length) % entries.length;
        draw();
      } else if (key.name === 'down') {
        state.selectedIndex = (state.selectedIndex + 1) % entries.length;
        draw();
      } else if (str === 'y' || str === 'Y') {
        state.yolo = !state.yolo; draw();
      } else if (str === 'r' || str === 'R') {
        state.resume = !state.resume; draw();
      } else if (str === 'u' || str === 'U') {
        if (usageLoad === 'idle') {
          // First press: start fetch and show
          state.usage = true;
          fetchUsage();
        } else if (usageLoad === 'loaded') {
          // Subsequent presses: toggle visibility
          state.usage = !state.usage;
          draw();
        }
        // If loading: ignore (already in progress)
      } else if (str === 'a' || str === 'A') {
        cleanup(); runSubcommand('add');
      } else if (str === 'e' || str === 'E') {
        if (entries[state.selectedIndex].isDefault) return;
        cleanup(); runSubcommand('edit', entries[state.selectedIndex].name);
      } else if (key.name === 'return') {
        cleanup(); launch();
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Leave alternate screen + restore cursor
      process.stdout.write('\x1b[?1049l\x1b[?25h');
    };

    const runSubcommand = (cmd: string, arg?: string) => {
      cleanup();
      saveState(state);
      const { spawnSync } = require('child_process');
      const args = [process.argv[1], cmd];
      if (arg) args.push(arg);
      spawnSync(process.argv[0], args, { stdio: 'inherit' });
      spawnSync(process.argv[0], [process.argv[1]], { stdio: 'inherit' });
      process.exit(0);
    };

    const launch = () => {
      cleanup();
      saveState(state);
      const entry = entries[state.selectedIndex];
      const preview = buildCommandPreview(entry, state);
      console.log(chalk.gray(`→ ${preview}\n`));

      const env = { ...process.env };
      const launchArgs: string[] = [];
      if (entry.configDir) {
        const cli = getCLI(entry.command === 'codex' ? 'codex' : 'claude');
        if (cli) env[cli.configDirEnvVar] = entry.configDir;
      }
      if (state.yolo) launchArgs.push(entry.yoloFlag);
      if (state.resume) launchArgs.push(...entry.resumeFlag.split(' '));

      const { spawnSync } = require('child_process');
      const result = spawnSync(entry.command, launchArgs, { env, stdio: 'inherit' });
      process.exit(result.status || 0);
    };

    process.stdin.on('keypress', onKeypress);
  });
}
