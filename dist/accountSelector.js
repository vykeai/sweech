"use strict";
/**
 * Reusable account enumeration for sweech.
 *
 * Extracts the launcher's account-building logic into standalone helpers
 * so that other modules (server, CLI commands, tests) can list and filter
 * accounts without depending on the TUI.
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
exports.enumerateAccounts = enumerateAccounts;
exports.getAvailableAccounts = getAvailableAccounts;
exports.getAccountsByType = getAccountsByType;
exports.getBestAccount = getBestAccount;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const config_1 = require("./config");
const clis_1 = require("./clis");
// ─── Helpers ────────────────────────────────────────────────────────
/** Check whether a CLI binary is reachable on the PATH. */
function isInstalled(command) {
    try {
        (0, child_process_1.execSync)(`which ${command}`, { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
/** Default config directory for a built-in CLI (e.g. ~/.claude, ~/.codex). */
function defaultConfigDir(command) {
    return path.join(os.homedir(), `.${command}`);
}
// ─── Core enumeration ───────────────────────────────────────────────
/**
 * Build the full list of known accounts — both built-in defaults and
 * sweech-managed profiles.
 *
 * When `profiles` is omitted the current on-disk config is read
 * automatically via ConfigManager.
 */
function enumerateAccounts(profiles) {
    const resolvedProfiles = profiles ?? new config_1.ConfigManager().getProfiles();
    const entries = [];
    const seen = new Set();
    // 1. Default accounts for every installed CLI
    for (const cli of Object.values(clis_1.SUPPORTED_CLIS)) {
        if (!isInstalled(cli.command))
            continue;
        entries.push({
            name: cli.command,
            commandName: cli.command,
            cliType: cli.name,
            configDir: defaultConfigDir(cli.command),
            isDefault: true,
            isManaged: false,
        });
        seen.add(cli.command);
    }
    // 2. Sweech-managed profiles
    for (const p of resolvedProfiles) {
        if (seen.has(p.commandName))
            continue;
        const cliType = p.cliType === 'codex' ? 'codex' : 'claude';
        entries.push({
            name: p.name || p.commandName,
            commandName: p.commandName,
            cliType,
            configDir: path.join(os.homedir(), `.${p.commandName}`),
            isDefault: false,
            isManaged: true,
        });
        seen.add(p.commandName);
    }
    // 3. Group: claude (defaults first, then profiles), then codex
    return [
        ...entries.filter(e => e.cliType !== 'codex' && e.isDefault),
        ...entries.filter(e => e.cliType !== 'codex' && !e.isDefault),
        ...entries.filter(e => e.cliType === 'codex' && e.isDefault),
        ...entries.filter(e => e.cliType === 'codex' && !e.isDefault),
    ];
}
// ─── Filtered views ─────────────────────────────────────────────────
/**
 * Same as `enumerateAccounts` but only returns entries whose config
 * directory actually exists on disk.
 */
function getAvailableAccounts(profiles) {
    return enumerateAccounts(profiles).filter(e => fs.existsSync(e.configDir));
}
/**
 * Return accounts that match a specific CLI type (e.g. "claude" or "codex").
 */
function getAccountsByType(cliType, profiles) {
    return enumerateAccounts(profiles).filter(e => e.cliType === cliType);
}
/**
 * Return the "best" account to use right now.
 *
 * Placeholder implementation: returns the first account from the
 * enumerated list. A future version will consult usage/limit data and
 * skip accounts that have hit their rate-limit window.
 */
function getBestAccount(profiles) {
    const accounts = enumerateAccounts(profiles);
    return accounts[0];
}
