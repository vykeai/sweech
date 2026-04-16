"use strict";
/**
 * Configuration manager for sweetch profiles.
 *
 * All paths use path.join() for cross-platform separators.
 *
 * Platform-specific base directories:
 *   - macOS:   /Users/<user>/.sweech/   (config), /Users/<user>/.<name>/   (profiles)
 *   - Linux:   /home/<user>/.sweech/    (config), /home/<user>/.<name>/    (profiles)
 *   - Windows: C:\Users\<user>\.sweech\ (config), C:\Users\<user>\.<name>\ (profiles)
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
// Directories that are safe to share across profiles via symlinks (Claude).
// NOT included: settings.json, cache, session-env, shell-snapshots, history.jsonl (auth/runtime)
// sessions: included so --continue/--resume can find conversations started by other profiles
exports.SHAREABLE_DIRS = ['projects', 'plans', 'tasks', 'commands', 'plugins', 'hooks', 'agents', 'teams', 'todos', 'sessions'];
// Files that are safe to share across profiles via symlinks (Claude).
exports.SHAREABLE_FILES = ['mcp.json', 'CLAUDE.md'];
// Codex-specific shareable dirs.
// NOT included: auth.json, log, shell_snapshots, sqlite (auth/runtime)
// Codex shareable dirs — only conversation data and skills.
// NOT shared: config.toml (may have account-specific settings), state_5.sqlite (rate limit cache).
exports.CODEX_SHAREABLE_DIRS = ['sessions', 'archived_sessions', 'skills'];
// Codex-specific shareable files — only models cache (cosmetic).
// NOT shared: config.toml (account settings), history.jsonl (per-account command history).
exports.CODEX_SHAREABLE_FILES = ['models_cache.json'];
// Codex SQLite databases — only logs (transcripts). state_5.sqlite is NOT shared because
// the codex app-server caches per-account rate limits there — sharing it causes all
// profiles to report the same account's usage.
exports.CODEX_SHAREABLE_DBS = ['logs_1.sqlite'];
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
    createProfileConfig(commandName, provider, apiKey, cliType = 'claude', oauthToken, useNativeAuth = false, modelOverride) {
        const profileDir = this.getProfileDir(commandName);
        if (!fs.existsSync(profileDir)) {
            fs.mkdirSync(profileDir, { recursive: true });
        }
        const settings = { env: {} };
        // If using native OAuth auth, don't set auth tokens - let CLI handle it
        if (!useNativeAuth) {
            // Determine authentication source
            const authToken = apiKey || (oauthToken?.accessToken ? `bearer_${oauthToken.accessToken}` : '');
            // Resolve effective model (profile override > provider default)
            const effectiveModel = modelOverride || provider.defaultModel;
            // Set environment variables based on CLI type
            if (cliType === 'codex') {
                // Codex CLI uses OpenAI environment variables
                // Only set API key if we have one (local providers may have no auth)
                if (authToken) {
                    settings.env.OPENAI_API_KEY = authToken;
                }
                if (provider.baseUrl) {
                    settings.env.OPENAI_BASE_URL = provider.baseUrl;
                }
                if (effectiveModel) {
                    settings.env.OPENAI_MODEL = effectiveModel;
                }
                if (provider.smallFastModel) {
                    settings.env.OPENAI_SMALL_FAST_MODEL = provider.smallFastModel;
                }
            }
            else {
                // Claude Code CLI uses Anthropic environment variables
                // Only set auth token if we have one (local providers may have no auth)
                if (authToken) {
                    settings.env.ANTHROPIC_AUTH_TOKEN = authToken;
                }
                if (provider.baseUrl) {
                    settings.env.ANTHROPIC_BASE_URL = provider.baseUrl;
                }
                if (effectiveModel) {
                    settings.env.ANTHROPIC_MODEL = effectiveModel;
                }
                if (provider.smallFastModel) {
                    settings.env.ANTHROPIC_SMALL_FAST_MODEL = provider.smallFastModel;
                }
            }
            // Add timeout + retries for providers with flaky upstream streams.
            // z.ai (glm) drops SSE connections under load with code 1234; MiniMax
            // has slow cold-starts; Alibaba dashscope occasionally times out.
            // Claude Code's default 60s timeout and 2 retries aren't enough for
            // long tool-use chains through these proxies.
            if (cliType !== 'codex') {
                const providerName = provider.name;
                if (providerName === 'minimax') {
                    settings.env.API_TIMEOUT_MS = '3000000';
                }
                else if (providerName === 'glm' || providerName === 'dashscope' ||
                    providerName === 'kimi' || providerName === 'kimi-coding') {
                    settings.env.API_TIMEOUT_MS = '600000';
                }
                // All external Anthropic-compat providers benefit from extra retries.
                if (providerName !== 'anthropic') {
                    settings.env.ANTHROPIC_MAX_RETRIES = '5';
                }
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

# Skip usage tracking for help/version queries
case "\${1:-}" in
  --help|-h|--version|-V) exec ${cli.command} "$@" ;;
esac

# Transform arguments and intercept --model <id>
ARGS=()
while [ $# -gt 0 ]; do
  case "\$1" in
    --model)
      # Update settings.json so Claude Code picks up the model (env vars get overridden by settings.json)
      SETTINGS="${profileDir}/settings.json"
      if [ -f "\$SETTINGS" ] && command -v python3 &>/dev/null; then
        if [ "${cli.command}" = "claude" ]; then
          python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d.setdefault('env',{})['ANTHROPIC_MODEL']=sys.argv[2];json.dump(d,open(sys.argv[1],'w'),indent=2)" "\$SETTINGS" "\$2"
        else
          python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d.setdefault('env',{})['OPENAI_MODEL']=sys.argv[2];json.dump(d,open(sys.argv[1],'w'),indent=2)" "\$SETTINGS" "\$2"
        fi
      fi
      shift 2
      ;;
    --yolo)
      if [ "${cli.command}" = "claude" ]; then
        ARGS+=("--dangerously-skip-permissions")
      else
        ARGS+=("--yolo")
      fi
      shift
      ;;
    *)
      ARGS+=("\$1")
      shift
      ;;
  esac
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
        if (!fs.existsSync(profileDir)) {
            fs.mkdirSync(profileDir, { recursive: true });
        }
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
            // Skip if already correct symlink
            try {
                if (fs.lstatSync(linkPath).isSymbolicLink() && fs.readlinkSync(linkPath) === targetPath)
                    continue;
            }
            catch { }
            if (!fs.existsSync(targetPath)) {
                fs.writeFileSync(targetPath, '');
            }
            // Backup + merge real files before replacing
            try {
                const stat = fs.lstatSync(linkPath);
                if (stat.isFile()) {
                    this.backupFile(linkPath, commandName);
                    // Merge JSONL files (history.jsonl etc.) by deduplicating into master
                    if (linkPath.endsWith('.jsonl')) {
                        this.mergeJsonl(linkPath, targetPath);
                    }
                    fs.unlinkSync(linkPath);
                }
                else if (!stat.isSymbolicLink()) {
                    fs.rmSync(linkPath, { recursive: true, force: true });
                }
                else {
                    fs.unlinkSync(linkPath);
                }
            }
            catch { }
            fs.symlinkSync(targetPath, linkPath);
        }
        // For codex profiles, symlink shared SQLite DBs (transcripts — NOT auth, NOT usage state)
        if (isCodex) {
            for (const db of exports.CODEX_SHAREABLE_DBS) {
                const linkPath = path.join(profileDir, db);
                const targetPath = path.join(masterDir, db);
                // Skip if already the correct symlink
                try {
                    if (fs.lstatSync(linkPath).isSymbolicLink() && fs.readlinkSync(linkPath) === targetPath)
                        continue;
                }
                catch { }
                // Master DB must exist — don't create empty placeholder DBs
                if (!fs.existsSync(targetPath))
                    continue;
                // Only replace existing symlinks — never overwrite a real DB file
                try {
                    const stat = fs.lstatSync(linkPath);
                    if (!stat.isSymbolicLink())
                        continue;
                    fs.unlinkSync(linkPath);
                }
                catch { }
                fs.symlinkSync(targetPath, linkPath);
            }
            // Create required isolated dirs (auth/runtime — never shared)
            for (const dir of ['log', 'tmp', 'shell_snapshots', 'sqlite']) {
                const d = path.join(profileDir, dir);
                if (!fs.existsSync(d))
                    fs.mkdirSync(d, { recursive: true });
            }
        }
    }
    backupFile(filePath, commandName) {
        const backupDir = path.join(this.configDir, 'backups', commandName);
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        const basename = path.basename(filePath);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `${basename}.${timestamp}.bak`);
        fs.copyFileSync(filePath, backupPath);
    }
    mergeJsonl(sourcePath, targetPath) {
        const existing = new Set();
        if (fs.existsSync(targetPath)) {
            for (const line of fs.readFileSync(targetPath, 'utf-8').split('\n')) {
                if (line.trim())
                    existing.add(line);
            }
        }
        const newLines = fs.readFileSync(sourcePath, 'utf-8').split('\n')
            .filter(l => l.trim() && !existing.has(l));
        if (newLines.length > 0) {
            fs.appendFileSync(targetPath, newLines.join('\n') + '\n');
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
