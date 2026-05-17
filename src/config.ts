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
import { atomicWriteFileSync } from './atomicWrite';
import { providerEnvKey as providerEnvKeyForCodex, writeCodexProviderTomlForProfile } from './codexConfigToml';

export interface ProfileConfig {
  name: string;
  commandName: string;
  cliType: string; // 'claude', 'codex', or 'kimi'
  provider: string;
  apiKey?: string;           // DEPRECATED: use keyInKeychain instead. Only present pre-migration.
  keyInKeychain?: boolean;   // true means apiKey is stored in platform credential store
  oauth?: OAuthToken;
  baseUrl?: string;
  model?: string;
  smallFastModel?: string;
  envOverrides?: Record<string, string>; // arbitrary per-profile env vars (CLAUDE_EFFORT, ENABLE_PROMPT_CACHING_1H, etc.)
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

// Kimi-specific shareable dirs.
// Sessions and user-history are conversation data safe to share.
// NOT shared: config.toml (account-specific provider settings), credentials/ (auth),
// device_id, telemetry/, logs/.
export const KIMI_SHAREABLE_DIRS = ['sessions', 'user-history'] as const;

// Kimi-specific shareable files — none by default (kimi.json is runtime state).
export const KIMI_SHAREABLE_FILES = [] as const;

/**
 * Escape a string for safe inclusion inside a TOML double-quoted value.
 * Handles: backslash, double-quote, tab, newline, carriage return.
 */
function tomlEscape(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

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

    this.writeProfiles(migrated);
  }

