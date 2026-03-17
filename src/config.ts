/**
 * Configuration manager for sweetch profiles
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { ProviderConfig } from './providers';
import { CLIConfig, getDefaultCLI } from './clis';
import { OAuthToken } from './oauth';

export interface ProfileConfig {
  name: string;
  commandName: string;
  cliType: string; // 'claude' or 'codex'
  provider: string;
  apiKey?: string;
  oauth?: OAuthToken;
  baseUrl?: string;
  model?: string;
  smallFastModel?: string;
  createdAt: string;
  sharedWith?: string; // commandName of master profile (e.g. 'claude') if dirs are symlinked
}

// Directories that are safe to share across profiles via symlinks (Claude).
// NOT included: settings.json, cache, session-env, shell-snapshots, history.jsonl (auth/runtime)
export const SHAREABLE_DIRS = ['projects', 'plans', 'tasks', 'commands', 'plugins', 'hooks', 'agents', 'teams', 'todos'] as const;

// Files that are safe to share across profiles via symlinks (Claude).
export const SHAREABLE_FILES = ['mcp.json', 'CLAUDE.md'] as const;

// Codex-specific shareable dirs.
// NOT included: auth.json, log, shell_snapshots, sqlite (auth/runtime)
export const CODEX_SHAREABLE_DIRS = ['sessions', 'archived_sessions', 'memories', 'rules', 'skills'] as const;

// Codex-specific shareable files.
export const CODEX_SHAREABLE_FILES = ['config.toml', 'history.jsonl', 'models_cache.json'] as const;

// Codex SQLite databases to share. Need WAL flush + merge before symlinking.
export const CODEX_SHAREABLE_DBS = ['state_5.sqlite', 'logs_1.sqlite'] as const;

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
  }

  private ensureDirectories(): void {
    [this.configDir, this.profilesDir, this.binDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
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

    profiles.push(profile);
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
    useNativeAuth: boolean = false
  ): void {
    const profileDir = this.getProfileDir(commandName);

    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const settings: any = { env: {} };

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
      } else {
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

  private generateUserID(): string {
    // Generate a deterministic user ID based on timestamp and random data
    const crypto = require('crypto');
    return crypto.randomBytes(32).toString('hex');
  }

  public createWrapperScript(commandName: string, cli: CLIConfig): void {
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

    // For codex profiles, symlink shared SQLite databases
    if (isCodex) {
      for (const db of CODEX_SHAREABLE_DBS) {
        const linkPath = path.join(profileDir, db);
        const targetPath = path.join(masterDir, db);

        // Skip if already a symlink pointing to the right place
        try {
          const stat = fs.lstatSync(linkPath);
          if (stat.isSymbolicLink()) {
            if (fs.readlinkSync(linkPath) === targetPath) continue;
            fs.unlinkSync(linkPath);
          } else if (stat.isFile()) {
            // Real file exists — backup, flush WAL, and merge before replacing
            this.backupFile(linkPath, commandName);
            this.flushAndMergeDb(db, linkPath, targetPath);
          }
        } catch {}

        if (!fs.existsSync(targetPath)) {
          // No master DB yet — move the pole file there instead of symlinking empty
          try {
            if (fs.lstatSync(linkPath).isFile()) {
              fs.renameSync(linkPath, targetPath);
            }
          } catch {}
          if (!fs.existsSync(targetPath)) {
            fs.writeFileSync(targetPath, '');
          }
        }

        // Clean up WAL/SHM artifacts from the pole copy
        for (const ext of ['-wal', '-shm']) {
          try { fs.unlinkSync(linkPath + ext); } catch {}
        }

        try { fs.unlinkSync(linkPath); } catch {}
        fs.symlinkSync(targetPath, linkPath);
      }

      // Create required isolated dirs
      for (const dir of ['log', 'tmp', 'shell_snapshots', 'sqlite']) {
        const d = path.join(profileDir, dir);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      }
    }
  }

  /** Copy a file to ~/.sweech/backups/<profile>/ before destructive operations. */
  private backupFile(srcPath: string, profileName: string): void {
    try {
      const backupDir = path.join(os.homedir(), '.sweech', 'backups', profileName);
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(backupDir, `${path.basename(srcPath)}.${ts}.bak`);
      fs.copyFileSync(srcPath, dest);
    } catch {
      // Backup failed — log but don't abort (merge already happened)
      console.error(`  ⚠  Could not back up ${path.basename(srcPath)} — proceeding anyway`);
    }
  }

  /**
   * Merge a JSONL file from polePath into masterPath, deduplicating by full line content.
   * Appends only lines not already present in master.
   */
  private mergeJsonl(polePath: string, masterPath: string): void {
    try {
      const poleLines = fs.readFileSync(polePath, 'utf-8').split('\n').filter(l => l.trim());
      if (!poleLines.length) return;

      const masterLines = fs.existsSync(masterPath)
        ? new Set(fs.readFileSync(masterPath, 'utf-8').split('\n').filter(l => l.trim()))
        : new Set<string>();

      const newLines = poleLines.filter(l => !masterLines.has(l));
      if (newLines.length) {
        fs.appendFileSync(masterPath, newLines.join('\n') + '\n');
      }
    } catch {
      console.error(`  ⚠  Could not merge ${path.basename(polePath)} — original backed up`);
    }
  }

  /**
   * Flush WAL and merge ALL user data tables from a pole SQLite database into master.
   * Backs up the pole file first. After this call the pole file can be safely replaced with a symlink.
   */
  private flushAndMergeDb(dbName: string, polePath: string, masterPath: string): void {
    const sqlite3 = (dbPath: string, sql: string): boolean => {
      try {
        execFileSync('sqlite3', [dbPath, sql], { stdio: 'pipe', timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    };

    const hasSqlite3 = (() => {
      try { execFileSync('sqlite3', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; }
    })();

    if (!hasSqlite3) {
      console.error(`  ⚠  sqlite3 CLI not found — cannot merge ${dbName}. Original backed up.`);
      return;
    }

    // Flush WAL on both databases so all data is in the main file
    sqlite3(polePath, 'PRAGMA wal_checkpoint(TRUNCATE);');
    if (fs.existsSync(masterPath)) {
      sqlite3(masterPath, 'PRAGMA wal_checkpoint(TRUNCATE);');
    }

    if (!fs.existsSync(masterPath)) return;

    const escapedPole = polePath.replace(/'/g, "''");

    if (dbName === 'state_5.sqlite') {
      // Merge all user-data tables (skip schema migration table)
      const mergeSQL = [
        `ATTACH '${escapedPole}' AS pole`,
        `INSERT OR IGNORE INTO threads SELECT * FROM pole.threads`,
        `INSERT OR IGNORE INTO thread_dynamic_tools SELECT * FROM pole.thread_dynamic_tools`,
        `INSERT OR IGNORE INTO stage1_outputs SELECT * FROM pole.stage1_outputs`,
        `INSERT OR IGNORE INTO agent_jobs SELECT * FROM pole.agent_jobs`,
        `INSERT OR IGNORE INTO agent_job_items SELECT * FROM pole.agent_job_items`,
        `INSERT OR IGNORE INTO jobs SELECT * FROM pole.jobs`,
        `DETACH pole`,
      ].join('; ');
      const ok = sqlite3(masterPath, mergeSQL);
      if (!ok) console.error(`  ⚠  Partial merge failure for ${dbName} — original backed up`);

    } else if (dbName === 'logs_1.sqlite') {
      const mergeSQL = [
        `ATTACH '${escapedPole}' AS pole`,
        `INSERT OR IGNORE INTO logs SELECT * FROM pole.logs`,
        `DETACH pole`,
      ].join('; ');
      const ok = sqlite3(masterPath, mergeSQL);
      if (!ok) console.error(`  ⚠  Partial merge failure for ${dbName} — original backed up`);
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
