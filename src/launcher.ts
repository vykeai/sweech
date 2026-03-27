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
import { appendSnapshot, allAccountSparklines } from './usageHistory';
import { sweechEvents } from './events';
import { runHook } from './plugins';

interface UsageBar {
  label: string;
  pct: number;           // 0–100 used
  resetLabel: string;    // e.g. "resets in 3h 17m"
  resetsAt?: number;     // epoch seconds
  windowMins: number;    // 300 (5h) or 10080 (7d)
  bucketGroup?: string;  // bucket label — used to render separators between groups
}

export interface LaunchEntry {
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
  /** OAuth token status: "valid" | "refreshed" | "expired" | "no_token" */
  tokenStatus?: string;
  /** Token expiry time (ms epoch) */
  tokenExpiresAt?: number;
  /** Active promotion info */
  promotion?: { label: string; multiplier?: number; expiresAt?: number };
}

export interface LaunchState {
  selectedIndex: number;
  yolo: boolean;
  resume: boolean;
  usage: boolean;
  sortMode: 'smart' | 'status' | 'manual';
  grouped: boolean;
  extraBuckets?: boolean;
  showHistory?: boolean;
  helpVisible?: boolean;
}

export type UsageLoadState = 'idle' | 'loading' | 'loaded' | 'error';

const STATE_FILE = path.join(os.homedir(), '.sweech', 'last-launch.json');

function loadLastState(): LaunchState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { selectedIndex: 0, yolo: false, resume: false, usage: false, sortMode: 'smart', grouped: true };
}

function saveState(state: LaunchState): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

