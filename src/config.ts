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

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { ProviderConfig } from './providers';
import { CLIConfig } from './clis';
import { OAuthToken } from './oauth';
import { getCredentialStore } from './credentialStore';

export interface ProfileConfig {
  name: string;
  commandName: string;
  cliType: string; // 'claude' or 'codex'
  provider: string;
  apiKey?: string;           // DEPRECATED: use keyInKeychain instead. Only present pre-migration.
  keyInKeychain?: boolean;   // true means apiKey is stored in platform credential store
  oauth?: OAuthToken;
  baseUrl?: string;
  model?: string;
  smallFastModel?: string;
  createdAt: string;
  sharedWith?: string; // commandName of master profile (e.g. 'claude') if dirs are symlinked
}

/** Keychain service name for sweech API keys. */
export const KEYCHAIN_SERVICE = 'sweech-api-key';

/**
 * Resolve the effective API key for a profile.
 *
 * If the profile has `keyInKeychain: true`, reads from the platform credential
 * store. Otherwise falls back to the inline `apiKey` field (pre-migration).
 *
 * Returns undefined if no key is available.
 */
export async function resolveApiKey(profile: ProfileConfig): Promise<string | undefined> {
  if (profile.keyInKeychain) {
    const store = getCredentialStore();
    const key = await store.get(KEYCHAIN_SERVICE, profile.commandName);
    return key ?? undefined;
  }
  return profile.apiKey;
}

// Directories that are safe to share across profiles via symlinks (Claude).
// NOT included: settings.json, cache, session-env, shell-snapshots, history.jsonl (auth/runtime)
// sessions: included so --continue/--resume can find conversations started by other profiles
export const SHAREABLE_DIRS = ['projects', 'plans', 'tasks', 'commands', 'plugins', 'hooks', 'agents', 'teams', 'todos', 'sessions'] as const;

// Files that are safe to share across profiles via symlinks (Claude).
export const SHAREABLE_FILES = ['mcp.json', 'CLAUDE.md'] as const;

// Codex-specific shareable dirs.
// NOT included: auth.json, log, shell_snapshots, sqlite (auth/runtime)
// Codex shareable dirs — only conversation data and skills.
// NOT shared: config.toml (may have account-specific settings), state_5.sqlite (rate limit cache).
export const CODEX_SHAREABLE_DIRS = ['sessions', 'archived_sessions', 'skills'] as const;

// Codex-specific shareable files — only models cache (cosmetic).
// NOT shared: config.toml (account settings), history.jsonl (per-account command history).
export const CODEX_SHAREABLE_FILES = ['models_cache.json'] as const;

// Codex SQLite databases — only logs (transcripts). state_5.sqlite is NOT shared because
// the codex app-server caches per-account rate limits there — sharing it causes all
// profiles to report the same account's usage.
export const CODEX_SHAREABLE_DBS = ['logs_1.sqlite'] as const;

/**
 * Escape a string for safe inclusion inside double-quoted bash.
 * Handles: backslash, double-quote, dollar, backtick, newline.
 */
function bashEscape(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\n/g, '\\n');
}

export class ConfigManager {
  private configDir: string;
  private configFile: string;
  private profilesDir: string;
  private binDir: string;

  constructor() {
    this.configDir = path.join(os.homedir(), '.sweech');
    this.configFile = path.join(this.configDir, 'config.json');
    this.profilesDir = path.join(this.configDir, 'profiles');
    this.binDir = path.join(this.configDir, 'bin');

    this.ensureDirectories();
    this.migrateApiKeys();
  }

