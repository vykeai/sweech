"use strict";
/**
 * Interactive launcher TUI for sweech
 *
 * Arrow keys: select profile
 * y: toggle yolo mode
 * r: toggle resume last chat
 * Enter: launch
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
const STATE_FILE = path.join(os.homedir(), '.sweech', 'last-launch.json');
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
    }
    catch { }
    return { selectedIndex: 0, yolo: false, resume: false };
}
function saveState(state) {
    try {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    }
    catch { }
}
function buildCommandPreview(entry, state) {
    let cmd = entry.name;
    const args = [];
    if (state.yolo)
        args.push(entry.yoloFlag);
    if (state.resume)
        args.push('--continue');
    return `${cmd}${args.length ? ' ' + args.join(' ') : ''}`;
}
function render(entries, state) {
    const lines = [];
    lines.push(chalk_1.default.bold('🍭 Sweech'));
    lines.push('');
    entries.forEach((entry, i) => {
        const selected = i === state.selectedIndex;
        const pointer = selected ? chalk_1.default.cyan('❯') : ' ';
        const name = selected ? chalk_1.default.cyan.bold(entry.name) : chalk_1.default.white(entry.name);
        const sharedIndicator = entry.sharedWith ? chalk_1.default.gray(' [shared]') : '';
        const modelPart = entry.model ? chalk_1.default.gray(` · ${entry.model}`) : '';
        const label = chalk_1.default.gray(`(${entry.label}`) + modelPart + chalk_1.default.gray(')');
        lines.push(`${pointer} ${name}${sharedIndicator} ${label}`);
    });
    lines.push('');
    // Toggles
    const yoloBox = state.yolo ? chalk_1.default.red('[✓]') : chalk_1.default.gray('[ ]');
    const resumeBox = state.resume ? chalk_1.default.green('[✓]') : chalk_1.default.gray('[ ]');
    lines.push(`  ${yoloBox} ${chalk_1.default.white('yolo')} ${chalk_1.default.gray('(y)')}    ${resumeBox} ${chalk_1.default.white('resume')} ${chalk_1.default.gray('(r)')}`);
    lines.push('');
    // Command preview
    const entry = entries[state.selectedIndex];
    const preview = buildCommandPreview(entry, state);
    lines.push(chalk_1.default.gray('  → ') + chalk_1.default.bold.white(preview));
    lines.push('');
    lines.push(chalk_1.default.gray('  ↑↓ select  y yolo  r resume  ⏎ launch  q quit'));
    // Clear screen area and render
    const output = lines.join('\n');
    process.stdout.write(output);
    return;
}
async function runLauncher() {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const entries = [
        {
            name: 'claude',
            command: 'claude',
            configDir: null,
            label: 'default account',
            yoloFlag: (0, clis_1.getCLI)('claude')?.yoloFlag || '--dangerously-skip-permissions'
        },
        ...profiles.map(p => {
            const cliType = p.cliType === 'codex' ? 'codex' : 'claude';
            const cli = (0, clis_1.getCLI)(cliType);
            return {
                name: p.commandName,
                command: cliType,
                configDir: config.getProfileDir(p.commandName),
                label: (0, providers_1.getProvider)(p.provider)?.displayName || p.provider,
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
        console.error(chalk_1.default.red('Error: sweech launcher requires a TTY'));
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
        const launch = () => {
            saveState(state);
            const entry = entries[state.selectedIndex];
            const preview = buildCommandPreview(entry, state);
            console.log(chalk_1.default.gray(`\n→ ${preview}\n`));
            const env = { ...process.env };
            const launchArgs = [];
            if (entry.configDir) {
                const cli = (0, clis_1.getCLI)(entry.command === 'codex' ? 'codex' : 'claude');
                if (cli) {
                    env[cli.configDirEnvVar] = entry.configDir;
                }
            }
            if (state.yolo)
                launchArgs.push(entry.yoloFlag);
            if (state.resume)
                launchArgs.push('--continue');
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
