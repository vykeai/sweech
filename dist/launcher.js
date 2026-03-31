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
exports.buildCommandPreview = buildCommandPreview;
exports.resolveAuthType = resolveAuthType;
exports.buildEntry = buildEntry;
exports.entrySmartScore = entrySmartScore;
exports.sortedWithinGroup = sortedWithinGroup;
exports.getSorted = getSorted;
exports.expiryAlert = expiryAlert;
exports.render = render;
exports.runLauncher = runLauncher;
const chalk_1 = __importDefault(require("chalk"));
const readline = __importStar(require("readline"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const liveUsage_1 = require("./liveUsage");
const os = __importStar(require("os"));
const config_1 = require("./config");
const providers_1 = require("./providers");
const clis_1 = require("./clis");
const subscriptions_1 = require("./subscriptions");
const usageHistory_1 = require("./usageHistory");
const events_1 = require("./events");
const plugins_1 = require("./plugins");
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
    const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
    const empty = Math.max(0, width - filled);
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
        tokenStatus: account.tokenStatus,
        tokenExpiresAt: account.tokenExpiresAt,
        promotion: account.live?.promotion,
    };
}
/** Score a LaunchEntry by converting it to the shared ScorableAccount interface */
function entrySmartScore(e) {
    // Convert LaunchEntry bars back to LiveRateLimitData shape for the shared scorer
    const allModels5h = e.bars.find(b => b.windowMins === 300 && b.label.startsWith('All models'))
        || e.bars.find(b => b.windowMins === 300);
    const allModels7d = e.bars.find(b => b.windowMins === 10080 && b.label.startsWith('All models'))
        || e.bars.find(b => b.windowMins === 10080);
    return (0, liveUsage_1.computeSmartScore)({
        needsReauth: e.needsReauth,
        live: e.bars.length > 0 ? {
            buckets: [{
                    label: 'All models',
                    session: allModels5h ? { utilization: allModels5h.pct / 100, resetsAt: allModels5h.resetsAt } : undefined,
                    weekly: allModels7d ? { utilization: allModels7d.pct / 100, resetsAt: allModels7d.resetsAt } : undefined,
                }],
            capturedAt: Date.now(),
            status: allModels5h && allModels5h.pct >= 100 ? 'limit_reached' : 'allowed',
        } : null,
    });
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
    const bar7d = e.bars.find(b => b.windowMins === 10080 && b.label.startsWith('All models'))
        ?? e.bars.find(b => b.windowMins === 10080);
    if (!bar7d?.resetsAt)
        return '';
    const hoursLeft = (bar7d.resetsAt - Date.now() / 1000) / 3600;
    const remaining = (100 - bar7d.pct) / 100;
    if (remaining <= 0 || hoursLeft <= 0 || hoursLeft >= 72)
        return '';
    const pct = Math.round(remaining * 100);
    const label = hoursLeft < 24 ? `${Math.round(hoursLeft)}h` : `${Math.floor(hoursLeft / 24)}d`;
    return chalk_1.default.cyan(` ⚡ ${pct}% expiring in ${label}`);
}
function render(entries, state, usageLoad = 'idle') {
    const header = [];
    const body = [];
    const footer = [];
    const entryStartLines = [];
    const W = 56; // frame width
    // ── Help overlay ──
    if (state.helpVisible) {
        const k = (s) => chalk_1.default.bold.white(s.padEnd(10));
        const d = (s) => chalk_1.default.dim(s);
        header.push('');
        header.push(chalk_1.default.bold('  ── Keyboard Shortcuts ──'));
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
        footer.push(chalk_1.default.dim('  Press ? to close'));
        return { header, body, footer, entryStartLines };
    }
    // ── Header (pinned top) ──
    const sortLabel = state.sortMode === 'smart'
        ? chalk_1.default.cyan.bold('⚡smart')
        : state.sortMode === 'status'
            ? chalk_1.default.dim('status')
            : chalk_1.default.dim('manual');
    const groupLabel = state.grouped ? 'on' : 'off';
    header.push(chalk_1.default.bold('🍭 Sweech') + chalk_1.default.dim('  —  ↑↓ select  ') + `s:${sortLabel}` + chalk_1.default.dim(`  g:${groupLabel}  ⏎ launch`));
    if (state.sortMode === 'smart') {
        header.push(chalk_1.default.dim('  prioritises expiring weekly usage — don\'t waste what resets soonest'));
    }
    header.push(chalk_1.default.dim('  ─────────────────────────────────────────────────'));
    // "use first" badge: only meaningful in smart sort (in other modes rank-0 is arbitrary)
    const useFirstSet = new Set();
    if (state.sortMode === 'smart') {
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
    }
    // ── Body (scrollable entries) ──
    let lastCliType = '';
    entries.forEach((entry, i) => {
        entryStartLines.push(body.length);
        const cliType = entry.command === 'codex' ? 'codex' : 'claude';
        if (state.grouped && cliType !== lastCliType) {
            const cliLabel = cliType === 'codex' ? 'Codex (OpenAI)' : 'Claude (Anthropic)';
            body.push(chalk_1.default.dim(`  ── ${cliLabel} ${'─'.repeat(Math.max(0, 42 - cliLabel.length))}`));
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
            ? chalk_1.default.cyan(' ⚡ use first') : '';
        // Token status indicator
        let tokenStr = '';
        if (entry.tokenStatus === 'refreshed') {
            tokenStr = chalk_1.default.green(' 🔑 token ok');
        }
        else if (entry.tokenStatus === 'expired') {
            tokenStr = chalk_1.default.red(' 🔑 expired');
        }
        else if (entry.tokenStatus === 'valid' && entry.tokenExpiresAt) {
            const hoursLeft = Math.max(0, (entry.tokenExpiresAt - Date.now()) / 3600000);
            if (hoursLeft < 1) {
                tokenStr = chalk_1.default.yellow(` 🔑 expires in ${Math.round(hoursLeft * 60)}m`);
            }
            else if (hoursLeft < 24) {
                tokenStr = chalk_1.default.dim(` 🔑 expires in ${Math.round(hoursLeft)}h`);
            }
            else {
                tokenStr = chalk_1.default.dim(' 🔑 token ok');
            }
        }
        else if (entry.tokenStatus === 'no_token' && entry.command !== 'codex') {
            tokenStr = chalk_1.default.dim(' 🔑 no token');
        }
        // Promotion badge
        let promoStr = '';
        const promo = entry.bars.length > 0 ? entry.promotion : undefined;
        if (promo) {
            const expiryLabel = promo.expiresAt
                ? (() => { const h = Math.max(0, (promo.expiresAt - Date.now()) / 3600000); return h < 24 ? ` · ${Math.round(h)}h left` : ` · ${Math.floor(h / 24)}d left`; })()
                : '';
            promoStr = chalk_1.default.bgCyan.black(` ${promo.label} `) + chalk_1.default.cyan(expiryLabel);
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
        const renderBars = (entry, prefix) => {
            const BAR_WIDTH = 20;
            if (usageLoad === 'error' && entry.bars.length === 0) {
                body.push(prefix + chalk_1.default.red('usage unavailable'));
                return;
            }
            if (entry.bars.length === 0) {
                body.push(prefix + chalk_1.default.dim(usageLoad === 'loading' ? 'loading...' : 'no live usage data'));
                return;
            }
            let lastGroup = '';
            for (const ub of entry.bars) {
                // Separator between bucket groups (e.g. "All models" vs "GPT-5.3-Codex-Spark")
                if (ub.bucketGroup && lastGroup && ub.bucketGroup !== lastGroup) {
                    body.push(prefix + chalk_1.default.dim('─'.repeat(40)));
                }
                lastGroup = ub.bucketGroup || '';
                const isWeekly = ub.windowMins === 10080;
                const label = ub.label.padEnd(14);
                const barStr = renderBar(ub.pct, BAR_WIDTH, ub);
                const reset = ub.resetLabel ? chalk_1.default.dim(`  ${ub.resetLabel}`) : '';
                if (isWeekly) {
                    body.push(prefix + chalk_1.default.white(`${label} `) + barStr + reset);
                }
                else {
                    body.push(prefix + chalk_1.default.gray(`${label} `) + barStr + reset);
                }
            }
            // Sparkline history (h key toggle)
            if (state.showHistory) {
                const spark = (0, usageHistory_1.allAccountSparklines)(24, 'u7d').get(entry.name);
                if (spark) {
                    body.push(prefix + chalk_1.default.dim('24h trend   ') + chalk_1.default.cyan(spark));
                }
            }
        };
        if (selected) {
            body.push(chalk_1.default.yellowBright(`  ┏${'━'.repeat(W)}┓`));
            body.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.yellowBright.bold(entry.name) + chalk_1.default.yellowBright(authBadge) + (sharedBadge ? chalk_1.default.magenta(sharedBadge) : '') + (reauthBadge ? chalk_1.default.red(reauthBadge) : '') + useFirstBadge + expiryStr + (promoStr ? ' ' + promoStr : ''));
            body.push(chalk_1.default.yellowBright('  ┃ ') + chalk_1.default.gray(infoLine) + (hasData ? tokenStr : ''));
            if (state.usage) {
                renderBars(entry, chalk_1.default.yellowBright('  ┃ '));
            }
            body.push(chalk_1.default.yellowBright(`  ┗${'━'.repeat(W)}┛`));
        }
        else {
            body.push(chalk_1.default.dim('  │ ') + chalk_1.default.bold.white(entry.name) + chalk_1.default.dim(authBadge) + (sharedBadge ? chalk_1.default.magenta(sharedBadge) : '') + (reauthBadge ? chalk_1.default.red(reauthBadge) : '') + useFirstBadge + expiryStr + (promoStr ? ' ' + promoStr : ''));
            body.push(chalk_1.default.dim('  │ ') + chalk_1.default.gray(infoLine) + (hasData ? tokenStr : ''));
            if (state.usage) {
                renderBars(entry, chalk_1.default.dim('  │ '));
            }
        }
        body.push('');
    });
    // ── Footer (pinned bottom) ──
    footer.push(chalk_1.default.dim('  ─────────────────────────────────────────────────'));
    const yoloBox = state.yolo ? chalk_1.default.red('[✓]') : chalk_1.default.gray('[ ]');
    const resumeBox = state.resume ? chalk_1.default.green('[✓]') : chalk_1.default.gray('[ ]');
    const usageLabel = usageLoad === 'loading'
        ? chalk_1.default.yellow('refreshing...')
        : state.usage
            ? chalk_1.default.yellow('usage')
            : chalk_1.default.dim('usage');
    footer.push(`  ${yoloBox} ${chalk_1.default.white('yolo')} ${chalk_1.default.dim('(y)')}    ${resumeBox} ${chalk_1.default.white('resume')} ${chalk_1.default.dim('(r)')}    ${usageLabel} ${chalk_1.default.dim('(u)')}`);
    const selEntry = entries[state.selectedIndex];
    const preview = buildCommandPreview(selEntry, state);
    footer.push(chalk_1.default.white('  → ') + chalk_1.default.bold.cyan(preview));
    const key = (k) => chalk_1.default.bold.white(k);
    const desc = (d) => chalk_1.default.dim(d);
    footer.push(`  ${key('↑↓')} ${desc('select')}   ${key('y')} ${desc('yolo')}   ${key('r')} ${desc('resume')}   ${key('u')} ${desc('usage')}   ${key('s')} ${desc('sort')}   ${key('g')} ${desc('group')}   ${key('⏎')} ${desc('launch')}   ${key('q')} ${desc('quit')}`);
    footer.push(`  ${key('a')}  ${desc('add')}      ${key('e')} ${desc('edit')}     ${key('m')} ${desc('models')}   ${key('h')} ${desc('history')}`);
    return { header, body, footer, entryStartLines };
}
/** Build a placeholder entry from static data only — no I/O, instant. */
function buildStaticEntry(name, command, configDir, label, yoloFlag, resumeFlag, isDefault, opts) {
    const dataDir = configDir ?? path.join(os.homedir(), `.${name}`);
    return {
        name, command, configDir, label, yoloFlag, resumeFlag, isDefault,
        sharedWith: opts?.sharedWith,
        model: opts?.model,
        providerKey: opts?.providerKey,
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
        return buildStaticEntry(profile.commandName, a.command, config.getProfileDir(profile.commandName), (0, providers_1.getProvider)(profile.provider)?.displayName || profile.provider, cli?.yoloFlag || '--dangerously-skip-permissions', cli?.resumeFlag || '--continue', false, { sharedWith: profile.sharedWith, model: profile.model, providerKey: profile.provider });
    });
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
    // Wrap stdin in a passthrough that strips mouse escape sequences
    // so readline doesn't misinterpret scroll wheel as arrow keys
    const { PassThrough } = require('stream');
    const filtered = new PassThrough();
    readline.emitKeypressEvents(filtered);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (buf) => {
        const s = buf.toString();
        // SGR mouse: \x1b[<...  Legacy X10 mouse: \x1b[M...
        if (s.startsWith('\x1b[<') || s.startsWith('\x1b[M'))
            return;
        filtered.write(buf);
    });
    let usageLoad = 'idle';
    let scrollOffset = 0;
    const draw = () => {
        const { header, body, footer, entryStartLines } = render(getSorted(entries, state.sortMode, state.grouped), state, usageLoad);
        const rows = process.stdout.rows || 40;
        const bodyRows = Math.max(1, rows - header.length - footer.length);
        // Auto-scroll body to keep selected entry visible
        if (entryStartLines.length > 0) {
            const selStart = entryStartLines[state.selectedIndex] ?? 0;
            const selEnd = (entryStartLines[state.selectedIndex + 1] ?? body.length) - 1;
            if (selStart < scrollOffset)
                scrollOffset = selStart;
            if (selEnd >= scrollOffset + bodyRows)
                scrollOffset = selEnd - bodyRows + 1;
        }
        scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, body.length - bodyRows)));
        const visibleBody = body.slice(scrollOffset, scrollOffset + bodyRows);
        // Scroll indicators
        if (scrollOffset > 0) {
            visibleBody[0] = chalk_1.default.dim('  ▲ more above');
        }
        if (scrollOffset + bodyRows < body.length) {
            visibleBody[visibleBody.length - 1] = chalk_1.default.dim('  ▼ more below');
        }
        process.stdout.write('\x1b[H\x1b[J');
        process.stdout.write([...header, ...visibleBody, ...footer].join('\n'));
    };
    /** Patch entries in-place from account data. */
    const patchEntries = (accounts) => {
        const accountMap = new Map(accounts.map(a => [a.commandName, a]));
        for (const entry of entries) {
            const account = accountMap.get(entry.name);
            if (!account)
                continue;
            entry.lastActive = account.lastActive ? timeAgo(account.lastActive) : '';
            entry.needsReauth = account.needsReauth || false;
            entry.authType = resolveAuthType(account, entry.command);
            entry.dataSizeMB = getDirSize(entry.dataDir);
            entry.bars = [];
            const live = account.live;
            if (live?.buckets) {
                // Sort: "All models" first; filter extras unless toggled on
                const sortedBuckets = [...live.buckets].sort((a, b) => (a.label === 'All models' ? 0 : 1) - (b.label === 'All models' ? 0 : 1));
                const visibleBuckets = state.extraBuckets
                    ? sortedBuckets
                    : sortedBuckets.filter(b => b.label === 'All models' || live.buckets.length === 1);
                for (const bucket of visibleBuckets) {
                    let lbl = bucket.label;
                    if (lbl.length > 14)
                        lbl = lbl.replace('GPT-5.3-Codex-', '').replace('GPT-', '');
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
        if (usageLoad === 'loading')
            return;
        usageLoad = 'loading';
        draw();
        (0, subscriptions_1.getAccountInfo)(accountList.map(a => ({ name: a.name, commandName: a.commandName })), { refresh })
            .then(accounts => {
            patchEntries(accounts);
            try {
                (0, usageHistory_1.appendSnapshot)(accounts);
            }
            catch { }
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
    (0, subscriptions_1.getAccountInfo)(accountList.map(a => ({ name: a.name, commandName: a.commandName }))).then(accounts => {
        if (usageLoad !== 'loading') {
            patchEntries(accounts);
            try {
                (0, usageHistory_1.appendSnapshot)(accounts);
            }
            catch { }
            state.usage = true;
            usageLoad = 'loaded';
            draw();
            // Auto-refresh: silently fetch fresh data in background
            (0, subscriptions_1.getAccountInfo)(accountList.map(a => ({ name: a.name, commandName: a.commandName })), { refresh: true }).then(fresh => {
                patchEntries(fresh);
                try {
                    (0, usageHistory_1.appendSnapshot)(fresh);
                }
                catch { }
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
                // Force-refresh live usage data (bypass cache)
                state.usage = true;
                usageLoad = 'idle'; // reset so fetchUsage doesn't bail
                fetchUsage(true);
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
            else if (str === 'm' || str === 'M') {
                state.extraBuckets = !state.extraBuckets;
                // Re-patch bars with new filter
                if (usageLoad === 'loaded') {
                    (0, subscriptions_1.getAccountInfo)(accountList.map(a => ({ name: a.name, commandName: a.commandName }))).then(accounts => { patchEntries(accounts); draw(); }).catch(err => console.error('[sweech] bucket refresh:', err.message || err));
                }
                draw();
            }
            else if (str === 'h' || str === 'H') {
                state.showHistory = !state.showHistory;
                draw();
            }
            else if (str === '?') {
                state.helpVisible = !state.helpVisible;
                draw();
            }
            else if (key.name === 'escape') {
                if (state.helpVisible) {
                    state.helpVisible = false;
                    draw();
                    return;
                }
                cleanup();
                process.exit(0);
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
                launch();
            }
        };
        const cleanup = () => {
            filtered.removeListener('keypress', onKeypress);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            // Leave alternate screen + restore cursor + disable mouse reporting
            process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1007h\x1b[?1049l\x1b[?25h');
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
        const launch = async () => {
            cleanup();
            saveState(state);
            const entry = getSorted(entries, state.sortMode, state.grouped)[state.selectedIndex];
            const env = { ...process.env };
            const launchArgs = [];
            if (entry.configDir) {
                const cli = (0, clis_1.getCLI)(entry.command === 'codex' ? 'codex' : 'claude');
                if (cli)
                    env[cli.configDirEnvVar] = entry.configDir;
            }
            // Model picker for external providers with model catalogs
            if (entry.providerKey && (0, providers_1.isExternalProvider)(entry.providerKey)) {
                const provider = (0, providers_1.getProvider)(entry.providerKey);
                const models = provider?.availableModels;
                if (models && models.length > 0) {
                    const inquirer = (await Promise.resolve().then(() => __importStar(require('inquirer')))).default;
                    const choices = models.map((m) => {
                        const meta = [m.type, m.context, m.note].filter(Boolean).join(', ');
                        const current = m.id === entry.model ? chalk_1.default.green(' ← current') : '';
                        return {
                            name: `${m.name}  ${chalk_1.default.dim(meta)}${current}`,
                            value: m.id,
                        };
                    });
                    const { selectedModel } = await inquirer.prompt([
                        {
                            type: 'list',
                            name: 'selectedModel',
                            message: `${entry.name} · select model:`,
                            choices,
                            default: entry.model || provider?.defaultModel,
                        },
                    ]);
                    // Write model to settings.json (Claude Code reads env from there, not process env)
                    if (entry.configDir) {
                        const settingsPath = path.join(entry.configDir, 'settings.json');
                        try {
                            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
                            const modelKey = entry.command === 'codex' ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL';
                            settings.env = settings.env || {};
                            settings.env[modelKey] = selectedModel;
                            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
                        }
                        catch { }
                    }
                }
            }
            if (state.yolo)
                launchArgs.push(entry.yoloFlag);
            if (state.resume)
                launchArgs.push(...entry.resumeFlag.split(' '));
            const preview = buildCommandPreview(entry, state);
            console.log(chalk_1.default.gray(`→ ${preview}\n`));
            // Emit profile_switch event
            events_1.sweechEvents.emit('profile_switch', {
                account: entry.name,
                timestamp: new Date().toISOString(),
            });
            // Run plugin onLaunch hooks (errors are caught inside runHook)
            try {
                (0, plugins_1.runHook)('onLaunch', entry.name, launchArgs);
            }
            catch { /* plugin errors must not crash CLI */ }
            // Strip nesting vars per AGENTS.md
            delete env.CLAUDECODE;
            delete env.CLAUDE_CODE_ENTRYPOINT;
            const { spawnSync } = require('child_process');
            const result = spawnSync(entry.command, launchArgs, { env, stdio: 'inherit' });
            // If resume failed (no conversation to continue), fall back to a fresh session
            if (result.status !== 0 && state.resume) {
                const freshArgs = launchArgs.filter(a => !entry.resumeFlag.split(' ').includes(a));
                console.log(chalk_1.default.dim('No conversation to resume — starting fresh session\n'));
                const retry = spawnSync(entry.command, freshArgs, { env, stdio: 'inherit' });
                process.exit(retry.status || 0);
            }
            process.exit(result.status || 0);
        };
        filtered.on('keypress', onKeypress);
    });
}
