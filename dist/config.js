"use strict";
/**
 * Configuration manager for sweetch profiles
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
exports.ConfigManager = exports.CODEX_SHAREABLE_DBS = exports.CODEX_SHAREABLE_FILES = exports.CODEX_SHAREABLE_DIRS = exports.SHAREABLE_FILES = exports.SHAREABLE_DIRS = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
// Directories that are safe to share across profiles via symlinks (Claude).
// NOT included: settings.json, cache, session-env, shell-snapshots, history.jsonl (auth/runtime)
exports.SHAREABLE_DIRS = ['projects', 'plans', 'tasks', 'commands', 'plugins', 'hooks', 'agents', 'teams', 'todos'];
// Files that are safe to share across profiles via symlinks (Claude).
exports.SHAREABLE_FILES = ['mcp.json', 'CLAUDE.md'];
// Codex-specific shareable dirs.
// NOT included: auth.json, log, shell_snapshots, sqlite (auth/runtime)
exports.CODEX_SHAREABLE_DIRS = ['sessions', 'archived_sessions', 'memories', 'rules', 'skills'];
// Codex-specific shareable files.
exports.CODEX_SHAREABLE_FILES = ['config.toml', 'history.jsonl', 'models_cache.json'];
// Codex SQLite databases to share. Need WAL flush + merge before symlinking.
exports.CODEX_SHAREABLE_DBS = ['state_5.sqlite', 'logs_1.sqlite'];
class ConfigManager {
    constructor() {
        this.configDir = path.join(os.homedir(), '.sweech');
        this.configFile = path.join(this.configDir, 'config.json');
        this.profilesDir = path.join(this.configDir, 'profiles');
        this.binDir = path.join(this.configDir, 'bin');
        this.ensureDirectories();
    }
    ensureDirectories() {
        [this.configDir, this.profilesDir, this.binDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }
    getProfiles() {
        if (!fs.existsSync(this.configFile)) {
            return [];
        }
        const data = fs.readFileSync(this.configFile, 'utf-8');
        const profiles = JSON.parse(data);
        // Backward compatibility: add cliType if missing
        return profiles.map((p) => ({
            ...p,
            cliType: p.cliType || 'claude'
        }));
    }
    addProfile(profile) {
        const profiles = this.getProfiles();
        // Check if command name already exists
        if (profiles.some(p => p.commandName === profile.commandName)) {
            throw new Error(`Command name '${profile.commandName}' already exists`);
        }
        profiles.push(profile);
        fs.writeFileSync(this.configFile, JSON.stringify(profiles, null, 2));
    }
    removeProfile(commandName) {
        const profiles = this.getProfiles().filter(p => p.commandName !== commandName);
        fs.writeFileSync(this.configFile, JSON.stringify(profiles, null, 2));
        // Remove wrapper script
        const wrapperPath = path.join(this.binDir, commandName);
        if (fs.existsSync(wrapperPath)) {
            fs.unlinkSync(wrapperPath);
        }
        // Remove profile config directory (skip rmSync on symlinks - just unlink them)
        const profileDir = this.getProfileDir(commandName);
        if (fs.existsSync(profileDir)) {
            try {
                const stat = fs.lstatSync(profileDir);
                if (stat.isSymbolicLink()) {
                    fs.unlinkSync(profileDir);
                }
                else {
                    fs.rmSync(profileDir, { recursive: true, force: true });
                }
            }
            catch {
                fs.rmSync(profileDir, { recursive: true, force: true });
            }
        }
    }
    createProfileConfig(commandName, provider, apiKey, cliType = 'claude', oauthToken, useNativeAuth = false) {
        const profileDir = this.getProfileDir(commandName);
        if (!fs.existsSync(profileDir)) {
            fs.mkdirSync(profileDir, { recursive: true });
        }
        const settings = { env: {} };
        // If using native OAuth auth, don't set auth tokens - let CLI handle it
        if (!useNativeAuth) {
            // Determine authentication source
            const authToken = apiKey || (oauthToken?.accessToken ? `bearer_${oauthToken.accessToken}` : '');
            // Set environment variables based on CLI type
            if (cliType === 'codex') {
                // Codex CLI uses OpenAI environment variables
                settings.env.OPENAI_API_KEY = authToken;
                if (provider.baseUrl) {
                    settings.env.OPENAI_BASE_URL = provider.baseUrl;
                }
                if (provider.defaultModel) {
                    settings.env.OPENAI_MODEL = provider.defaultModel;
                }
                if (provider.smallFastModel) {
                    settings.env.OPENAI_SMALL_FAST_MODEL = provider.smallFastModel;
                }
            }
            else {
                // Claude Code CLI uses Anthropic environment variables
                settings.env.ANTHROPIC_AUTH_TOKEN = authToken;
                if (provider.baseUrl) {
                    settings.env.ANTHROPIC_BASE_URL = provider.baseUrl;
                }
                if (provider.defaultModel) {
                    settings.env.ANTHROPIC_MODEL = provider.defaultModel;
                }
                if (provider.smallFastModel) {
                    settings.env.ANTHROPIC_SMALL_FAST_MODEL = provider.smallFastModel;
                }
            }
            // Add timeout for providers that need it
            if (provider.name === 'minimax') {
                settings.env.API_TIMEOUT_MS = '3000000';
            }
            // Store OAuth token info if using OAuth (for refresh purposes)
            if (oauthToken) {
                settings.oauth = {
                    provider: oauthToken.provider,
                    refreshToken: oauthToken.refreshToken,
                    expiresAt: oauthToken.expiresAt
                };
            }
        }
        const settingsPath = path.join(profileDir, 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        // Only create .claude.json to skip onboarding for external providers
        // For official Anthropic/OpenAI with native auth, let the CLI's onboarding flow run
        if (!useNativeAuth) {
            const claudeJsonPath = path.join(profileDir, '.claude.json');
            const claudeConfig = {
                hasCompletedOnboarding: true,
                loginMethod: 'api_key',
                apiKey: 'sk-ant-external-provider',
                userID: this.generateUserID(),
                firstStartTime: new Date().toISOString()
            };
            fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeConfig, null, 2));
        }
    }
    generateUserID() {
        // Generate a deterministic user ID based on timestamp and random data
        const crypto = require('crypto');
        return crypto.randomBytes(32).toString('hex');
    }
    createWrapperScript(commandName, cli) {
        const profileDir = this.getProfileDir(commandName);
        const wrapperPath = path.join(this.binDir, commandName);
        const usageFile = path.join(this.configDir, 'usage.json');
        // Create bash wrapper script with usage tracking
        const wrapperContent = `#!/bin/bash
# 🍭 Sweetch wrapper for ${commandName} (${cli.displayName})

# Log usage (background process to not slow down startup)
(
  USAGE_FILE="${usageFile}"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  # Create or update usage.json
  if [ -f "$USAGE_FILE" ]; then
    CONTENT=$(cat "$USAGE_FILE")
  else
    CONTENT="[]"
  fi

  # Append new record (simple JSON append)
  RECORD="{\\"commandName\\":\\"${commandName}\\",\\"timestamp\\":\\"$TIMESTAMP\\"}"
  UPDATED=$(echo "$CONTENT" | sed "s/\\]$/,$RECORD]/")
  echo "$UPDATED" > "$USAGE_FILE"
) &

# Transform arguments: --yolo -> --dangerously-skip-permissions (Claude Code only)
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--yolo" ] && [ "${cli.command}" = "claude" ]; then
    ARGS+=("--dangerously-skip-permissions")
  else
    ARGS+=("$arg")
  fi
done

export ${cli.configDirEnvVar}="${profileDir}"
exec ${cli.command} "\${ARGS[@]}"
`;
        fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
    }
    getBinDir() {
        return this.binDir;
    }
    getProfileDir(commandName) {
        // Profiles live at ~/.claude-<suffix>/ as siblings to ~/.claude/
        // e.g. claude-rai -> ~/.claude-rai/
        return path.join(os.homedir(), `.${commandName}`);
    }
    /**
     * Symlink shareable dirs and files from a new profile to a master profile.
     * Auth and runtime items remain isolated.
     * Automatically selects the right shareable lists based on CLI type.
     */
    setupSharedDirs(commandName, masterCommandName, cliType) {
        const profileDir = this.getProfileDir(commandName);
        const isCodex = cliType === 'codex'
            || masterCommandName === 'codex'
            || commandName.startsWith('codex');
        // Resolve master dir
        const defaultDirs = ['claude', 'codex'];
        const masterDir = defaultDirs.includes(masterCommandName)
            ? path.join(os.homedir(), `.${masterCommandName}`)
            : this.getProfileDir(masterCommandName);
        const dirs = isCodex ? exports.CODEX_SHAREABLE_DIRS : exports.SHAREABLE_DIRS;
        const files = isCodex ? exports.CODEX_SHAREABLE_FILES : exports.SHAREABLE_FILES;
        for (const dir of dirs) {
            const linkPath = path.join(profileDir, dir);
            const targetPath = path.join(masterDir, dir);
            if (!fs.existsSync(targetPath)) {
                fs.mkdirSync(targetPath, { recursive: true });
            }
            try {
                const stat = fs.lstatSync(linkPath);
                if (stat)
                    fs.rmSync(linkPath, { recursive: true, force: true });
            }
            catch { }
            fs.symlinkSync(targetPath, linkPath);
        }
        for (const file of files) {
            const linkPath = path.join(profileDir, file);
            const targetPath = path.join(masterDir, file);
            if (!fs.existsSync(targetPath)) {
                fs.writeFileSync(targetPath, '');
            }
            try {
                const stat = fs.lstatSync(linkPath);
                if (stat)
                    fs.rmSync(linkPath, { recursive: true, force: true });
            }
            catch { }
            fs.symlinkSync(targetPath, linkPath);
        }
        // For codex profiles, symlink shared SQLite databases
        if (isCodex) {
            for (const db of exports.CODEX_SHAREABLE_DBS) {
                const linkPath = path.join(profileDir, db);
                const targetPath = path.join(masterDir, db);
                // Skip if already a symlink pointing to the right place
                try {
                    const stat = fs.lstatSync(linkPath);
                    if (stat.isSymbolicLink()) {
                        if (fs.readlinkSync(linkPath) === targetPath)
                            continue;
                        fs.unlinkSync(linkPath);
                    }
                    else {
                        // Real file exists — flush WAL and merge before replacing
                        this.flushAndMergeDb(db, linkPath, targetPath);
                    }
                }
                catch { }
                if (!fs.existsSync(targetPath)) {
                    // No master DB yet — just move the pole file there
                    try {
                        const stat = fs.lstatSync(linkPath);
                        if (stat.isFile()) {
                            fs.renameSync(linkPath, targetPath);
                        }
                    }
                    catch { }
                    // Ensure target exists even if no source
                    if (!fs.existsSync(targetPath)) {
                        fs.writeFileSync(targetPath, '');
                    }
                }
                // Clean up WAL/SHM artifacts from the pole copy
                for (const ext of ['-wal', '-shm']) {
                    try {
                        fs.unlinkSync(linkPath + ext);
                    }
                    catch { }
                }
                try {
                    fs.unlinkSync(linkPath);
                }
                catch { }
                fs.symlinkSync(targetPath, linkPath);
            }
            // Create required isolated dirs
            for (const dir of ['log', 'tmp', 'shell_snapshots', 'sqlite']) {
                const d = path.join(profileDir, dir);
                if (!fs.existsSync(d))
                    fs.mkdirSync(d, { recursive: true });
            }
        }
    }
    /**
     * Flush WAL and merge a pole SQLite database into the master copy.
     * After this call the pole file can be safely deleted and replaced with a symlink.
     */
    flushAndMergeDb(dbName, polePath, masterPath) {
        const sqlite3 = (dbPath, sql) => {
            try {
                (0, child_process_1.execFileSync)('sqlite3', [dbPath, sql], { stdio: 'pipe', timeout: 10000 });
            }
            catch { }
        };
        // Flush WAL on both databases
        sqlite3(polePath, 'PRAGMA wal_checkpoint(TRUNCATE);');
        if (fs.existsSync(masterPath)) {
            sqlite3(masterPath, 'PRAGMA wal_checkpoint(TRUNCATE);');
        }
        // Merge divergent data from pole into master (state DB only)
        if (dbName === 'state_5.sqlite' && fs.existsSync(masterPath)) {
            const escapedPole = polePath.replace(/'/g, "''");
            const mergeSQL = [
                `ATTACH '${escapedPole}' AS pole`,
                `INSERT OR IGNORE INTO threads SELECT * FROM pole.threads`,
                `INSERT OR IGNORE INTO thread_dynamic_tools SELECT * FROM pole.thread_dynamic_tools`,
                `INSERT OR IGNORE INTO stage1_outputs SELECT * FROM pole.stage1_outputs`,
                `DETACH pole`,
            ].join('; ');
            sqlite3(masterPath, mergeSQL);
        }
    }
    getConfigDir() {
        return this.configDir;
    }
    getConfigFile() {
        return this.configFile;
    }
    getProfilesDir() {
        return this.profilesDir;
    }
}
exports.ConfigManager = ConfigManager;
