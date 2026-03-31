"use strict";
/**
 * Share / unshare commands — selective symlink management for profiles.
 *
 * `sweech share <profile>`   — interactively share dirs/files from a source profile
 * `sweech unshare <profile>` — remove shared symlinks and restore isolated dirs/files
 * `sweech share --status`    — show sharing status for all profiles
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
exports.DATA_ITEMS = exports.SKILLS_ITEMS = void 0;
exports.runShare = runShare;
exports.runUnshare = runUnshare;
exports.runShareStatus = runShareStatus;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const chalk_1 = __importDefault(require("chalk"));
const inquirer_1 = __importDefault(require("inquirer"));
const config_1 = require("./config");
// ── Item categorization ──────────────────────────────────────────────────────
/** Skills-related items — default checked in the interactive picker */
exports.SKILLS_ITEMS = ['commands', 'mcp.json', 'hooks', 'agents', 'CLAUDE.md'];
/** Data items — default unchecked */
exports.DATA_ITEMS = ['projects', 'plans', 'tasks', 'todos', 'teams', 'plugins'];
function getShareableItems(cliType) {
    const isCodex = cliType === 'codex';
    const dirs = isCodex ? [...config_1.CODEX_SHAREABLE_DIRS] : [...config_1.SHAREABLE_DIRS];
    const files = isCodex ? [...config_1.CODEX_SHAREABLE_FILES] : [...config_1.SHAREABLE_FILES];
    return [...dirs, ...files];
}
function isSkillsItem(item) {
    return exports.SKILLS_ITEMS.includes(item);
}
function resolveSourceDir(source, config) {
    const defaultDirs = ['claude', 'codex'];
    return defaultDirs.includes(source)
        ? path.join(os.homedir(), `.${source}`)
        : config.getProfileDir(source);
}
function getSharedItems(profileDir, items) {
    const shared = [];
    for (const item of items) {
        const itemPath = path.join(profileDir, item);
        try {
            if (fs.lstatSync(itemPath).isSymbolicLink()) {
                shared.push({ item, target: fs.readlinkSync(itemPath) });
            }
        }
        catch { }
    }
    return shared;
}
// ── sweech share ─────────────────────────────────────────────────────────────
async function runShare(profileName, opts) {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.commandName === profileName);
    if (!profile) {
        console.error(chalk_1.default.red(`\nProfile '${profileName}' not found\n`));
        process.exit(1);
    }
    const source = opts.from || 'claude';
    const sourceDir = resolveSourceDir(source, config);
    if (!fs.existsSync(sourceDir)) {
        console.error(chalk_1.default.red(`\nSource profile directory not found: ${sourceDir}\n`));
        process.exit(1);
    }
    // Prevent circular sharing
    const sourceProfile = profiles.find(p => p.commandName === source);
    if (sourceProfile?.sharedWith === profileName) {
        console.error(chalk_1.default.red(`\nCircular sharing: '${source}' already shares from '${profileName}'\n`));
        process.exit(1);
    }
    const profileDir = config.getProfileDir(profileName);
    const items = getShareableItems(profile.cliType);
    const alreadyShared = getSharedItems(profileDir, items);
    const alreadySet = new Set(alreadyShared.map(s => s.item));
    // Determine which items to share
    let selected;
    if (opts.all) {
        selected = items.filter(item => !alreadySet.has(item));
    }
    else {
        const choices = items.map(item => {
            const isShared = alreadySet.has(item);
            return {
                name: isShared ? `${item}  ${chalk_1.default.dim('(already shared)')}` : item,
                value: item,
                checked: isShared || isSkillsItem(item),
                disabled: isShared ? 'already shared' : false,
            };
        });
        const { items: picked } = await inquirer_1.default.prompt([
            {
                type: 'checkbox',
                name: 'items',
                message: `Share from ${chalk_1.default.cyan(source)} → ${chalk_1.default.bold(profileName)}:`,
                choices,
            },
        ]);
        selected = picked;
    }
    if (selected.length === 0) {
        console.log(chalk_1.default.yellow('\nNothing to share\n'));
        return;
    }
    // Create symlinks
    let linked = 0;
    for (const item of selected) {
        const linkPath = path.join(profileDir, item);
        const targetPath = path.join(sourceDir, item);
        // Ensure target exists
        const isDirItem = !config_1.SHAREABLE_FILES.includes(item)
            && !config_1.CODEX_SHAREABLE_FILES.includes(item);
        if (!fs.existsSync(targetPath)) {
            if (isDirItem) {
                fs.mkdirSync(targetPath, { recursive: true });
            }
            else {
                fs.writeFileSync(targetPath, '');
            }
        }
        // Remove existing item (backup real files/dirs)
        try {
            const stat = fs.lstatSync(linkPath);
            if (stat.isSymbolicLink()) {
                fs.unlinkSync(linkPath);
            }
            else {
                fs.rmSync(linkPath, { recursive: true, force: true });
            }
        }
        catch { }
        fs.symlinkSync(targetPath, linkPath);
        linked++;
    }
    // Update sharedWith in config
    profile.sharedWith = source;
    const allProfiles = profiles.map(p => p.commandName === profileName ? profile : p);
    fs.writeFileSync(config.getConfigFile(), JSON.stringify(allProfiles, null, 2));
    console.log(chalk_1.default.green(`\n✓ Shared ${linked} item(s) from ${chalk_1.default.cyan(source)} → ${chalk_1.default.bold(profileName)}\n`));
    for (const item of selected) {
        console.log(chalk_1.default.dim(`  🔗 ${item}`));
    }
    console.log();
}
// ── sweech unshare ───────────────────────────────────────────────────────────
async function runUnshare(profileName, opts) {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.commandName === profileName);
    if (!profile) {
        console.error(chalk_1.default.red(`\nProfile '${profileName}' not found\n`));
        process.exit(1);
    }
    const profileDir = config.getProfileDir(profileName);
    const items = getShareableItems(profile.cliType);
    const shared = getSharedItems(profileDir, items);
    if (shared.length === 0) {
        console.log(chalk_1.default.dim(`\n  ${profileName} has no shared items\n`));
        return;
    }
    let selected;
    if (opts.all) {
        selected = shared.map(s => s.item);
    }
    else {
        const choices = shared.map(s => ({
            name: `${s.item}  ${chalk_1.default.dim(`→ ${s.target}`)}`,
            value: s.item,
            checked: true,
        }));
        const { items: picked } = await inquirer_1.default.prompt([
            {
                type: 'checkbox',
                name: 'items',
                message: `Unshare from ${chalk_1.default.bold(profileName)}:`,
                choices,
            },
        ]);
        selected = picked;
    }
    if (selected.length === 0) {
        console.log(chalk_1.default.yellow('\nNothing to unshare\n'));
        return;
    }
    let unlinked = 0;
    for (const item of selected) {
        const linkPath = path.join(profileDir, item);
        try {
            fs.unlinkSync(linkPath);
        }
        catch { }
        // Restore empty dir or file
        const isDirItem = !config_1.SHAREABLE_FILES.includes(item)
            && !config_1.CODEX_SHAREABLE_FILES.includes(item);
        if (isDirItem) {
            fs.mkdirSync(linkPath, { recursive: true });
        }
        else {
            fs.writeFileSync(linkPath, '');
        }
        unlinked++;
    }
    // Check if anything is still shared
    const remaining = getSharedItems(profileDir, items);
    if (remaining.length === 0 && profile.sharedWith) {
        delete profile.sharedWith;
        const allProfiles = profiles.map(p => p.commandName === profileName ? profile : p);
        fs.writeFileSync(config.getConfigFile(), JSON.stringify(allProfiles, null, 2));
    }
    console.log(chalk_1.default.green(`\n✓ Unshared ${unlinked} item(s) from ${chalk_1.default.bold(profileName)}`));
    if (remaining.length > 0) {
        console.log(chalk_1.default.dim(`  ${remaining.length} item(s) still shared`));
    }
    console.log();
}
// ── sweech share --status ────────────────────────────────────────────────────
async function runShareStatus() {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    console.log(chalk_1.default.bold('\n  sweech · share status\n'));
    if (profiles.length === 0) {
        console.log(chalk_1.default.dim('  No profiles configured.\n'));
        return;
    }
    // Build reverse map: source → profiles sharing from it
    const reverseMap = new Map();
    for (const p of profiles) {
        if (p.sharedWith) {
            if (!reverseMap.has(p.sharedWith))
                reverseMap.set(p.sharedWith, []);
            reverseMap.get(p.sharedWith).push(p.commandName);
        }
    }
    // Show default CLIs that have dependents
    for (const defaultName of ['claude', 'codex']) {
        const dependents = reverseMap.get(defaultName);
        if (dependents) {
            console.log(`  ${chalk_1.default.bold(defaultName)} ${chalk_1.default.dim('[default]')}`);
            console.log(`    ${chalk_1.default.dim('← shared by:')} ${dependents.join(', ')}`);
            console.log();
        }
    }
    for (const profile of profiles) {
        const profileDir = config.getProfileDir(profile.commandName);
        const items = getShareableItems(profile.cliType);
        const shared = getSharedItems(profileDir, items);
        const dependents = reverseMap.get(profile.commandName);
        console.log(`  ${chalk_1.default.bold(profile.commandName)}`);
        if (dependents) {
            console.log(`    ${chalk_1.default.dim('← shared by:')} ${dependents.join(', ')}`);
        }
        if (shared.length > 0) {
            const source = profile.sharedWith || '?';
            const itemList = shared.map(s => s.item).join(', ');
            console.log(`    ${chalk_1.default.dim('→')} ${chalk_1.default.cyan(source)}  ${chalk_1.default.dim(itemList)}  ${chalk_1.default.dim(`(${shared.length} items)`)}`);
        }
        else {
            console.log(`    ${chalk_1.default.dim('(isolated — no shared items)')}`);
        }
        console.log();
    }
}