export function buildCommandPreview(entry: LaunchEntry, state: LaunchState): string {
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
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  const empty = Math.max(0, width - filled);
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

function formatReset(epochSec: number | undefined, windowMins = 0): string {
  if (!epochSec) return '';
  const diff = epochSec * 1000 - Date.now();
  if (diff <= 0) return chalk.red('resetting...');
  const mins = Math.floor(diff / 60000);
  const isSession = windowMins <= 300; // 5h window
  // Urgency coloring — only for session (5h) window, weekly resets are rarely urgent
  if (isSession) {
    if (mins < 30)  return chalk.red(`resets in ${mins}m`);
    if (mins < 120) return chalk.yellow(`resets in ${mins}m`);
  }
  if (mins < 60) return chalk.cyan(`resets in ${mins}m`);
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return chalk.cyan(`resets in ${hours}h ${remMins}m`);
  // Show day + time
  const d = new Date(epochSec * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return chalk.dim(`resets ${days[d.getDay()]} ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`);
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

export function resolveAuthType(account: AccountInfo, command: string): string {
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

export function buildEntry(
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
          resetLabel: formatReset(bucket.session.resetsAt, 300),
          resetsAt: bucket.session.resetsAt,
          windowMins: 300,
        });
      }
      if (bucket.weekly) {
        bars.push({
          label: `${label} 7d`,
          pct: Math.round(bucket.weekly.utilization * 100),
          resetLabel: formatReset(bucket.weekly.resetsAt, 10080),
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
    tokenStatus: account.tokenStatus,
    tokenExpiresAt: account.tokenExpiresAt,
    promotion: account.live?.promotion,
  };
}

export function entrySmartScore(e: LaunchEntry): number {
  if (e.needsReauth) return -2;
  // Use "All models" bucket for scoring (matches SweechBar which uses legacy utilization7d)
  const bar5h = e.bars.find(b => b.windowMins === 300 && b.label.startsWith('All models'))
    || e.bars.find(b => b.windowMins === 300);
  if (bar5h && bar5h.pct >= 100) return -1;
  const bar7d = e.bars.find(b => b.windowMins === 10080 && b.label.startsWith('All models'))
    || e.bars.find(b => b.windowMins === 10080);
  if (!bar7d) return bar5h ? (100 - bar5h.pct) / 100 : 0;
  const remaining7d = (100 - bar7d.pct) / 100;
  // No reset time = no expiry urgency; treat as if reset is in 7d (the full window)
  if (!bar7d.resetsAt) return remaining7d / 7;
  const hoursLeft = Math.max(0.5, (bar7d.resetsAt - Date.now() / 1000) / 3600);
  const daysLeft = hoursLeft / 24;
  const baseScore = remaining7d / daysLeft;
  // Tier boost: profiles with expiring capacity (resets < 3d, > 10% left) always
  // rank above non-expiring ones — "don't waste what resets soonest"
  if (hoursLeft < 72 && remaining7d > 0) return 100 + baseScore;
  return baseScore;
}

export function sortedWithinGroup(list: LaunchEntry[], mode: string): LaunchEntry[] {
  if (mode === 'manual') return list;
  if (mode === 'status') {
    return [...list].sort((a, b) => {
      const score = (e: LaunchEntry) => e.needsReauth ? -2 : e.bars.some(b => b.windowMins === 300 && b.pct >= 100) ? -1 : 0;
      return score(b) - score(a);
    });
  }
  return [...list].sort((a, b) => entrySmartScore(b) - entrySmartScore(a));
}

export function getSorted(allEntries: LaunchEntry[], mode: string, grouped: boolean = true): LaunchEntry[] {
  if (!grouped) {
    return sortedWithinGroup(allEntries, mode);
  }
  const claude = allEntries.filter(e => e.command !== 'codex');
  const codex  = allEntries.filter(e => e.command === 'codex');
  return [...sortedWithinGroup(claude, mode), ...sortedWithinGroup(codex, mode)];
}

export function expiryAlert(e: LaunchEntry): string {
  const bar7d = e.bars.find(b => b.windowMins === 10080 && b.label.startsWith('All models'))
    || e.bars.find(b => b.windowMins === 10080);
  if (!bar7d?.resetsAt) return '';
  const hoursLeft = (bar7d.resetsAt - Date.now() / 1000) / 3600;
  const remaining = (100 - bar7d.pct) / 100;
  if (remaining <= 0 || hoursLeft <= 0 || hoursLeft >= 72) return '';
  const pct = Math.round(remaining * 100);
  const label = hoursLeft < 24 ? `${Math.round(hoursLeft)}h` : `${Math.floor(hoursLeft / 24)}d`;
  return chalk.cyan(` ⚡ ${pct}% expiring in ${label}`);
}

export interface RenderResult {
  header: string[];
  body: string[];
  footer: string[];
  /** Line index within body where each entry starts (by entry index) */
  entryStartLines: number[];
}

export function render(entries: LaunchEntry[], state: LaunchState, usageLoad: UsageLoadState = 'idle'): RenderResult {
  const header: string[] = [];
  const body: string[] = [];
  const footer: string[] = [];
  const entryStartLines: number[] = [];
  const W = 56; // frame width

  // ── Help overlay ──
  if (state.helpVisible) {
    const k = (s: string) => chalk.bold.white(s.padEnd(10));
    const d = (s: string) => chalk.dim(s);
    header.push('');
    header.push(chalk.bold('  ── Keyboard Shortcuts ──'));
    header.push('');
    body.push(`  ${k('↑↓')}${d('Select profile')}`);
    body.push(`  ${k('Enter')}${d('Launch selected profile')}`);
    body.push(`  ${k('y')}${d('Toggle yolo mode (skip permissions)')}`);
    body.push(`  ${k('r')}${d('Toggle resume (continue last session)')}`);
    body.push(`  ${k('u')}${d('Force-refresh usage data')}`);
    body.push(`  ${k('s')}${d('Cycle sort mode (smart → status → manual)')}`);
    body.push(`  ${k('g')}${d('Toggle grouping (by provider / flat)')}`);
    body.push(`  ${k('m')}${d('Toggle model bucket display')}`);
    body.push(`  ${k('h')}${d('Toggle 24h sparkline history')}`);
    body.push(`  ${k('a')}${d('Add new profile')}`);
    body.push(`  ${k('e')}${d('Edit selected profile')}`);
    body.push(`  ${k('?')}${d('Toggle this help')}`);
    body.push(`  ${k('q/Esc')}${d('Quit')}`);
    body.push('');
    footer.push(chalk.dim('  Press ? to close'));
    return { header, body, footer, entryStartLines };
  }

  // ── Header (pinned top) ──
  const sortLabel = state.sortMode === 'smart'
    ? chalk.cyan.bold('⚡smart')
    : state.sortMode === 'status'
      ? chalk.dim('status')
      : chalk.dim('manual');
  const groupLabel = state.grouped ? 'on' : 'off';
  header.push(chalk.bold('🍭 Sweech') + chalk.dim('  —  ↑↓ select  ') + `s:${sortLabel}` + chalk.dim(`  g:${groupLabel}  ⏎ launch`));
  if (state.sortMode === 'smart') {
    header.push(chalk.dim('  prioritises expiring weekly usage — don\'t waste what resets soonest'));
  }
  header.push(chalk.dim('  ─────────────────────────────────────────────────'));

  // "use first" badge: only meaningful in smart sort (in other modes rank-0 is arbitrary)
  const useFirstSet = new Set<LaunchEntry>();
  if (state.sortMode === 'smart') {
    if (state.grouped) {
      const claudeGroup = entries.filter(e => e.command !== 'codex');
      const codexGroup  = entries.filter(e => e.command === 'codex');
      if (claudeGroup[0] && entrySmartScore(claudeGroup[0]) >= 0) useFirstSet.add(claudeGroup[0]);
      if (codexGroup[0]  && entrySmartScore(codexGroup[0])  >= 0) useFirstSet.add(codexGroup[0]);
    } else {
      if (entries[0] && entrySmartScore(entries[0]) >= 0) useFirstSet.add(entries[0]);
    }
  }

  // ── Body (scrollable entries) ──
  let lastCliType = '';
  entries.forEach((entry, i) => {
    entryStartLines.push(body.length);
    const cliType = entry.command === 'codex' ? 'codex' : 'claude';
    if (state.grouped && cliType !== lastCliType) {
      const cliLabel = cliType === 'codex' ? 'Codex (OpenAI)' : 'Claude (Anthropic)';
      body.push(chalk.dim(`  ── ${cliLabel} ${'─'.repeat(Math.max(0, 42 - cliLabel.length))}`));
      body.push('');
      lastCliType = cliType;
    }
    const selected = i === state.selectedIndex;

    // Tags
    const authBadge = entry.authType ? ` [${entry.authType}]` : '';
    const sharedBadge = entry.sharedWith ? ` [shared ↔ ${entry.sharedWith}]` : '';
    const reauthBadge = entry.needsReauth ? ' ⚠ re-auth' : '';
    const hasData = usageLoad === 'loaded' || usageLoad === 'loading';
    const expiryStr = hasData ? expiryAlert(entry) : '';
    const useFirstBadge = hasData && useFirstSet.has(entry) && !expiryStr
      ? chalk.cyan(' ⚡ use first') : '';

    // Token status indicator
    let tokenStr = '';
    if (entry.tokenStatus === 'refreshed') {
      tokenStr = chalk.green(' 🔑 token ok');
    } else if (entry.tokenStatus === 'expired') {
      tokenStr = chalk.red(' 🔑 expired');
    } else if (entry.tokenStatus === 'valid' && entry.tokenExpiresAt) {
      const hoursLeft = Math.max(0, (entry.tokenExpiresAt - Date.now()) / 3600000);
      if (hoursLeft < 1) {
        tokenStr = chalk.yellow(` 🔑 expires in ${Math.round(hoursLeft * 60)}m`);
      } else if (hoursLeft < 24) {
        tokenStr = chalk.dim(` 🔑 expires in ${Math.round(hoursLeft)}h`);
      } else {
        tokenStr = chalk.dim(' 🔑 token ok');
      }
    } else if (entry.tokenStatus === 'no_token' && entry.command !== 'codex') {
      tokenStr = chalk.dim(' 🔑 no token');
    }

    // Promotion badge
    let promoStr = '';
    const promo = entry.bars.length > 0 ? (entry as any).promotion : undefined;
    if (promo) {
      const expiryLabel = promo.expiresAt
        ? (() => { const h = Math.max(0, (promo.expiresAt - Date.now()) / 3600000); return h < 24 ? ` · ${Math.round(h)}h left` : ` · ${Math.floor(h/24)}d left`; })()
        : '';
      promoStr = chalk.bgCyan.black(` ${promo.label} `) + chalk.cyan(expiryLabel);
    }

    // Provider line
    const providerStr = entry.isDefault
      ? (entry.command === 'codex' ? 'OpenAI' : 'Anthropic')
      : entry.label;
    const modelStr = entry.model ? ` · ${entry.model}` : '';
    const dirStr = entry.dataDir.replace(os.homedir(), '~');
    const lastStr = entry.lastActive ? ` · last: ${entry.lastActive}` : '';
    const infoLine = `${providerStr}${modelStr} · ${dirStr} · ${entry.dataSizeMB}${lastStr}`;

    /** Render usage bars for an entry with weekly emphasis and bucket separators. */
    const renderBars = (entry: LaunchEntry, prefix: string) => {
      const BAR_WIDTH = 20;
      if (usageLoad === 'error' && entry.bars.length === 0) {
        body.push(prefix + chalk.red('usage unavailable'));
        return;
      }
      if (entry.bars.length === 0) {
        body.push(prefix + chalk.dim(usageLoad === 'loading' ? 'loading...' : 'no live usage data'));
        return;
      }
      let lastGroup = '';
      for (const ub of entry.bars) {
        // Separator between bucket groups (e.g. "All models" vs "GPT-5.3-Codex-Spark")
        if (ub.bucketGroup && lastGroup && ub.bucketGroup !== lastGroup) {
          body.push(prefix + chalk.dim('─'.repeat(40)));
        }
        lastGroup = ub.bucketGroup || '';
        const isWeekly = ub.windowMins === 10080;
        const label = ub.label.padEnd(14);
        const barStr = renderBar(ub.pct, BAR_WIDTH, ub);
        const reset = ub.resetLabel ? chalk.dim(`  ${ub.resetLabel}`) : '';
        if (isWeekly) {
          body.push(prefix + chalk.white(`${label} `) + barStr + reset);
        } else {
          body.push(prefix + chalk.gray(`${label} `) + barStr + reset);
        }
      }
      // Sparkline history (h key toggle)
      if (state.showHistory) {
        const spark = allAccountSparklines(24, 'u7d').get(entry.name);
        if (spark) {
          body.push(prefix + chalk.dim('24h trend   ') + chalk.cyan(spark));
        }
      }
    };

    if (selected) {
      body.push(chalk.yellowBright(`  ┏${'━'.repeat(W)}┓`));
      body.push(chalk.yellowBright('  ┃ ') + chalk.yellowBright.bold(entry.name) + chalk.yellowBright(authBadge) + (sharedBadge ? chalk.magenta(sharedBadge) : '') + (reauthBadge ? chalk.red(reauthBadge) : '') + useFirstBadge + expiryStr + (promoStr ? ' ' + promoStr : ''));
      body.push(chalk.yellowBright('  ┃ ') + chalk.gray(infoLine) + (hasData ? tokenStr : ''));

      if (state.usage) {
        renderBars(entry, chalk.yellowBright('  ┃ '));
      }

      body.push(chalk.yellowBright(`  ┗${'━'.repeat(W)}┛`));
    } else {
      body.push(chalk.dim('  │ ') + chalk.bold.white(entry.name) + chalk.dim(authBadge) + (sharedBadge ? chalk.magenta(sharedBadge) : '') + (reauthBadge ? chalk.red(reauthBadge) : '') + useFirstBadge + expiryStr + (promoStr ? ' ' + promoStr : ''));
      body.push(chalk.dim('  │ ') + chalk.gray(infoLine) + (hasData ? tokenStr : ''));

      if (state.usage) {
        renderBars(entry, chalk.dim('  │ '));
      }
    }
    body.push('');
  });

  // ── Footer (pinned bottom) ──
  footer.push(chalk.dim('  ─────────────────────────────────────────────────'));

  const yoloBox = state.yolo ? chalk.red('[✓]') : chalk.gray('[ ]');
  const resumeBox = state.resume ? chalk.green('[✓]') : chalk.gray('[ ]');
  const usageLabel = usageLoad === 'loading'
    ? chalk.yellow('refreshing...')
    : state.usage
      ? chalk.yellow('usage')
      : chalk.dim('usage');
  footer.push(`  ${yoloBox} ${chalk.white('yolo')} ${chalk.dim('(y)')}    ${resumeBox} ${chalk.white('resume')} ${chalk.dim('(r)')}    ${usageLabel} ${chalk.dim('(u)')}`);

  const selEntry = entries[state.selectedIndex];
  const preview = buildCommandPreview(selEntry, state);
  footer.push(chalk.white('  → ') + chalk.bold.cyan(preview));

  const key = (k: string) => chalk.bold.white(k);
  const desc = (d: string) => chalk.dim(d);
  footer.push(`  ${key('↑↓')} ${desc('select')}   ${key('y')} ${desc('yolo')}   ${key('r')} ${desc('resume')}   ${key('u')} ${desc('usage')}   ${key('s')} ${desc('sort')}   ${key('g')} ${desc('group')}   ${key('⏎')} ${desc('launch')}   ${key('q')} ${desc('quit')}`);
  footer.push(`  ${key('a')}  ${desc('add')}      ${key('e')} ${desc('edit')}     ${key('m')} ${desc('models')}   ${key('h')} ${desc('history')}`);

  return { header, body, footer, entryStartLines };
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
  if (state.selectedIndex >= entries.length) state.selectedIndex = 0;

  if (!process.stdin.isTTY) {
    console.error(chalk.red('Error: sweech launcher requires a TTY'));
    process.exit(1);
  }

  // Wrap stdin in a passthrough that strips mouse escape sequences
  // so readline doesn't misinterpret scroll wheel as arrow keys
  const { PassThrough } = require('stream') as typeof import('stream');
  const filtered = new PassThrough();
  readline.emitKeypressEvents(filtered);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (buf: Buffer) => {
    const s = buf.toString();
    // SGR mouse: \x1b[<...  Legacy X10 mouse: \x1b[M...
    if (s.startsWith('\x1b[<') || s.startsWith('\x1b[M')) return;
    filtered.write(buf);
  });

  let usageLoad: UsageLoadState = 'idle';
  let scrollOffset = 0;

  const draw = () => {
    const { header, body, footer, entryStartLines } = render(
      getSorted(entries, state.sortMode, state.grouped), state, usageLoad,
    );
    const rows = process.stdout.rows || 40;
    const bodyRows = Math.max(1, rows - header.length - footer.length);

    // Auto-scroll body to keep selected entry visible
    if (entryStartLines.length > 0) {
      const selStart = entryStartLines[state.selectedIndex] ?? 0;
      const selEnd = (entryStartLines[state.selectedIndex + 1] ?? body.length) - 1;
      if (selStart < scrollOffset) scrollOffset = selStart;
      if (selEnd >= scrollOffset + bodyRows) scrollOffset = selEnd - bodyRows + 1;
    }
    scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, body.length - bodyRows)));

    const visibleBody = body.slice(scrollOffset, scrollOffset + bodyRows);

    // Scroll indicators
    if (scrollOffset > 0) {
      visibleBody[0] = chalk.dim('  ▲ more above');
    }
    if (scrollOffset + bodyRows < body.length) {
      visibleBody[visibleBody.length - 1] = chalk.dim('  ▼ more below');
    }

    process.stdout.write('\x1b[H\x1b[J');
    process.stdout.write([...header, ...visibleBody, ...footer].join('\n'));
  };

  /** Patch entries in-place from account data. */
  const patchEntries = (accounts: AccountInfo[]) => {
    const accountMap = new Map(accounts.map(a => [a.commandName, a]));
    for (const entry of entries) {
      const account = accountMap.get(entry.name);
      if (!account) continue;
      entry.lastActive = account.lastActive ? timeAgo(account.lastActive) : '';
      entry.needsReauth = account.needsReauth || false;
      entry.authType = resolveAuthType(account, entry.command);
      entry.dataSizeMB = getDirSize(entry.dataDir);
      entry.bars = [];
      const live = account.live;
      if (live?.buckets) {
        // Sort: "All models" first; filter extras unless toggled on
        const sortedBuckets = [...live.buckets].sort((a, b) =>
          (a.label === 'All models' ? 0 : 1) - (b.label === 'All models' ? 0 : 1)
        );
        const visibleBuckets = state.extraBuckets
          ? sortedBuckets
          : sortedBuckets.filter(b => b.label === 'All models' || live.buckets.length === 1);
        for (const bucket of visibleBuckets) {
          let lbl = bucket.label;
          if (lbl.length > 14) lbl = lbl.replace('GPT-5.3-Codex-', '').replace('GPT-', '');
          // Weekly first (more important), then 5h
          if (bucket.weekly) {
            entry.bars.push({
              label: `${lbl} 7d`,
              pct: Math.round(bucket.weekly.utilization * 100),
              resetLabel: formatReset(bucket.weekly.resetsAt, 10080),
              resetsAt: bucket.weekly.resetsAt,
              windowMins: 10080,
              bucketGroup: lbl,
            });
          }
          if (bucket.session) {
            entry.bars.push({
              label: `${lbl} 5h`,
              pct: Math.round(bucket.session.utilization * 100),
              resetLabel: formatReset(bucket.session.resetsAt, 300),
              resetsAt: bucket.session.resetsAt,
              windowMins: 300,
              bucketGroup: lbl,
            });
          }
        }
      }
    }
  };

  /** Fetch live usage data, patch entries, redraw. refresh=true bypasses cache. */
  const fetchUsage = (refresh = false) => {
    if (usageLoad === 'loading') return;
    usageLoad = 'loading';
    draw();

    getAccountInfo(
      accountList.map(a => ({ name: a.name, commandName: a.commandName })),
      { refresh },
    )
      .then(accounts => {
        patchEntries(accounts);
        try { appendSnapshot(accounts); } catch {}
        usageLoad = 'loaded';
        draw();
      })
      .catch(() => {
        usageLoad = 'error';
        draw();
      });
  };

  // Phase 1: Show cached bars immediately (disk read, no network).
  // Phase 2: Auto-refresh in background with fresh API data.
  getAccountInfo(
    accountList.map(a => ({ name: a.name, commandName: a.commandName })),
  ).then(accounts => {
    if (usageLoad !== 'loading') {
      patchEntries(accounts);
      try { appendSnapshot(accounts); } catch {}
      state.usage = true;
      usageLoad = 'loaded';
      draw();
      // Auto-refresh: silently fetch fresh data in background
      getAccountInfo(
        accountList.map(a => ({ name: a.name, commandName: a.commandName })),
        { refresh: true },
      ).then(fresh => {
        patchEntries(fresh);
        try { appendSnapshot(fresh); } catch {}
        draw();
      }).catch(err => console.error('[sweech] usage refresh:', err.message || err));
    }
  }).catch(err => console.error('[sweech] initial fetch:', err.message || err));

  // Enter alternate screen + hide cursor.
  // Enable SGR mouse reporting so scroll wheel arrives as \x1b[<64/65;...M sequences
  // (which our PassThrough filter drops) rather than being converted to arrow keys
  // by the terminal's alternate-scroll mode before we ever see them.
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1007l');
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
        // Force-refresh live usage data (bypass cache)
        state.usage = true;
        usageLoad = 'idle'; // reset so fetchUsage doesn't bail
        fetchUsage(true);
      } else if (str === 's' || str === 'S') {
        const modes: Array<'smart' | 'status' | 'manual'> = ['smart', 'status', 'manual'];
        const next = modes[(modes.indexOf(state.sortMode) + 1) % modes.length];
        state.sortMode = next;
        state.selectedIndex = 0;
        draw();
      } else if (str === 'g' || str === 'G') {
        state.grouped = !state.grouped;
        state.selectedIndex = 0;
        draw();
      } else if (str === 'm' || str === 'M') {
        state.extraBuckets = !state.extraBuckets;
        // Re-patch bars with new filter
        if (usageLoad === 'loaded') {
          getAccountInfo(
            accountList.map(a => ({ name: a.name, commandName: a.commandName })),
          ).then(accounts => { patchEntries(accounts); draw(); }).catch(err => console.error('[sweech] bucket refresh:', err.message || err));
        }
        draw();
      } else if (str === 'h' || str === 'H') {
        state.showHistory = !state.showHistory;
        draw();
      } else if (str === '?') {
        state.helpVisible = !state.helpVisible;
        draw();
      } else if (key.name === 'escape') {
        if (state.helpVisible) { state.helpVisible = false; draw(); return; }
        cleanup(); process.exit(0);
      } else if (str === 'a' || str === 'A') {
        cleanup(); runSubcommand('add');
      } else if (str === 'e' || str === 'E') {
        const sortedNow = getSorted(entries, state.sortMode, state.grouped);
        if (sortedNow[state.selectedIndex].isDefault) return;
        cleanup(); runSubcommand('edit', sortedNow[state.selectedIndex].name);
      } else if (key.name === 'return') {
        cleanup(); launch();
      }
    };

    const cleanup = () => {
      filtered.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      // Leave alternate screen + restore cursor + disable mouse reporting
      process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1007h\x1b[?1049l\x1b[?25h');
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
      const entry = getSorted(entries, state.sortMode, state.grouped)[state.selectedIndex];
      const preview = buildCommandPreview(entry, state);
      console.log(chalk.gray(`→ ${preview}\n`));

      // Emit profile_switch event
      sweechEvents.emit('profile_switch', {
        account: entry.name,
        timestamp: new Date().toISOString(),
      });

      const env = { ...process.env };
      const launchArgs: string[] = [];
      if (entry.configDir) {
        const cli = getCLI(entry.command === 'codex' ? 'codex' : 'claude');
        if (cli) env[cli.configDirEnvVar] = entry.configDir;
      }
      if (state.yolo) launchArgs.push(entry.yoloFlag);
      if (state.resume) launchArgs.push(...entry.resumeFlag.split(' '));

      // Run plugin onLaunch hooks (errors are caught inside runHook)
      try { runHook('onLaunch', entry.name, launchArgs); } catch { /* plugin errors must not crash CLI */ }

      const { spawnSync } = require('child_process');
      const result = spawnSync(entry.command, launchArgs, { env, stdio: 'inherit' });

      // If resume failed (no conversation to continue), fall back to a fresh session
      if (result.status !== 0 && state.resume) {
        const freshArgs = launchArgs.filter(a => !entry.resumeFlag.split(' ').includes(a));
        console.log(chalk.dim('No conversation to resume — starting fresh session\n'));
        const retry = spawnSync(entry.command, freshArgs, { env, stdio: 'inherit' });
        process.exit(retry.status || 0);
      }

      process.exit(result.status || 0);
    };

    filtered.on('keypress', onKeypress);
  });
}