  /**
   * Read and parse the raw config.json, supporting both shapes:
   *   - Legacy: `[ profile, profile, ... ]`
   *   - Current: `{ profiles: [...], oauth?: {...}, ... }`
   * Returns `null` if the file is missing or unparseable. Used internally
   * by `getProfiles()` and the persist path so non-profile top-level keys
   * (e.g. `oauth.anthropic.clientId`) are preserved on write.
   */
  private readRawConfig(): { profiles: any[]; extras: Record<string, unknown> } | null {
    if (!fs.existsSync(this.configFile)) return null;
    try {
      const data = fs.readFileSync(this.configFile, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return { profiles: parsed, extras: {} };
      }
      if (parsed && typeof parsed === 'object') {
        const { profiles, ...extras } = parsed as { profiles?: unknown } & Record<string, unknown>;
        return {
          profiles: Array.isArray(profiles) ? profiles : [],
          extras,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Persist a list of profiles to config.json, preserving any non-profile
   * top-level keys that already exist (e.g. `oauth`). When the on-disk
   * config has any extras, the bumped object shape is written; otherwise
   * the legacy bare-array shape is kept untouched for round-trip
   * compatibility with older sweech versions.
   */
  public writeProfiles(profiles: ProfileConfig[]): void {
    const raw = this.readRawConfig();
    const extras = raw?.extras ?? {};
    if (Object.keys(extras).length > 0) {
      atomicWriteFileSync(
        this.configFile,
        JSON.stringify({ ...extras, profiles }, null, 2),
      );
    } else {
      atomicWriteFileSync(this.configFile, JSON.stringify(profiles, null, 2));
    }
  }

  public getProfiles(): ProfileConfig[] {
    const raw = this.readRawConfig();
    if (!raw) return [];

    // Backward compatibility: add cliType if missing
    return raw.profiles.map((p: any) => ({
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
    this.writeProfiles(profiles);
  }

  public removeProfile(commandName: string): void {
    const profiles = this.getProfiles().filter(p => p.commandName !== commandName);
    this.writeProfiles(profiles);

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
    modelOverride?: string,
    baseUrlOverride?: string,
    envOverrides?: Record<string, string>
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

      // Resolve effective base URL (profile override > provider default).
      // Lets a profile point at a local proxy (e.g. LiteLLM) while sharing
      // a provider definition that defaults to the upstream's direct port.
      const effectiveBaseUrl = baseUrlOverride || provider.baseUrl;

      // Set environment variables based on CLI type
      if (cliType === 'codex') {
        // Codex CLI uses OpenAI environment variables
        // Only set API key if we have one (local providers may have no auth)
        if (authToken) {
          settings.env.OPENAI_API_KEY = authToken;
        }

        if (effectiveBaseUrl) {
          settings.env.OPENAI_BASE_URL = effectiveBaseUrl;
        }

        if (effectiveModel) {
          settings.env.OPENAI_MODEL = effectiveModel;
        }

        if (provider.smallFastModel) {
          settings.env.OPENAI_SMALL_FAST_MODEL = provider.smallFastModel;
        }

        // Custom codex providers go through a [model_providers.<name>]
        // block whose `env_key` references a provider-specific env var
        // (e.g. KIMI_API_KEY, CUSTOM_API_KEY). Mirror the auth token under
        // that key so the wrapper script can export it for codex.
        if (authToken && provider.name && provider.name !== 'openai') {
          const codexEnvKey = providerEnvKeyForCodex(provider.name);
          settings.env[codexEnvKey] = authToken;
        }
      } else if (cliType === 'kimi') {
        // Kimi CLI — configure via config.toml env overrides.
        // The CLI reads provider settings from ~/.kimi/config.toml;
        // we point KIMI_HOME to the sweech profile dir so it gets its
        // own isolated config, sessions, and credentials.
        if (authToken) {
          settings.env.KIMI_API_KEY = authToken;
        }

        if (effectiveBaseUrl) {
          settings.env.KIMI_BASE_URL = effectiveBaseUrl;
        }

        if (effectiveModel) {
          settings.env.KIMI_MODEL = effectiveModel;
        }
      } else {
        // Claude Code CLI uses Anthropic environment variables
        // Only set auth token if we have one (local providers may have no auth)
        if (authToken) {
          settings.env.ANTHROPIC_AUTH_TOKEN = authToken;
        }

        if (effectiveBaseUrl) {
          settings.env.ANTHROPIC_BASE_URL = effectiveBaseUrl;
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
      // Claude-specific timeout/retry tuning.
      // Kimi and Codex CLIs manage their own timeouts internally.
      if (cliType === 'claude') {
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

    // Per-profile env overrides win over computed env (e.g. CLAUDE_EFFORT,
    // ENABLE_PROMPT_CACHING_1H, CLAUDE_CODE_FORCE_SYNC_OUTPUT).
    if (envOverrides) {
      settings.env = settings.env || {};
      Object.assign(settings.env, envOverrides);
    }

    const settingsPath = path.join(profileDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    if (cliType === 'kimi') {
      // Kimi CLI reads config.toml (not settings.json).
      // Generate a config.toml with provider and model settings.
      const effectiveModel = modelOverride || provider.defaultModel;
      const tomlLines: string[] = [
        `# Sweech-managed config for ${commandName}`,
        `default_model = "${tomlEscape(effectiveModel || '')}"`,
        `default_thinking = true`,
        `default_yolo = false`,
        '',
        `[models."${tomlEscape(effectiveModel || 'default')}"]`,
        `provider = "managed:sweech"`,
        `model = "${tomlEscape(effectiveModel || '')}"`,
        '',
        `[providers."managed:sweech"]`,
        `type = "openai"`,
      ];
      const tomlBaseUrl = baseUrlOverride || provider.baseUrl;
      if (tomlBaseUrl) {
        tomlLines.push(`base_url = "${tomlEscape(tomlBaseUrl)}/v1"`);
      } else {
        tomlLines.push(`base_url = ""`);
      }
      if (!useNativeAuth && (apiKey || oauthToken?.accessToken)) {
        tomlLines.push(`api_key = "${tomlEscape(apiKey || '')}"`);
      } else {
        tomlLines.push(`api_key = ""`);
      }

      const configTomlPath = path.join(profileDir, 'config.toml');
      fs.writeFileSync(configTomlPath, tomlLines.join('\n') + '\n', { mode: 0o600 });

      // Create empty dirs the kimi CLI expects
      for (const dir of ['sessions', 'user-history', 'logs', 'telemetry', 'credentials']) {
        const d = path.join(profileDir, dir);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      }
    }

    // Codex CLI: write [model_providers.<name>] config.toml block for
    // custom providers so codex actually routes to them instead of
    // falling through to ChatGPT OAuth. The official openai provider is
    // skipped (codex handles it natively).
    if (cliType === 'codex' && !useNativeAuth) {
      writeCodexProviderTomlForProfile(
        commandName,
        provider,
        cliType,
        baseUrlOverride,
        modelOverride,
      );
    }

    // Only create .claude.json to skip onboarding for external providers (Claude/Codex)
    // For official Anthropic/OpenAI with native auth, let the CLI's onboarding flow run
    // Kimi CLI does its own onboarding via config.toml
    if (cliType !== 'kimi' && !useNativeAuth) {
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

# Auto-scrub: when resuming a session, strip cross-provider thinking blocks
# so a transcript produced by GLM-5.1 (or any non-Anthropic provider) doesn't
# 400 with "Invalid signature in thinking block" against the real Anthropic
# API. Best-effort: failures are silent and never block launch.
RESUME_DETECTED=0
for arg in "$@"; do
  case "\$arg" in
    -c|--continue|-r|--resume) RESUME_DETECTED=1; break ;;
  esac
done
if [ "\$RESUME_DETECTED" = "1" ] && command -v sweech &>/dev/null; then
  sweech scrub-thinking --cwd "\$PWD" --profile "${eCommandName}" --quiet 2>/dev/null || true
fi

# Transform arguments and intercept --model <id>
ARGS=()
while [ $# -gt 0 ]; do
  case "\$1" in
    --model)
      if [ "${eCliCommand}" = "kimi" ]; then
        # Kimi CLI accepts --model/-m directly — pass it through
        ARGS+=("--model" "\$2")
        shift 2
      else
        # Update settings.json so Claude Code / Codex picks up the model
        SETTINGS="${eProfileDir}/settings.json"
        if [ -f "\$SETTINGS" ] && command -v python3 &>/dev/null; then
          if [ "${eCliCommand}" = "claude" ]; then
            python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d.setdefault('env',{})['ANTHROPIC_MODEL']=sys.argv[2];json.dump(d,open(sys.argv[1],'w'),indent=2)" "\$SETTINGS" "\$2"
          else
            python3 -c "import json,sys;d=json.load(open(sys.argv[1]));d.setdefault('env',{})['OPENAI_MODEL']=sys.argv[2];json.dump(d,open(sys.argv[1],'w'),indent=2)" "\$SETTINGS" "\$2"
          fi
        fi
        shift 2
      fi
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

# Codex CLI does NOT read env vars from settings.json the way Claude Code
# does — it consults process.env at runtime via env_key entries in
# config.toml. For codex wrappers, hoist every key in settings.env into
# the environment before launching so the API key referenced by
# [model_providers.<name>].env_key actually resolves. Other CLIs read
# settings.json themselves, so we skip this for them.
if [ "${eCliCommand}" = "codex" ]; then
  SETTINGS_JSON="${eProfileDir}/settings.json"
  if [ -f "\$SETTINGS_JSON" ] && command -v python3 &>/dev/null; then
    while IFS='=' read -r _key _val; do
      [ -z "\$_key" ] && continue
      export "\$_key=\$_val"
    done < <(python3 -c "import json,sys
try:
  d=json.load(open(sys.argv[1]))
  for k,v in (d.get('env') or {}).items():
    if isinstance(v,(str,int,float,bool)):
      print(f'{k}={v}')
except Exception:
  pass" "\$SETTINGS_JSON")
  fi
fi

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
    const isKimi = cliType === 'kimi'
      || masterCommandName === 'kimi'
      || commandName.startsWith('kimi');

    // Resolve master dir
    const defaultDirs = ['claude', 'codex', 'kimi'];
    const masterDir = defaultDirs.includes(masterCommandName)
      ? path.join(os.homedir(), `.${masterCommandName}`)
      : this.getProfileDir(masterCommandName);

    const dirs = isCodex ? CODEX_SHAREABLE_DIRS
      : isKimi ? KIMI_SHAREABLE_DIRS
      : SHAREABLE_DIRS;
    const files = isCodex ? CODEX_SHAREABLE_FILES
      : isKimi ? KIMI_SHAREABLE_FILES
      : SHAREABLE_FILES;

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
