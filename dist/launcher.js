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
    return { selectedIndex: 0, yolo: false, resume: false, usage: true };
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
    const pctStr = `${pct}%`;
    // At limit → always red
    if (pct >= 100)
        return chalk_1.default.red(bar) + chalk_1.default.red(` ${pctStr}`);
    // Nothing used → green
    if (pct === 0)
        return chalk_1.default.green(bar) + chalk_1.default.dim(` ${pctStr}`);
    // Calculate what % of the window has elapsed
    let elapsed = 0.5; // default: assume midpoint if we can't compute
    if (ub.resetsAt && ub.windowMins > 0) {
        const now = Date.now() / 1000;
        const windowSec = ub.windowMins * 60;
        const windowStartSec = ub.resetsAt - windowSec;
        elapsed = Math.max(0, Math.min(1, (now - windowStartSec) / windowSec));
    }
    // Burn ratio: usage% / elapsed%
    // <1.0 = under budget, 1.0-1.5 = warm, >1.5 = hot
    const usageFrac = pct / 100;
    const ratio = elapsed > 0.01 ? usageFrac / elapsed : (usageFrac > 0 ? 10 : 0);
    // Weekly limits are harder to recover — tighten thresholds
    const isWeekly = ub.windowMins > 1000;
    const warnThreshold = isWeekly ? 1.1 : 1.3;
    const dangerThreshold = isWeekly ? 1.5 : 2.0;
    if (ratio >= dangerThreshold || pct >= 90) {
        return chalk_1.default.red(bar) + chalk_1.default.red(` ${pctStr}`);
    }
    if (ratio >= warnThreshold || pct >= 70) {
        return chalk_1.default.yellow(bar) + chalk_1.default.yellow(` ${pctStr}`);
    }
    return chalk_1.default.green(bar) + chalk_1.default.dim(` ${pctStr}`);
}
function formatReset(epochSec) {
    if (!epochSec)
        return '';
    const diff = epochSec * 1000 - Date.now();
    if (diff <= 0)
        return 'resetting...';
    const mins = Math.floor(diff / 60000);
    if (mins < 60)
        return `resets in ${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24)
        return `resets in ${hours}h ${remMins}m`;
    // Show day + time
    const d = new Date(epochSec * 1000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `resets ${days[d.getDay()]} ${h12}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
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
function render(entries, state) {
    const lines = [];
    const W = 56; // frame width
    lines.push(chalk_1.default.bold('🍭 Sweech') + chalk_1.default.dim('  —  ↑↓ to select, ⏎ to launch'));
    lines.push('');
    // Group entries by CLI type, render with section headers
    let lastCliType = '';
    entries.forEach((entry, i) => {
        const cliType = entry.command === 'codex' ? 'codex' : 'claude';
        if (cliType !== lastCliType) {
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
            lines.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.yellowBright.bold(entry.name) + chalk_1.default.yellowBright(authBadge) + (sharedBadge ? chalk_1.default.magenta(sharedBadge) : '') + (reauthBadge ? chalk_1.default.red(reauthBadge) : ''));
            lines.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.gray(infoLine));
            if (state.usage) {
                const BAR_WIDTH = 20;
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
            lines.push(chalk_1.default.yellowBright(`  ┗${'━'.repeat(W)}┛`));
        }
        else {
            // ── Unselected entry ──
            lines.push(chalk_1.default.dim('  │ ') + chalk_1.default.bold.white(entry.name) + chalk_1.default.dim(authBadge) + (sharedBadge ? chalk_1.default.magenta(sharedBadge) : '') + (reauthBadge ? chalk_1.default.red(reauthBadge) : ''));
            lines.push(chalk_1.default.dim('  │ ') + chalk_1.default.gray(infoLine));
            if (state.usage) {
                const BAR_WIDTH = 20;
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
        lines.push('');
    });
    // Separator + toggles
    lines.push(chalk_1.default.dim('  ─────────────────────────────────────────────────'));
    lines.push('');
    const yoloBox = state.yolo ? chalk_1.default.red('[✓]') : chalk_1.default.gray('[ ]');
    const resumeBox = state.resume ? chalk_1.default.green('[✓]') : chalk_1.default.gray('[ ]');
    const usageBox = state.usage ? chalk_1.default.yellow('[✓]') : chalk_1.default.gray('[ ]');
    lines.push(`  ${yoloBox} ${chalk_1.default.white('yolo')} ${chalk_1.default.dim('(y)')}    ${resumeBox} ${chalk_1.default.white('resume')} ${chalk_1.default.dim('(r)')}    ${usageBox} ${chalk_1.default.white('usage')} ${chalk_1.default.dim('(u)')}`);
    if (state.usage) {
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
    lines.push(`  ${key('↑↓')} ${desc('select')}   ${key('y')} ${desc('yolo')}   ${key('r')} ${desc('resume')}   ${key('u')} ${desc('usage')}   ${key('⏎')} ${desc('launch')}   ${key('q')} ${desc('quit')}`);
    lines.push(`  ${key('a')}  ${desc('add')}      ${key('e')} ${desc('edit')}`);
    process.stdout.write(lines.join('\n'));
    return lines;
}
async function runLauncher() {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const { execFileSync } = require('child_process');
    // Build account list for getAccountInfo
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
    // Fetch real usage data for all accounts
    const accounts = await (0, subscriptions_1.getAccountInfo)(accountList.map(a => ({ name: a.name, commandName: a.commandName })));
    const accountMap = new Map(accounts.map(a => [a.commandName, a]));
    // Build entries with real data, sorted by CLI type (defaults first, then profiles)
    const unsorted = accountList.map(a => {
        const account = accountMap.get(a.commandName);
        const cli = (0, clis_1.getCLI)(a.command);
        if (a.isDefault) {
            return buildEntry(a.command, a.command, null, 'default', cli?.yoloFlag || '--dangerously-skip-permissions', cli?.resumeFlag || '--continue', true, account);
        }
        const profile = profiles.find(p => p.commandName === a.commandName);
        return buildEntry(profile.commandName, a.command, config.getProfileDir(profile.commandName), (0, providers_1.getProvider)(profile.provider)?.displayName || profile.provider, cli?.yoloFlag || '--dangerously-skip-permissions', cli?.resumeFlag || '--continue', false, account, { sharedWith: profile.sharedWith, model: profile.model });
    });
    // Group: claude default + claude profiles, then codex default + codex profiles
    const entries = [
        ...unsorted.filter(e => e.command !== 'codex' && e.isDefault),
        ...unsorted.filter(e => e.command !== 'codex' && !e.isDefault),
        ...unsorted.filter(e => e.command === 'codex' && e.isDefault),
        ...unsorted.filter(e => e.command === 'codex' && !e.isDefault),
    ];
    const state = loadLastState();
    if (state.selectedIndex >= entries.length)
        state.selectedIndex = 0;
    if (!process.stdin.isTTY) {
        console.error(chalk_1.default.red('Error: sweech launcher requires a TTY'));
        process.exit(1);
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let lastLineCount = 0;
    const draw = () => {
        if (lastLineCount > 0) {
            process.stdout.write(`\x1b[${lastLineCount - 1}A\x1b[G`);
            for (let i = 0; i < lastLineCount; i++) {
                process.stdout.write('\x1b[2K' + (i < lastLineCount - 1 ? '\n' : ''));
            }
            if (lastLineCount > 1)
                process.stdout.write(`\x1b[${lastLineCount - 1}A`);
            process.stdout.write('\x1b[G');
        }
        const renderedLines = render(entries, state);
        lastLineCount = renderedLines.length;
    };
    console.log();
    draw();
    return new Promise((resolve) => {
        const onKeypress = (str, key) => {
            if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
                cleanup();
                console.log();
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
                state.usage = !state.usage;
                draw();
            }
            else if (str === 'a' || str === 'A') {
                cleanup();
                runSubcommand('add');
            }
            else if (str === 'e' || str === 'E') {
                if (entries[state.selectedIndex].isDefault)
                    return;
                cleanup();
                runSubcommand('edit', entries[state.selectedIndex].name);
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
        };
        const runSubcommand = (cmd, arg) => {
            saveState(state);
            console.log();
            const { spawnSync } = require('child_process');
            const args = [process.argv[1], cmd];
            if (arg)
                args.push(arg);
            spawnSync(process.argv[0], args, { stdio: 'inherit' });
            spawnSync(process.argv[0], [process.argv[1]], { stdio: 'inherit' });
            process.exit(0);
        };
        const launch = () => {
            saveState(state);
            const entry = entries[state.selectedIndex];
            const preview = buildCommandPreview(entry, state);
            console.log(chalk_1.default.gray(`\n→ ${preview}\n`));
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