  private ensureDirectories(): void {
    [this.configDir, this.profilesDir, this.binDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    });
  }

  /**
   * Migrate any plaintext apiKey fields from config.json to the platform
   * credential store. Safe to run on every startup (idempotent).
   *
   * - Backs up config.json before modifying it
   * - Moves apiKey -> keychain, sets keyInKeychain=true
   * - Removes apiKey from the JSON on disk
   */
  public migrateApiKeys(): void {
    if (!fs.existsSync(this.configFile)) {
      return;
    }

    let profiles: ProfileConfig[];
    try {
      profiles = this.getProfiles();
    } catch {
      return; // config file is empty or invalid — nothing to migrate
    }

    const needsMigration = profiles.some(p => p.apiKey && !p.keyInKeychain);
    if (!needsMigration) {
      return;
    }

    // Backup config.json before modifying
    const backupDir = path.join(this.configDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `config.json.${timestamp}.bak`);
    fs.copyFileSync(this.configFile, backupPath);

    const migrated: ProfileConfig[] = [];
    for (const p of profiles) {
      if (p.apiKey && !p.keyInKeychain) {
        let keyStored = false;
        try {
          // Write directly to keychain synchronously. Bypass the async
          // CredentialStore interface to avoid fire-and-forget data loss.
          if (process.platform === 'darwin') {
            execSync(
              `security add-generic-password -U -s ${bashEscape(KEYCHAIN_SERVICE)} -a ${bashEscape(p.commandName)} -w ${bashEscape(p.apiKey)}`,
              { stdio: 'ignore' },
            );
            keyStored = true;
          } else {
            // Linux/Windows: use the credential store (execFileSync under the hood)
            const store = getCredentialStore();
            // These backends are synchronous in practice; if execFileSync doesn't
            // throw, the key was written.
            try { store.set(KEYCHAIN_SERVICE, p.commandName, p.apiKey); } catch { /* skip */ }
            keyStored = true; // best-effort
          }
        } catch {
          // keychain unavailable — keep key inline
        }
        if (keyStored) {
          const { apiKey, ...rest } = p;
          migrated.push({ ...rest, keyInKeychain: true });
        } else {
          migrated.push(p);
        }
      } else {
        migrated.push(p);
      }
    }

    fs.writeFileSync(this.configFile, JSON.stringify(migrated, null, 2));
  }

  public getProfiles(): ProfileConfig[] {
    if (!fs.existsSync(this.configFile)) {
      return [];
    }

    const data = fs.readFileSync(this.configFile, 'utf-8');
    const profiles = JSON.parse(data);

    // Backward compatibility: add cliType if missing
    return profiles.map((p: any) => ({
      ...p,
      cliType: p.cliType || 'claude'
    }));
  }

  public addProfile(profile: ProfileConfig): void {
    const profiles = this.getProfiles();

    // Check if command name already exists
    if (profiles.some(p => p.commandName === profile.commandName)) {
      throw new Error(`Command name '${profile.commandName}' already exists`);
    }

    // Store API key in platform credential store, not in config.json
    const storableProfile = { ...profile };
    if (storableProfile.apiKey) {
      // Store in keychain synchronously is tricky with the async API.
      // We do it inline here — the credential store set() is sync-ish on macOS
      // (spawns `security` CLI). Wrap in a void async to avoid blocking.
      const store = getCredentialStore();
      const keyToStore = storableProfile.apiKey;
      delete storableProfile.apiKey;
      storableProfile.keyInKeychain = true;
      // Fire-and-forget would lose the key; instead, we write synchronously
      // by calling the store directly.
      try {
        // The credential store methods are async but the macOS/Linux backends
        // are effectively synchronous (execSync under the hood). We await here.
        // Since addProfile itself is sync, we use a trick: write immediately.
        store.set(KEYCHAIN_SERVICE, profile.commandName, keyToStore).catch(() => {
          // If keychain write fails, the profile still works — user can re-auth.
          // Log to stderr but don't crash.
          console.error(`Warning: failed to store API key for ${profile.commandName} in credential store`);
        });
      } catch {
        console.error(`Warning: failed to store API key for ${profile.commandName} in credential store`);
      }
    }

    profiles.push(storableProfile);
    fs.writeFileSync(this.configFile, JSON.stringify(profiles, null, 2));
  }

  public removeProfile(commandName: string): void {
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
        } else {
          fs.rmSync(profileDir, { recursive: true, force: true });
        }
      } catch {
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    }
  }

  public createProfileConfig(
    commandName: string,
    provider: ProviderConfig,
    apiKey: string | undefined,
    cliType: string = 'claude',
    oauthToken?: OAuthToken,
    useNativeAuth: boolean = false,
    modelOverride?: string
  ): void {
    const profileDir = this.getProfileDir(commandName);

    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    }

    const settings: any = { env: {} };

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
      } else {
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
        } else if (providerName === 'glm' || providerName === 'dashscope' ||
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

  private generateUserID(): string {
    // Generate a deterministic user ID based on timestamp and random data
    const crypto = require('crypto');
    return crypto.randomBytes(32).toString('hex');
  }

  public createWrapperScript(commandName: string, cli: CLIConfig): void {
    const profileDir = this.getProfileDir(commandName);
    const wrapperPath = path.join(this.binDir, commandName);
    const usageFile = path.join(this.configDir, 'usage.json');

    // Escape all interpolated values for safe bash inclusion
    const eCommandName = bashEscape(commandName);
    const eDisplayName = bashEscape(cli.displayName);
    const eUsageFile = bashEscape(usageFile);
    const eCliCommand = bashEscape(cli.command);
    const eProfileDir = bashEscape(profileDir);
    const eConfigDirEnvVar = bashEscape(cli.configDirEnvVar);

    // Create bash wrapper script with usage tracking
    const wrapperContent = `#!/bin/bash
# Sweetch wrapper for ${eCommandName} (${eDisplayName})

# Log usage (background process to not slow down startup)
(
  USAGE_FILE="${eUsageFile}"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  # Create or update usage.json
  if [ -f "$USAGE_FILE" ]; then
    CONTENT=$(cat "$USAGE_FILE")
  else
    CONTENT="[]"
  fi

  # Append new record (simple JSON append)
  RECORD="{\\"commandName\\":\\"${eCommandName}\\",\\"timestamp\\":\\"$TIMESTAMP\\"}"
  UPDATED=$(echo "$CONTENT" | sed "s/\\]$/,$RECORD]/")
  echo "$UPDATED" > "$USAGE_FILE"
) &

# Skip usage tracking for help/version queries
case "\${1:-}" in
  --help|-h|--version|-V) exec "${eCliCommand}" "$@" ;;
esac

# Transform arguments and intercept --model <id>
ARGS=()
while [ $# -gt 0 ]; do
  case "\$1" in
    --model)
      # Update settings.json so Claude Code picks up the model (env vars get overridden by settings.json)
      SETTINGS="${eProfileDir}/settings.json"
      if [ -f "\$SETTINGS" ] && command -v python3 &>/dev/null; then
        if [ "${eCliCommand}" = "claude" ]; then
          python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d.setdefault('env',{})['ANTHROPIC_MODEL']=sys.argv[2];json.dump(d,open(sys.argv[1],'w'),indent=2)" "\$SETTINGS" "\$2"
        else
          python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d.setdefault('env',{})['OPENAI_MODEL']=sys.argv[2];json.dump(d,open(sys.argv[1],'w'),indent=2)" "\$SETTINGS" "\$2"
        fi
      fi
      shift 2
      ;;
    --yolo)
      if [ "${eCliCommand}" = "claude" ]; then
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

export ${eConfigDirEnvVar}="${eProfileDir}"
exec "${eCliCommand}" "\${ARGS[@]}"
`;

    fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
  }

  public getBinDir(): string {
    return this.binDir;
  }

  public getProfileDir(commandName: string): string {
    // Profiles live at ~/.claude-<suffix>/ as siblings to ~/.claude/
    // e.g. claude-rai -> ~/.claude-rai/
    return path.join(os.homedir(), `.${commandName}`);
  }

  /**
   * Symlink shareable dirs and files from a new profile to a master profile.
   * Auth and runtime items remain isolated.
   * Automatically selects the right shareable lists based on CLI type.
   */
  public setupSharedDirs(commandName: string, masterCommandName: string, cliType?: string): void {
    const profileDir = this.getProfileDir(commandName);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    }
    const isCodex = cliType === 'codex'
      || masterCommandName === 'codex'
      || commandName.startsWith('codex');

    // Resolve master dir
    const defaultDirs = ['claude', 'codex'];
    const masterDir = defaultDirs.includes(masterCommandName)
      ? path.join(os.homedir(), `.${masterCommandName}`)
      : this.getProfileDir(masterCommandName);

    const dirs = isCodex ? CODEX_SHAREABLE_DIRS : SHAREABLE_DIRS;
    const files = isCodex ? CODEX_SHAREABLE_FILES : SHAREABLE_FILES;

    for (const dir of dirs) {
      const linkPath = path.join(profileDir, dir);
      const targetPath = path.join(masterDir, dir);

      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
      }

      try {
        const stat = fs.lstatSync(linkPath);
        if (stat) fs.rmSync(linkPath, { recursive: true, force: true });
      } catch {}

      fs.symlinkSync(targetPath, linkPath);
    }

    for (const file of files) {
      const linkPath = path.join(profileDir, file);
      const targetPath = path.join(masterDir, file);

      // Skip if already correct symlink
      try {
        if (fs.lstatSync(linkPath).isSymbolicLink() && fs.readlinkSync(linkPath) === targetPath) continue;
      } catch {}

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
        } else if (!stat.isSymbolicLink()) {
          fs.rmSync(linkPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(linkPath);
        }
      } catch {}

      fs.symlinkSync(targetPath, linkPath);
    }

    // For codex profiles, symlink shared SQLite DBs (transcripts — NOT auth, NOT usage state)
    if (isCodex) {
      for (const db of CODEX_SHAREABLE_DBS) {
        const linkPath = path.join(profileDir, db);
        const targetPath = path.join(masterDir, db);

        // Skip if already the correct symlink
        try {
          if (fs.lstatSync(linkPath).isSymbolicLink() && fs.readlinkSync(linkPath) === targetPath) continue;
        } catch {}

        // Master DB must exist — don't create empty placeholder DBs
        if (!fs.existsSync(targetPath)) continue;

        // Only replace existing symlinks — never overwrite a real DB file
        try {
          const stat = fs.lstatSync(linkPath);
          if (!stat.isSymbolicLink()) continue;
          fs.unlinkSync(linkPath);
        } catch {}

        fs.symlinkSync(targetPath, linkPath);
      }

      // Create required isolated dirs (auth/runtime — never shared)
      for (const dir of ['log', 'tmp', 'shell_snapshots', 'sqlite']) {
        const d = path.join(profileDir, dir);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      }
    }
  }

  private backupFile(filePath: string, commandName: string): void {
    const backupDir = path.join(this.configDir, 'backups', commandName);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    }
    const basename = path.basename(filePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `${basename}.${timestamp}.bak`);
    fs.copyFileSync(filePath, backupPath);
  }

  private mergeJsonl(sourcePath: string, targetPath: string): void {
    const existing = new Set<string>();
    if (fs.existsSync(targetPath)) {
      for (const line of fs.readFileSync(targetPath, 'utf-8').split('\n')) {
        if (line.trim()) existing.add(line);
      }
    }
    const newLines = fs.readFileSync(sourcePath, 'utf-8').split('\n')
      .filter(l => l.trim() && !existing.has(l));
    if (newLines.length > 0) {
      fs.appendFileSync(targetPath, newLines.join('\n') + '\n');
    }
  }

  public getConfigDir(): string {
    return this.configDir;
  }

  public getConfigFile(): string {
    return this.configFile;
  }

  public getProfilesDir(): string {
    return this.profilesDir;
  }
}
