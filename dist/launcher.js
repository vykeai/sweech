"use strict";
/**
 * Interactive launcher TUI for sweech
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runLauncher = runLauncher;
const chalk_1 = __importDefault(require("chalk"));
const readline = __importStar(require("readline"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const config_1 = require("./config");
const providers_1 = require("./providers");
const clis_1 = require("./clis");
const subscriptions_1 = require("./subscriptions");
const STATE_FILE = path.join(os.homedir(), '.sweech', 'last-launch.json');
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
    }
    catch { }
    return { selectedIndex: 0, yolo: false, resume: false, usage: false, sortMode: 'smart', grouped: true };
}
function saveState(state) {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    }
    catch { }
}
function buildCommandPreview(entry, state) {
    const args = [];
    if (state.yolo)
        args.push(entry.yoloFlag);
    if (state.resume)
        args.push(entry.resumeFlag);
    return `${entry.name}${args.length ? ' ' + args.join(' ') : ''}`;
}
function getDirSize(dir) {
    try {
        const { execSync } = require('child_process');
        const out = execSync(`du -sh "${dir}" 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
        return out.split('\t')[0].trim();
    }
    catch {
        return '?';
    }
}
/**
 * Render a usage bar colored by burn rate — how fast you're using
 * relative to how much time has elapsed in the window.
 *
 * Green: on pace or under  |  Yellow: burning faster than sustainable  |  Red: will hit limit
 */
