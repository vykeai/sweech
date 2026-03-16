"use strict";
/**
 * Git-based config sync for sweech profiles.
 *
 * Copies non-secret config files into ~/.sweech/sync/ and manages a git
 * repo there so profiles can be pushed/pulled across machines.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSync = initSync;
exports.pushSync = pushSync;
exports.pullSync = pullSync;
exports.getSyncStatus = getSyncStatus;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
// ── Constants ────────────────────────────────────────────────────────────────
const SWEECH_DIR = path.join(os.homedir(), '.sweech');
const SYNC_DIR = path.join(SWEECH_DIR, 'sync');
const SYNC_META = path.join(SYNC_DIR, '.sync-meta.json');
/** Config files that are safe to sync (no tokens or secrets). */
const SYNCABLE_FILES = [
    'config.json',
    'subscriptions.json',
    'webhooks.json',
    'routing.json',
];
/** Files that must never be committed. */
const GITIGNORE_CONTENT = `# sweech sync — never commit secrets
tokens.json
*.key
*.pem
.env
`;
// ── Helpers ──────────────────────────────────────────────────────────────────
function git(args, cwd = SYNC_DIR) {
    return (0, child_process_1.execSync)(`git ${args}`, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
function readMeta() {
    try {
        return JSON.parse(fs.readFileSync(SYNC_META, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeMeta(meta) {
    fs.writeFileSync(SYNC_META, JSON.stringify(meta, null, 2));
}
/**
 * Copy every syncable file that exists in ~/.sweech/ into the sync directory.
 */
function copySyncableFiles() {
    for (const file of SYNCABLE_FILES) {
        const src = path.join(SWEECH_DIR, file);
        const dest = path.join(SYNC_DIR, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
        }
    }
}
// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Initialise the sync directory as a git repo and optionally add a remote.
 *
 * - Creates ~/.sweech/sync/ if it doesn't exist.
 * - Runs `git init` (idempotent).
 * - Writes a .gitignore that excludes tokens.json and other secrets.
 * - Copies current config files into the sync dir.
 * - Adds the remote origin if `remoteUrl` is provided.
 */
async function initSync(remoteUrl) {
    ensureDir(SYNC_DIR);
    // Initialise repo (safe to call on an existing repo)
    git('init', SYNC_DIR);
    // Write .gitignore
    fs.writeFileSync(path.join(SYNC_DIR, '.gitignore'), GITIGNORE_CONTENT);
    // Copy syncable config files
    copySyncableFiles();
    // Stage everything
    git('add -A');
    // Initial commit (skip if nothing to commit)
    try {
        git('diff --cached --quiet');
    }
    catch {
        // There are staged changes — commit them
        git('commit -m "sweech: initial sync"');
    }
    // Set remote
    if (remoteUrl) {
        try {
            git('remote remove origin');
        }
        catch {
            // No existing origin — that's fine
        }
        git(`remote add origin ${remoteUrl}`);
    }
    // Record initialisation time
    const meta = readMeta();
    meta.initializedAt = new Date().toISOString();
    if (remoteUrl) {
        meta.remote = remoteUrl;
    }
    writeMeta(meta);
}
/**
 * Stage current config files, commit, and push to remote.
 */
async function pushSync() {
    if (!fs.existsSync(path.join(SYNC_DIR, '.git'))) {
        throw new Error('Sync not initialised. Run initSync() first.');
    }
    // Refresh files
    copySyncableFiles();
    git('add -A');
    // Check if there's anything to commit
    try {
        git('diff --cached --quiet');
        // No changes — but still push in case local is ahead of remote
    }
    catch {
        const timestamp = new Date().toISOString();
        git(`commit -m "sweech: sync ${timestamp}"`);
    }
    git('push origin HEAD');
    // Update meta
    const meta = readMeta();
    meta.lastSync = new Date().toISOString();
    writeMeta(meta);
}
/**
 * Pull latest changes from remote, rebasing local commits on top.
 */
async function pullSync() {
    if (!fs.existsSync(path.join(SYNC_DIR, '.git'))) {
        throw new Error('Sync not initialised. Run initSync() first.');
    }
    git('pull --rebase origin HEAD');
    // Copy synced files back into ~/.sweech/
    for (const file of SYNCABLE_FILES) {
        const src = path.join(SYNC_DIR, file);
        const dest = path.join(SWEECH_DIR, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
        }
    }
    // Update meta
    const meta = readMeta();
    meta.lastSync = new Date().toISOString();
    writeMeta(meta);
}
/**
 * Return the current sync status without performing any git operations that
 * touch the network.
 */
function getSyncStatus() {
    const initialized = fs.existsSync(path.join(SYNC_DIR, '.git'));
    if (!initialized) {
        return { initialized: false };
    }
    let remote;
    try {
        remote = git('remote get-url origin') || undefined;
    }
    catch {
        // No remote configured
    }
    const meta = readMeta();
    return {
        initialized: true,
        remote,
        lastSync: meta.lastSync,
    };
}
