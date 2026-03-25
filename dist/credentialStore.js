"use strict";
/**
 * Cross-platform credential store abstraction.
 *
 * - macOS:   delegates to the system Keychain via `security` CLI
 * - Linux:   tries `secret-tool` (libsecret) with fallback to file-based store
 * - Windows: tries `cmdkey` with fallback to file-based store
 * - Others:  file-based store at ~/.sweech/tokens.json
 *
 * Also exports `computeKeychainServiceName` which centralises the
 * service-name derivation previously duplicated across liveUsage.ts
 * and subscriptions.ts.
 *
 * The high-level `readCredential(service, account)` helper provides a
 * single entry point that auto-selects the right backend.
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
exports.FileTokenStore = exports.WindowsCmdkeyStore = exports.LinuxSecretToolStore = exports.MacOSKeychainStore = void 0;
exports.isSecretToolAvailable = isSecretToolAvailable;
exports.isCmdkeyAvailable = isCmdkeyAvailable;
exports.getCredentialStore = getCredentialStore;
exports.readCredential = readCredential;
exports.computeKeychainServiceName = computeKeychainServiceName;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const node_child_process_1 = require("node:child_process");
const platform_1 = require("./platform");
// ── macOS Keychain ───────────────────────────────────────────────────────────
class MacOSKeychainStore {
    async get(service, account) {
        try {
            const raw = (0, node_child_process_1.execSync)(`security find-generic-password -s ${escapeShellArg(service)} -a ${escapeShellArg(account)} -w`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            return raw || null;
        }
        catch {
            return null;
        }
    }
    async set(service, account, password) {
        try {
            (0, node_child_process_1.execSync)(`security add-generic-password -U -s ${escapeShellArg(service)} -a ${escapeShellArg(account)} -w ${escapeShellArg(password)}`, { stdio: 'ignore' });
        }
        catch {
            // add-generic-password can fail if the keychain is locked; callers
            // should handle the rejected promise.
            throw new Error(`Failed to write credential for service="${service}" account="${account}" to macOS Keychain`);
        }
    }
    async delete(service, account) {
        try {
            (0, node_child_process_1.execSync)(`security delete-generic-password -s ${escapeShellArg(service)} -a ${escapeShellArg(account)}`, { stdio: 'ignore' });
        }
        catch {
            // Not found or already deleted — treat as success.
        }
    }
}
exports.MacOSKeychainStore = MacOSKeychainStore;
/** Escape a value for safe inclusion in a single-quoted shell argument. */
function escapeShellArg(val) {
    return "'" + val.replace(/'/g, "'\\''") + "'";
}
// ── Linux secret-tool (libsecret/GNOME Keyring) ─────────────────────────────
class LinuxSecretToolStore {
    async get(service, account) {
        try {
            const raw = (0, node_child_process_1.execFileSync)('secret-tool', [
                'lookup', 'service', service, 'account', account,
            ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            return raw || null;
        }
        catch {
            return null;
        }
    }
    async set(service, account, password) {
        try {
            // secret-tool reads the secret from stdin
            (0, node_child_process_1.execSync)(`echo ${escapeShellArg(password)} | secret-tool store --label ${escapeShellArg('sweech:' + service)} service ${escapeShellArg(service)} account ${escapeShellArg(account)}`, { stdio: 'ignore' });
        }
        catch {
            throw new Error(`Failed to write credential for service="${service}" account="${account}" via secret-tool`);
        }
    }
    async delete(service, account) {
        try {
            (0, node_child_process_1.execFileSync)('secret-tool', [
                'clear', 'service', service, 'account', account,
            ], { stdio: 'ignore' });
        }
        catch {
            // Not found or already deleted — treat as success.
        }
    }
}
exports.LinuxSecretToolStore = LinuxSecretToolStore;
/**
 * Check whether `secret-tool` is available on PATH.
 */
function isSecretToolAvailable() {
    try {
        (0, node_child_process_1.execFileSync)('which', ['secret-tool'], { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
// ── Windows cmdkey ───────────────────────────────────────────────────────────
class WindowsCmdkeyStore {
    target(service, account) {
        return `sweech:${service}:${account}`;
    }
    async get(service, account) {
        // cmdkey /list does not expose passwords via CLI. On Windows, the
        // file-based store is the practical backend for value retrieval.
        const file = new FileTokenStore();
        return file.get(service, account);
    }
    async set(service, account, password) {
        // Store in file store (primary) and register with cmdkey for listing.
        const file = new FileTokenStore();
        await file.set(service, account, password);
        try {
            (0, node_child_process_1.execSync)(`cmdkey /generic:${this.target(service, account)} /user:${account} /pass:*`, { stdio: 'ignore' });
        }
        catch {
            // Fall through — file store is the primary backend on Windows.
        }
    }
    async delete(service, account) {
        const file = new FileTokenStore();
        await file.delete(service, account);
        try {
            (0, node_child_process_1.execSync)(`cmdkey /delete:${this.target(service, account)}`, { stdio: 'ignore' });
        }
        catch {
            // Not found or already deleted.
        }
    }
}
exports.WindowsCmdkeyStore = WindowsCmdkeyStore;
/**
 * Check whether `cmdkey` is available (Windows only).
 */
function isCmdkeyAvailable() {
    try {
        (0, node_child_process_1.execSync)('where cmdkey', { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
// ── File-based fallback ──────────────────────────────────────────────────────
const TOKENS_DIR = path.join(os.homedir(), '.sweech');
const TOKENS_FILE = path.join(TOKENS_DIR, 'tokens.json');
class FileTokenStore {
    async get(service, account) {
        const store = readTokenFile();
        return store[`${service}:${account}`] ?? null;
    }
    async set(service, account, password) {
        const store = readTokenFile();
        store[`${service}:${account}`] = password;
        writeTokenFile(store);
    }
    async delete(service, account) {
        const store = readTokenFile();
        delete store[`${service}:${account}`];
        writeTokenFile(store);
    }
}
exports.FileTokenStore = FileTokenStore;
function readTokenFile() {
    try {
        return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeTokenFile(store) {
    fs.mkdirSync(TOKENS_DIR, { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
    // Ensure permissions are correct even if the file already existed.
    try {
        fs.chmodSync(TOKENS_FILE, 0o600);
    }
    catch {
        // chmod may fail on Windows — file store still works.
    }
}
// ── Factory ──────────────────────────────────────────────────────────────────
/**
 * Return the platform-appropriate credential store.
 *
 * - macOS   -> MacOSKeychainStore   (uses `security` CLI)
 * - Linux   -> LinuxSecretToolStore (uses `secret-tool`) with FileTokenStore fallback
 * - Windows -> WindowsCmdkeyStore   (cmdkey + file fallback)
 * - Others  -> FileTokenStore       (uses ~/.sweech/tokens.json)
 */
function getCredentialStore() {
    if ((0, platform_1.isMacOS)()) {
        return new MacOSKeychainStore();
    }
    if ((0, platform_1.isLinux)() && isSecretToolAvailable()) {
        return new LinuxSecretToolStore();
    }
    if ((0, platform_1.isWindows)()) {
        return new WindowsCmdkeyStore();
    }
    return new FileTokenStore();
}
// ── High-level helper ────────────────────────────────────────────────────────
/**
 * Read a credential from the platform-appropriate store.
 *
 * This is the recommended single entry point for callers that just need
 * to read a stored secret.
 */
async function readCredential(service, account) {
    const store = getCredentialStore();
    return store.get(service, account);
}
// ── Keychain service name helper ─────────────────────────────────────────────
/**
 * Compute the Keychain service name for a given Claude Code config directory.
 *
 * Matches the native binary's behaviour:
 *   - Default profile (~/.claude): "Claude Code-credentials"
 *   - Custom profile: "Claude Code-credentials-{sha256(configDir).slice(0,8)}"
 *
 * This consolidates the logic previously duplicated in liveUsage.ts and
 * subscriptions.ts.
 */
function computeKeychainServiceName(configDir) {
    const defaultDir = path.join(os.homedir(), '.claude');
    if (configDir === defaultDir) {
        return 'Claude Code-credentials';
    }
    const hash = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    return `Claude Code-credentials-${hash}`;
}