function renderBar(pct, width, ub) {
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const free = Math.max(0, 100 - pct);
    const usedStr = `${pct}%`;
    const freeStr = chalk_1.default.dim(`${free}%`);
    // At limit → always red
    if (pct >= 100)
        return chalk_1.default.red(usedStr) + ' ' + chalk_1.default.red(bar) + ' ' + freeStr;
    // Nothing used → green
    if (pct === 0)
        return chalk_1.default.dim(usedStr) + ' ' + chalk_1.default.green(bar) + ' ' + chalk_1.default.green(freeStr);
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
        return chalk_1.default.red(usedStr) + ' ' + chalk_1.default.red(bar) + ' ' + freeStr;
    }
    if (ratio >= warnThreshold || pct >= 70) {
        return chalk_1.default.yellow(usedStr) + ' ' + chalk_1.default.yellow(bar) + ' ' + freeStr;
    }
    return chalk_1.default.dim(usedStr) + ' ' + chalk_1.default.green(bar) + ' ' + chalk_1.default.green(freeStr);
}
function formatReset(epochSec, windowMins = 0) {
    if (!epochSec)
        return '';
    const diff = epochSec * 1000 - Date.now();
    if (diff <= 0)
        return chalk_1.default.red('resetting...');
    const mins = Math.floor(diff / 60000);
    const isSession = windowMins <= 300; // 5h window
    // Urgency coloring — only for session (5h) window, weekly resets are rarely urgent
    if (isSession) {
        if (mins < 30)
            return chalk_1.default.red(`resets in ${mins}m`);
        if (mins < 120)
            return chalk_1.default.yellow(`resets in ${mins}m`);
    }
    if (mins < 60)
        return chalk_1.default.cyan(`resets in ${mins}m`);
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24)
        return chalk_1.default.cyan(`resets in ${hours}h ${remMins}m`);
    // Show day + time
    const d = new Date(epochSec * 1000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return chalk_1.default.dim(`resets ${days[d.getDay()]} ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`);
}
function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
function resolveAuthType(account, command) {
    // Claude accounts — check rateLimitTier (from Keychain or .credentials.json)
    if (command !== 'codex') {
        if (account.rateLimitTier) {
            const tier = account.rateLimitTier;
            if (tier.includes('max_20x'))
                return 'Max 20x';
            if (tier.includes('max_5x'))
                return 'Max 5x';
            if (tier.includes('max'))
                return 'Max';
            if (tier.includes('pro'))
                return 'Pro';
        }
        if (account.billingType === 'max')
            return 'Max';
        if (account.billingType === 'stripe_subscription')
            return 'Subscription';
        if (account.billingType)
            return account.billingType;
        if (account.meta?.plan)
            return account.meta.plan;
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
        if (auth.auth_mode === 'chatgpt')
            return 'ChatGPT';
        if (auth.OPENAI_API_KEY)
            return 'API Key';
    }
    catch { }
    return 'Subscription';
}
function buildEntry(name, command, configDir, label, yoloFlag, resumeFlag, isDefault, account, opts) {
    const dataDir = account.configDir;
    const lastActive = account.lastActive ? timeAgo(account.lastActive) : '';
    // Build usage bars from buckets
    const bars = [];
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
    };
}
function entrySmartScore(e) {
    if (e.needsReauth)
        return -2;
    const bar5h = e.bars.find(b => b.windowMins === 300);
    if (bar5h && bar5h.pct >= 100)
        return -1;
    const bar7d = e.bars.find(b => b.windowMins === 10080);
    if (!bar7d)
        return bar5h ? (100 - bar5h.pct) / 100 : 0;
    const remaining7d = (100 - bar7d.pct) / 100;
    if (!bar7d.resetsAt)
        return remaining7d;
    const hoursLeft = Math.max(0.5, (bar7d.resetsAt - Date.now() / 1000) / 3600);
    return remaining7d / (hoursLeft / 24);
}
function sortedWithinGroup(list, mode) {
    if (mode === 'manual')
        return list;
    if (mode === 'status') {
        return [...list].sort((a, b) => {
            const score = (e) => e.needsReauth ? -2 : e.bars.some(b => b.windowMins === 300 && b.pct >= 100) ? -1 : 0;
            return score(b) - score(a);
        });
    }
    return [...list].sort((a, b) => entrySmartScore(b) - entrySmartScore(a));
}
function getSorted(allEntries, mode, grouped = true) {
    if (!grouped) {
        return sortedWithinGroup(allEntries, mode);
    }
    const claude = allEntries.filter(e => e.command !== 'codex');
    const codex = allEntries.filter(e => e.command === 'codex');
    return [...sortedWithinGroup(claude, mode), ...sortedWithinGroup(codex, mode)];
}
function expiryAlert(e) {
    const bar7d = e.bars.find(b => b.windowMins === 10080);
    if (!bar7d?.resetsAt)
        return '';
    const hoursLeft = (bar7d.resetsAt - Date.now() / 1000) / 3600;
    const remaining = (100 - bar7d.pct) / 100;
    if (remaining <= 0.1 || hoursLeft <= 0 || hoursLeft >= 72)
        return '';
    const pct = Math.round(remaining * 100);
    const label = hoursLeft < 24 ? `${Math.round(hoursLeft)}h` : `${Math.floor(hoursLeft / 24)}d`;
    return chalk_1.default.cyan(` ⚡ ${pct}% expiring in ${label}`);
}
function render(entries, state, usageLoad = 'idle') {
    const lines = [];
    const W = 56; // frame width
    const sortLabel = state.sortMode === 'status' ? 'status' : state.sortMode === 'manual' ? 'manual' : 'smart';
    const groupLabel = state.grouped ? 'on' : 'off';
    lines.push(chalk_1.default.bold('🍭 Sweech') + chalk_1.default.dim(`  —  ↑↓ select  s:${sortLabel}  g:${groupLabel}  ⏎ launch`));
    lines.push('');
    // Track rank within each group for "use first" badge
    const useFirstSet = new Set();
    if (state.grouped) {
        const claudeGroup = entries.filter(e => e.command !== 'codex');
        const codexGroup = entries.filter(e => e.command === 'codex');
        if (claudeGroup[0] && entrySmartScore(claudeGroup[0]) >= 0)
            useFirstSet.add(claudeGroup[0]);
        if (codexGroup[0] && entrySmartScore(codexGroup[0]) >= 0)
            useFirstSet.add(codexGroup[0]);
    }
    else {
        if (entries[0] && entrySmartScore(entries[0]) >= 0)
            useFirstSet.add(entries[0]);
    }
    // Group entries by CLI type, render with section headers
    let lastCliType = '';
    entries.forEach((entry, i) => {
        const cliType = entry.command === 'codex' ? 'codex' : 'claude';
        if (state.grouped && cliType !== lastCliType) {
            const cliLabel = cliType === 'codex' ? 'Codex (OpenAI)' : 'Claude (Anthropic)';
            lines.push(chalk_1.default.dim(`  ── ${cliLabel} ${'─'.repeat(Math.max(0, 42 - cliLabel.length))}`));
            lines.push('');
            lastCliType = cliType;
        }
        const selected = i === state.selectedIndex;
        // Tags
        const authBadge = entry.authType ? ` [${entry.authType}]` : '';
        const sharedBadge = entry.sharedWith ? ` [shared ↔ ${entry.sharedWith}]` : '';
        const reauthBadge = entry.needsReauth ? ' ⚠ re-auth' : '';
        const useFirstBadge = usageLoad === 'loaded' && useFirstSet.has(entry) ? chalk_1.default.cyan(' ⚡ use first') : '';
        const expiryStr = usageLoad === 'loaded' ? expiryAlert(entry) : '';
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
            lines.push(chalk_1.default.yellowBright(`  ┏${'━'.repeat(W)}┓`));
            lines.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.yellowBright.bold(entry.name) + chalk_1.default.yellowBright(authBadge) + (sharedBadge ? chalk_1.default.magenta(sharedBadge) : '') + (reauthBadge ? chalk_1.default.red(reauthBadge) : '') + useFirstBadge + expiryStr);
            lines.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.gray(infoLine));
            if (state.usage) {
                const BAR_WIDTH = 20;
                if (usageLoad === 'loading') {
                    lines.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.dim('fetching usage...'));
                }
                else if (usageLoad === 'error') {
                    lines.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.red('usage unavailable'));
                }
                else {
                    const maxBars = 4;
                    for (let b = 0; b < maxBars; b++) {
                        if (b < entry.bars.length) {
                            const ub = entry.bars[b];
                            const label = ub.label.padEnd(14);
                            const barStr = renderBar(ub.pct, BAR_WIDTH, ub);
                            const reset = ub.resetLabel ? chalk_1.default.dim(`  ${ub.resetLabel}`) : '';
                            lines.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.gray(`${label} `) + barStr + reset);
                        }
                        else if (entry.bars.length === 0 && b === 0) {
                            lines.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.dim('no live usage data'));
                        }
                        else {
                            lines.push(chalk_1.default.yellowBright('  ┃'));
                        }
                    }
                }
            }
            lines.push(chalk_1.default.yellowBright(`  ┗${'━'.repeat(W)}┛`));
        }
        else {
            // ── Unselected entry ──
            lines.push(chalk_1.default.dim('  │ ') + chalk_1.default.bold.white(entry.name) + chalk_1.default.dim(authBadge) + (sharedBadge ? chalk_1.default.magenta(sharedBadge) : '') + (reauthBadge ? chalk_1.default.red(reauthBadge) : '') + useFirstBadge + expiryStr);
            lines.push(chalk_1.default.dim('  │ ') + chalk_1.default.gray(infoLine));
            if (state.usage) {
                const BAR_WIDTH = 20;
                if (usageLoad === 'loading') {
                    lines.push(chalk_1.default.dim('  │ ') + chalk_1.default.dim('fetching...'));
                }
                else if (usageLoad !== 'error') {
                    const maxBars = 4;
                    for (let b = 0; b < maxBars; b++) {
                        if (b < entry.bars.length) {
                            const ub = entry.bars[b];
                            const label = ub.label.padEnd(14);
                            const barStr = renderBar(ub.pct, BAR_WIDTH, ub);
                            const reset = ub.resetLabel ? chalk_1.default.dim(`  ${ub.resetLabel}`) : '';
                            lines.push(chalk_1.default.dim('  │ ') + chalk_1.default.gray(`${label} `) + barStr + reset);
                        }
                        else if (entry.bars.length === 0 && b === 0) {
                            lines.push(chalk_1.default.dim('  │ ') + chalk_1.default.dim('no live usage data'));
                        }
                        else {
                            lines.push(chalk_1.default.dim('  │'));
                        }
                    }
                }
            }
        }
        lines.push('');
    });
    // Separator + toggles
    lines.push(chalk_1.default.dim('  ─────────────────────────────────────────────────'));
    lines.push('');
    const yoloBox = state.yolo ? chalk_1.default.red('[✓]') : chalk_1.default.gray('[ ]');
    const resumeBox = state.resume ? chalk_1.default.green('[✓]') : chalk_1.default.gray('[ ]');
    const usageLabel = usageLoad === 'loading'
        ? chalk_1.default.dim('loading...')
        : usageLoad === 'loaded' && state.usage
            ? chalk_1.default.yellow('usage')
            : chalk_1.default.dim('usage');
    lines.push(`  ${yoloBox} ${chalk_1.default.white('yolo')} ${chalk_1.default.dim('(y)')}    ${resumeBox} ${chalk_1.default.white('resume')} ${chalk_1.default.dim('(r)')}    ${usageLabel} ${chalk_1.default.dim('(u)')}`);
    if (state.usage && usageLoad === 'loaded') {
        lines.push('');
        lines.push(chalk_1.default.dim('  Bars show burn rate: ') + chalk_1.default.green('green') + chalk_1.default.dim(' = on pace  ') + chalk_1.default.yellow('yellow') + chalk_1.default.dim(' = ahead  ') + chalk_1.default.red('red') + chalk_1.default.dim(' = will hit limit'));
    }
    lines.push('');
    // Command preview
    const entry = entries[state.selectedIndex];
    const preview = buildCommandPreview(entry, state);
    lines.push(chalk_1.default.white('  → ') + chalk_1.default.bold.cyan(preview));
    lines.push('');
    // Shortcuts
    const key = (k) => chalk_1.default.bold.white(k);
    const desc = (d) => chalk_1.default.dim(d);
    lines.push(`  ${key('↑↓')} ${desc('select')}   ${key('y')} ${desc('yolo')}   ${key('r')} ${desc('resume')}   ${key('u')} ${desc('usage')}   ${key('s')} ${desc('sort')}   ${key('g')} ${desc('group')}   ${key('⏎')} ${desc('launch')}   ${key('q')} ${desc('quit')}`);
    lines.push(`  ${key('a')}  ${desc('add')}      ${key('e')} ${desc('edit')}`);
    process.stdout.write(lines.join('\n'));
    return lines;
}
/** Build a placeholder entry from static data only — no I/O, instant. */
function buildStaticEntry(name, command, configDir, label, yoloFlag, resumeFlag, isDefault, opts) {
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
async function runLauncher() {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const { execFileSync } = require('child_process');
    // ── Build entries instantly from static data (no I/O) ──────────────────────
    const accountList = [];
    for (const cli of Object.values(clis_1.SUPPORTED_CLIS)) {
        try {
            execFileSync('which', [cli.command], { stdio: 'ignore' });
            accountList.push({ name: cli.command, commandName: cli.name, command: cli.command, isDefault: true });
        }
        catch { }
    }
    for (const p of profiles) {
        const cliType = p.cliType === 'codex' ? 'codex' : 'claude';
        accountList.push({ name: p.name || p.commandName, commandName: p.commandName, command: cliType, isDefault: false });
    }
    const unsorted = accountList.map(a => {
        const cli = (0, clis_1.getCLI)(a.command);
        if (a.isDefault) {
            return buildStaticEntry(a.command, a.command, null, 'default', cli?.yoloFlag || '--dangerously-skip-permissions', cli?.resumeFlag || '--continue', true);
        }
        const profile = profiles.find(p => p.commandName === a.commandName);
        return buildStaticEntry(profile.commandName, a.command, config.getProfileDir(profile.commandName), (0, providers_1.getProvider)(profile.provider)?.displayName || profile.provider, cli?.yoloFlag || '--dangerously-skip-permissions', cli?.resumeFlag || '--continue', false, { sharedWith: profile.sharedWith, model: profile.model });
    });
    const entries = [
        ...unsorted.filter(e => e.command !== 'codex' && e.isDefault),
        ...unsorted.filter(e => e.command !== 'codex' && !e.isDefault),
        ...unsorted.filter(e => e.command === 'codex' && e.isDefault),
        ...unsorted.filter(e => e.command === 'codex' && !e.isDefault),
    ];
    const state = loadLastState();
    state.usage = false; // always start with usage hidden
    if (state.selectedIndex >= entries.length)
        state.selectedIndex = 0;
    if (!process.stdin.isTTY) {
        console.error(chalk_1.default.red('Error: sweech launcher requires a TTY'));
        process.exit(1);
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let usageLoad = 'idle';
    const draw = () => {
        // Move to top-left and clear to end of screen — works in alternate buffer
        process.stdout.write('\x1b[H\x1b[J');
        render(getSorted(entries, state.sortMode, state.grouped), state, usageLoad);
    };
    /** Fetch usage data async, patch entries in-place, redraw. */
    const fetchUsage = () => {
        if (usageLoad === 'loading' || usageLoad === 'loaded')
            return;
        usageLoad = 'loading';
        draw();
        (0, subscriptions_1.getAccountInfo)(accountList.map(a => ({ name: a.name, commandName: a.commandName })))
            .then(accounts => {
            const accountMap = new Map(accounts.map(a => [a.commandName, a]));
            for (const entry of entries) {
                const account = accountMap.get(entry.name);
                if (!account)
                    continue;
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
                        if (lbl.length > 14)
                            lbl = lbl.replace('GPT-5.3-Codex-', '').replace('GPT-', '');
                        if (bucket.session) {
                            entry.bars.push({
                                label: `${lbl} 5h`,
                                pct: Math.round(bucket.session.utilization * 100),
                                resetLabel: formatReset(bucket.session.resetsAt, 300),
                                resetsAt: bucket.session.resetsAt,
                                windowMins: 300,
                            });
                        }
                        if (bucket.weekly) {
                            entry.bars.push({
                                label: `${lbl} 7d`,
                                pct: Math.round(bucket.weekly.utilization * 100),
                                resetLabel: formatReset(bucket.weekly.resetsAt, 10080),
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
        const onKeypress = (str, key) => {
            if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
                cleanup();
                process.exit(0);
            }
            if (key.name === 'up') {
                state.selectedIndex = (state.selectedIndex - 1 + entries.length) % entries.length;
                draw();
            }
            else if (key.name === 'down') {
                state.selectedIndex = (state.selectedIndex + 1) % entries.length;
                draw();
            }
            else if (str === 'y' || str === 'Y') {
                state.yolo = !state.yolo;
                draw();
            }
            else if (str === 'r' || str === 'R') {
                state.resume = !state.resume;
                draw();
            }
            else if (str === 'u' || str === 'U') {
                if (usageLoad === 'idle') {
                    // First press: start fetch and show
                    state.usage = true;
                    fetchUsage();
                }
                else if (usageLoad === 'loaded') {
                    // Subsequent presses: toggle visibility
                    state.usage = !state.usage;
                    draw();
                }
                // If loading: ignore (already in progress)
            }
            else if (str === 's' || str === 'S') {
                const modes = ['smart', 'status', 'manual'];
                const next = modes[(modes.indexOf(state.sortMode) + 1) % modes.length];
                state.sortMode = next;
                state.selectedIndex = 0;
                draw();
            }
            else if (str === 'g' || str === 'G') {
                state.grouped = !state.grouped;
                state.selectedIndex = 0;
                draw();
            }
            else if (str === 'a' || str === 'A') {
                cleanup();
                runSubcommand('add');
            }
            else if (str === 'e' || str === 'E') {
                const sortedNow = getSorted(entries, state.sortMode, state.grouped);
                if (sortedNow[state.selectedIndex].isDefault)
                    return;
                cleanup();
                runSubcommand('edit', sortedNow[state.selectedIndex].name);
            }
            else if (key.name === 'return') {
                cleanup();
                launch();
            }
        };
        const cleanup = () => {
            process.stdin.removeListener('keypress', onKeypress);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            // Leave alternate screen + restore cursor
            process.stdout.write('\x1b[?1049l\x1b[?25h');
        };
        const runSubcommand = (cmd, arg) => {
            cleanup();
            saveState(state);
            const { spawnSync } = require('child_process');
            const args = [process.argv[1], cmd];
            if (arg)
                args.push(arg);
            spawnSync(process.argv[0], args, { stdio: 'inherit' });
            spawnSync(process.argv[0], [process.argv[1]], { stdio: 'inherit' });
            process.exit(0);
        };
        const launch = () => {
            cleanup();
            saveState(state);
            const entry = getSorted(entries, state.sortMode, state.grouped)[state.selectedIndex];
            const preview = buildCommandPreview(entry, state);
            console.log(chalk_1.default.gray(`→ ${preview}\n`));
            const env = { ...process.env };
            const launchArgs = [];
            if (entry.configDir) {
                const cli = (0, clis_1.getCLI)(entry.command === 'codex' ? 'codex' : 'claude');
                if (cli)
                    env[cli.configDirEnvVar] = entry.configDir;
            }
            if (state.yolo)
                launchArgs.push(entry.yoloFlag);
            if (state.resume)
                launchArgs.push(...entry.resumeFlag.split(' '));
            const { spawnSync } = require('child_process');
            const result = spawnSync(entry.command, launchArgs, { env, stdio: 'inherit' });
            process.exit(result.status || 0);
        };
        process.stdin.on('keypress', onKeypress);
    });
}
