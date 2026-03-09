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
exports.ConfigManager = exports.SHAREABLE_DIRS = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// Directories that are safe to share across profiles via symlinks.
// These contain memories, transcripts, plans, tasks, commands, plugins.
// NOT included: settings.json, cache, session-env, shell-snapshots, etc. (auth/runtime)
exports.SHAREABLE_DIRS = ['projects', 'plans', 'tasks', 'commands', 'plugins'];
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
        // Remove profile config directory
        const profileDir = this.getProfileDir(commandName);
        if (fs.existsSync(profileDir)) {
            fs.rmSync(profileDir, { recursive: true, force: true });
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
     * Symlink shareable dirs from a new profile to a master profile.
     * Shared dirs: projects, plans, tasks, commands, plugins.
     * Auth and runtime dirs (settings.json, cache, session-env, etc.) remain isolated.
     */
    setupSharedDirs(commandName, masterCommandName) {
        const profileDir = this.getProfileDir(commandName);
        // Master is either 'claude' (default ~/.claude/) or another sweech profile
        const masterDir = masterCommandName === 'claude'
            ? path.join(os.homedir(), '.claude')
            : this.getProfileDir(masterCommandName);
        for (const dir of exports.SHAREABLE_DIRS) {
            const linkPath = path.join(profileDir, dir);
            const targetPath = path.join(masterDir, dir);
            // Ensure target exists in master
            if (!fs.existsSync(targetPath)) {
                fs.mkdirSync(targetPath, { recursive: true });
            }
            // Remove existing dir/symlink in profile if present
            try {
                const stat = fs.lstatSync(linkPath);
                if (stat)
                    fs.rmSync(linkPath, { recursive: true, force: true });
            }
            catch {
                // doesn't exist yet, that's fine
            }
            fs.symlinkSync(targetPath, linkPath);
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
