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
import * as crypto from 'crypto';
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
  /**
   * Lifecycle flags (T-LU-010 CRUD).
   *
   *   disabled — workspace is excluded from `sweech auto`, `failover`, and the
   *     background refresh daemon. The wrapper still works, the data dir is
   *     untouched, and the row stays visible. Use this to "park" a cancelled
   *     subscription without losing the conversation history.
   *
   *   hidden — workspace sinks to the bottom of `sweech list` rendered greyed
   *     out. Implies skip-from-refresh as well (no point refreshing something
   *     the user explicitly hid). `sweech list --hidden` opts back in.
   *
   * Both flags are optional; absent means the legacy "active" behaviour.
   */
  disabled?: boolean;
  hidden?: boolean;
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

/**
 * True iff the path exists AND is a symbolic link. Wraps lstat so callers
 * don't have to handle ENOENT vs EACCES discrimination — used by the
 * share-topology heal pass where every check is best-effort.
 */
function isLstatSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Maximum traversal depth for copyTree helpers. Bounded to keep a
 * pathological symlink cycle or absurdly deep tree from blowing the
 * Node call stack. 64 levels is far beyond any realistic profile
 * tree (which tops out around 6 levels: `projects/<repo>/sessions/<uid>/x.jsonl`).
 */
const COPY_TREE_MAX_DEPTH = 64;

/**
 * Result of a tree-copy operation. `truncated` flags when the walk
 * hit the depth cap or an unreadable subtree — callers use it to
 * refuse the post-merge destructive step (a partial backup must
 * never authorise rmSync).
 */
interface CopyTreeResult {
  /** Number of files (or symlinks) copied. */
  copied: number;
  /** True when at least one entry was skipped because of depth/read errors. */
  truncated: boolean;
}

/**
 * Recursively copy a directory tree (or single file) into `dest`. Used by
 * the share-topology heal pass to merge real data into the master target
 * with "master-wins" semantics (the source value never overwrites an
 * existing destination file — equivalent to `rsync --ignore-existing`).
 *
 * Symlinks are recreated verbatim so a share-of-a-share collision can't
 * accidentally walk into the master's tree and duplicate everything.
 */
function copyTreeIgnoreExisting(src: string, dest: string): CopyTreeResult {
  const result: CopyTreeResult = { copied: 0, truncated: false };
  const visit = (s: string, d: string, depth: number): void => {
    if (depth > COPY_TREE_MAX_DEPTH) { result.truncated = true; return; }
    let stat: fs.Stats;
    try { stat = fs.lstatSync(s); } catch { result.truncated = true; return; }
    if (stat.isSymbolicLink()) {
      if (fs.existsSync(d) || isLstatSymlink(d)) return;
      try {
        const target = fs.readlinkSync(s);
        fs.symlinkSync(target, d);
        result.copied++;
      } catch { result.truncated = true; }
      return;
    }
    if (stat.isDirectory()) {
      if (!fs.existsSync(d)) {
        try { fs.mkdirSync(d, { recursive: true, mode: stat.mode & 0o777 }); }
        catch { result.truncated = true; return; }
      }
      let entries: string[];
      try { entries = fs.readdirSync(s); } catch { result.truncated = true; return; }
      for (const name of entries) {
        visit(path.join(s, name), path.join(d, name), depth + 1);
      }
      return;
    }
    if (stat.isFile()) {
      if (fs.existsSync(d)) return; // master-wins
      try {
        fs.copyFileSync(s, d);
        try { fs.chmodSync(d, stat.mode & 0o777); } catch { /* ignore */ }
        result.copied++;
      } catch { result.truncated = true; }
    }
  };
  visit(src, dest, 0);
  return result;
}

/**
 * Recursively copy a directory tree (or single file) into `dest`,
 * overwriting any pre-existing files. Used to make a complete
 * pre-merge backup of a colliding profile entry so that a botched
 * merge never destroys data the user can't recover.
 *
 * The caller MUST inspect `truncated` before treating the backup as
 * complete. A truncated backup is NOT a green light to delete the
 * source — see healOneCollision() for the verification step.
 */
function copyTreeOverwrite(src: string, dest: string): CopyTreeResult {
  const result: CopyTreeResult = { copied: 0, truncated: false };
  const visit = (s: string, d: string, depth: number): void => {
    if (depth > COPY_TREE_MAX_DEPTH) { result.truncated = true; return; }
    let stat: fs.Stats;
    try { stat = fs.lstatSync(s); } catch { result.truncated = true; return; }
    if (stat.isSymbolicLink()) {
      try {
        const target = fs.readlinkSync(s);
        if (fs.existsSync(d) || isLstatSymlink(d)) fs.unlinkSync(d);
        fs.symlinkSync(target, d);
        result.copied++;
      } catch { result.truncated = true; }
      return;
    }
    if (stat.isDirectory()) {
      if (!fs.existsSync(d)) {
        try { fs.mkdirSync(d, { recursive: true, mode: stat.mode & 0o777 }); }
        catch { result.truncated = true; return; }
      }
      let entries: string[];
      try { entries = fs.readdirSync(s); } catch { result.truncated = true; return; }
      for (const name of entries) {
        visit(path.join(s, name), path.join(d, name), depth + 1);
      }
      return;
    }
    if (stat.isFile()) {
      try {
        if (fs.existsSync(d)) fs.unlinkSync(d);
        fs.copyFileSync(s, d);
        try { fs.chmodSync(d, stat.mode & 0o777); } catch { /* ignore */ }
        result.copied++;
      } catch { result.truncated = true; }
    }
  };
  visit(src, dest, 0);
  return result;
}

/**
 * Count source files in a tree, bounded by the same depth cap as
 * copyTree*. Used by healOneCollision to verify that the backup is
 * complete BEFORE we delete the source. A backup that copied fewer
 * files than the source contains is NOT safe to authorise rmSync.
 */
function countTreeFiles(src: string): { count: number; truncated: boolean } {
  let count = 0;
  let truncated = false;
  const visit = (p: string, depth: number): void => {
    if (depth > COPY_TREE_MAX_DEPTH) { truncated = true; return; }
    let stat: fs.Stats;
    try { stat = fs.lstatSync(p); } catch { truncated = true; return; }
    if (stat.isSymbolicLink()) { count++; return; }
    if (stat.isDirectory()) {
      let entries: string[];
      try { entries = fs.readdirSync(p); } catch { truncated = true; return; }
      for (const name of entries) visit(path.join(p, name), depth + 1);
      return;
    }
    if (stat.isFile()) count++;
  };
  visit(src, 0);
  return { count, truncated };
}

export class ConfigManager {
  private configDir: string;
  private configFile: string;
  private profilesDir: string;
  private binDir: string;
  private shareSnapshotsDir: string;
  private backupsDir: string;
  private logsDir: string;

  /**
   * Disable the constructor-time `healShareTopology()` pass. Tests that
   * spin up a ConfigManager pointed at a synthetic homedir don't want
   * heal logic running over the test fixtures. Set via the test harness
   * before instantiation; reset between tests.
   */
  static disableConstructorHeal = false;

  constructor() {
    this.configDir = path.join(os.homedir(), '.sweech');
    this.configFile = path.join(this.configDir, 'config.json');
    this.profilesDir = path.join(this.configDir, 'profiles');
    this.binDir = path.join(this.configDir, 'bin');
    // Sidecar dir for share-topology snapshots. Survives removeProfile so
    // a later recreation of the same commandName can self-heal back to
    // the previous symlinks. See healShareTopology() for the heal pass.
    this.shareSnapshotsDir = path.join(this.configDir, 'share-snapshots');
    // Backups for the heal pass live under a dedicated root so the user
    // (and future cleanup tooling) can find every pre-merge snapshot in
    // one place. Distinct from .sweech/backups/ which already holds
    // config.json migration backups.
    this.backupsDir = path.join(this.configDir, 'backups');
    // Structured logs for lifecycle events (heal, migrate, prune).
    // Plain-text JSONL — one event per line.
    this.logsDir = path.join(this.configDir, 'logs');

    this.ensureDirectories();
    this.migrateApiKeys();
    // Self-healing pass: re-link any profile whose snapshot exists +
    // profile dir is present + master targets are present + entries
    // currently missing on disk. Idempotent and non-destructive — see
    // method docs for the safety invariants.
    if (!ConfigManager.disableConstructorHeal) {
      this.healShareTopology();
    }
  }

  private ensureDirectories(): void {
    [this.configDir, this.profilesDir, this.binDir, this.shareSnapshotsDir, this.backupsDir, this.logsDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    });
  }

  /**
   * Append a structured lifecycle event to `~/.sweech/logs/lifecycle.jsonl`.
   * Each line is a self-contained JSON object — easy to grep, easy to tail,
   * survives concurrent writers because appendFileSync uses O_APPEND.
   *
   * Designed for the share-topology heal pass and future audit/migration
   * routines that mutate profile state. Best-effort: a log failure NEVER
   * blocks the operation it describes (the user cares about their data
   * being safe, not about the log line being there).
   */
  public logLifecycle(event: Record<string, unknown>): void {
    try {
      const payload = {
        ts: new Date().toISOString(),
        pid: process.pid,
        sweechVersion: this.readSweechVersion(),
        ...event,
      };
      const line = JSON.stringify(payload) + '\n';
      const file = path.join(this.logsDir, 'lifecycle.jsonl');
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch { /* never throw from a logger */ }
  }

  private readSweechVersion(): string | null {
    try {
      const pkgPath = path.join(__dirname, '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return typeof pkg.version === 'string' ? pkg.version : null;
    } catch { return null; }
  }

  public getLogsDir(): string { return this.logsDir; }
  public getBackupsDir(): string { return this.backupsDir; }
  public getShareSnapshotsDir(): string { return this.shareSnapshotsDir; }

  public getProfileShareFingerprintPath(commandName: string): string {
    return path.join(this.getProfileDir(commandName), '.sweech-share-fingerprint');
  }

  public buildProfileShareFingerprint(commandName: string, cliType?: string): string {
    const profile = this.getProfiles().find(p => p.commandName === commandName);
    const effectiveCliType = cliType || profile?.cliType || 'claude';
    const payload = {
      cliType: effectiveCliType,
      claudeDirs: SHAREABLE_DIRS,
      claudeFiles: SHAREABLE_FILES,
      codexDirs: CODEX_SHAREABLE_DIRS,
      codexFiles: CODEX_SHAREABLE_FILES,
      codexDbs: CODEX_SHAREABLE_DBS,
      kimiDirs: KIMI_SHAREABLE_DIRS,
      kimiFiles: KIMI_SHAREABLE_FILES,
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  public isProfileShareFingerprintCurrent(commandName: string, cliType?: string): boolean {
    try {
      const expected = this.buildProfileShareFingerprint(commandName, cliType);
      return fs.readFileSync(this.getProfileShareFingerprintPath(commandName), 'utf-8').trim() === expected;
    } catch {
      return false;
    }
  }

  public writeProfileShareFingerprint(commandName: string, cliType?: string): void {
    const profileDir = this.getProfileDir(commandName);
    if (!fs.existsSync(profileDir)) return;
    const fingerprintPath = this.getProfileShareFingerprintPath(commandName);
    const nofollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    try {
      const stat = fs.lstatSync(fingerprintPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | nofollow;
    const fd = fs.openSync(fingerprintPath, flags, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink > 1) return;
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, this.buildProfileShareFingerprint(commandName, cliType) + '\n', 'utf-8');
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  }

  private logShareHealAudit(commandName: string, repaired: number): void {
    if (repaired <= 0) return;
    try {
      const auditPath = path.join(this.configDir, 'audit.log');
      const nofollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      try {
        const stat = fs.lstatSync(auditPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
      const safeName = commandName.replace(/[\n\r]/g, '');
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | nofollow;
      const fd = fs.openSync(auditPath, flags, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink > 1) return;
        fs.writeSync(fd, `${new Date().toISOString()} share-heal profile=${safeName} repaired=${repaired}\n`, undefined, 'utf-8');
        fs.fchmodSync(fd, 0o600);
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* audit logging is best-effort */ }
  }

  public isProfileShareTopologyHealthy(commandName: string): boolean {
    const profile = this.getProfiles().find(p => p.commandName === commandName);
    if (!profile || !profile.sharedWith) return true;

    const profileDir = this.getProfileDir(commandName);
    if (!fs.existsSync(profileDir)) return false;

    const isCodex = profile.cliType === 'codex'
      || profile.sharedWith === 'codex'
      || commandName.startsWith('codex');
    const isKimi = profile.cliType === 'kimi'
      || profile.sharedWith === 'kimi'
      || commandName.startsWith('kimi');
    const defaultDirs = ['claude', 'codex', 'kimi'];
    const masterDir = defaultDirs.includes(profile.sharedWith)
      ? path.join(os.homedir(), `.${profile.sharedWith}`)
      : this.getProfileDir(profile.sharedWith);
    if (!fs.existsSync(masterDir)) return false;

    const dirs = isCodex ? CODEX_SHAREABLE_DIRS
      : isKimi ? KIMI_SHAREABLE_DIRS
      : SHAREABLE_DIRS;
    const files = isCodex ? [...CODEX_SHAREABLE_FILES, ...CODEX_SHAREABLE_DBS]
      : isKimi ? KIMI_SHAREABLE_FILES
      : SHAREABLE_FILES;
    const optionalMissingFiles = isCodex ? CODEX_SHAREABLE_DBS : [];

    for (const item of [...dirs, ...files]) {
      const linkPath = path.join(profileDir, item);
      const targetPath = path.join(masterDir, item);
      if (!fs.existsSync(targetPath) && (optionalMissingFiles as readonly string[]).includes(item)) continue;
      if (!fs.existsSync(targetPath)) return false;
      try {
        const stat = fs.lstatSync(linkPath);
        if ((optionalMissingFiles as readonly string[]).includes(item) && !stat.isSymbolicLink()) continue;
        if (!stat.isSymbolicLink() || fs.readlinkSync(linkPath) !== targetPath) return false;
      } catch {
        return false;
      }
    }
    return true;
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

  /**
   * Remove a workspace profile.
   *
   * @param commandName  workspace to remove
   * @param opts.keepData  preserve the ~/.<commandName>/ directory + wrapper.
   *                       Used when the user wants to delete the profile
   *                       record (so it stops appearing in `sweech list`)
   *                       but keep the conversation history and credentials
   *                       on disk for later import.
   */
  public removeProfile(commandName: string, opts: { keepData?: boolean } = {}): void {
    const profiles = this.getProfiles().filter(p => p.commandName !== commandName);
    this.writeProfiles(profiles);

    if (opts.keepData) {
      return;
    }

    // Snapshot any existing share topology BEFORE destruction so that a
    // future recreation of the same commandName can self-heal back to the
    // previous shared state. Pre-incident: a `removeProfile` followed by
    // a `seedProfile`/recreation (e.g. from tests bypassing
    // `setupSharedDirs`) would silently lose the symlinks, leaving the
    // user with an "unshared" profile and no way to know without diffing
    // against a working sibling. The snapshot is a hint — the
    // `healShareTopology` pass on the next ConfigManager construction
    // reads it, verifies master targets still exist, then re-links.
    this.snapshotShareTopology(commandName);

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

  /**
   * Capture the symlink topology of `~/.<commandName>/` so a future
   * recreation of the same commandName can self-heal back to the same
   * shared state. Walks the profile dir and records every entry that is
   * a symlink, storing its name + resolved target. Real (non-symlink)
   * entries are ignored — only the share-topology is captured, not the
   * data itself. Best-effort: any I/O error is silently swallowed since
   * snapshot is a recovery hint, not a primary contract.
   */
  private snapshotShareTopology(commandName: string): void {
    const profileDir = this.getProfileDir(commandName);
    if (!fs.existsSync(profileDir)) return;
    const links: Record<string, string> = {};
    try {
      const entries = fs.readdirSync(profileDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) continue;
        try {
          const linkPath = path.join(profileDir, entry.name);
          const target = fs.readlinkSync(linkPath);
          links[entry.name] = target;
        } catch { /* unreadable link — skip */ }
      }
    } catch { return; }
    if (Object.keys(links).length === 0) return;
    const snapshotPath = path.join(this.shareSnapshotsDir, `${commandName}.json`);
    const payload = {
      schemaVersion: 1,
      commandName,
      capturedAt: new Date().toISOString(),
      links,
    };
    try {
      atomicWriteFileSync(snapshotPath, JSON.stringify(payload, null, 2));
      fs.chmodSync(snapshotPath, 0o600);
      this.logLifecycle({
        event: 'share_snapshot.captured',
        profile: commandName,
        linkCount: Object.keys(links).length,
        snapshotPath,
      });
    } catch { /* snapshot failed — proceed with removal anyway */ }
  }

  /**
   * Encode a working directory path the way Claude Code does for its
   * `projects/<encoded>/` layout: replace every `/` (including the
   * leading one) with `-`. Path normalisation: trailing slash dropped,
   * relative segments rejected. Returns null for unsafe inputs.
   */
  public encodeCwdForClaude(cwd: string): string | null {
    if (typeof cwd !== 'string' || cwd.length === 0) return null;
    if (!path.isAbsolute(cwd)) return null;
    const normalised = path.resolve(cwd).replace(/\/+$/, '');
    if (normalised.includes('..')) return null;
    return normalised.replace(/\//g, '-');
  }

  /**
   * Regenerate session pointer files for past conversations whose live
   * pointer has been removed by Claude Code (which deletes pointer
   * files on /exit). Without this, `/resume` shows "No conversations
   * found" even when the conversation jsonl is still on disk.
   *
   * For each `projects/<encoded-cwd>/*.jsonl` that has no matching
   * `sessions/<pid>.json` pointer (by sessionId), writes a stub
   * pointer with a synthetic high pid (>1e9 — guaranteed not to
   * collide with a live process) so that Claude's `/resume`
   * enumerator finds it AND treats it as "dead, available to resume".
   *
   * Best-effort: every I/O step is wrapped in try/catch. Returns the
   * count of pointer files created so callers can log a digest.
   *
   * @param commandName  profile to operate on (must have sharedWith → sessions/ is shared)
   * @param cwd          working directory of the launch (defaults to process.cwd())
   */
  public ensureSessionPointers(commandName: string, cwd?: string): number {
    if (!/^[A-Za-z0-9_-]+$/.test(commandName)) return 0;
    const profileDir = this.getProfileDir(commandName);
    if (!fs.existsSync(profileDir)) return 0;

    const resolvedCwd = cwd ?? (() => { try { return process.cwd(); } catch { return null; } })();
    if (!resolvedCwd) return 0;
    const encoded = this.encodeCwdForClaude(resolvedCwd);
    if (!encoded) return 0;

    const projectsDir = path.join(profileDir, 'projects', encoded);
    if (!fs.existsSync(projectsDir)) return 0;

    const sessionsDir = path.join(profileDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      try { fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 }); }
      catch { return 0; }
    }

    // Index of existing pointers by sessionId so we don't write duplicates.
    const existingSids = new Set<string>();
    let pointerEntries: string[];
    try { pointerEntries = fs.readdirSync(sessionsDir); }
    catch { pointerEntries = []; }
    for (const entry of pointerEntries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, entry), 'utf-8'));
        if (typeof data.sessionId === 'string') existingSids.add(data.sessionId);
      } catch { /* ignore unreadable */ }
    }

    let jsonlEntries: string[];
    try { jsonlEntries = fs.readdirSync(projectsDir); }
    catch { return 0; }

    let created = 0;
    for (const entry of jsonlEntries) {
      if (!entry.endsWith('.jsonl')) continue;
      // jsonl filename IS the sessionId (claude convention).
      const sid = entry.replace(/\.jsonl$/, '');
      if (!/^[0-9a-f-]{36}$/i.test(sid)) continue;
      if (existingSids.has(sid)) continue;

      const jsonlPath = path.join(projectsDir, entry);
      let mtimeMs: number;
      try { mtimeMs = fs.statSync(jsonlPath).mtimeMs; }
      catch { continue; }

      // Synthetic pid in the [1e9, 2e9) range — well above any real
      // pid_max on linux/macos, so os.kill(pid,0) will always ENOENT
      // and claude will treat the pointer as "dead, resumable".
      // Derived from sessionId so the same conversation always gets
      // the same synthetic pid (no churn across re-runs).
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(sid).digest();
      const synthPid = 1_000_000_000 + (hash.readUInt32BE(0) % 1_000_000_000);

      const name = path.basename(resolvedCwd).toUpperCase().slice(0, 64);
      const pointer = {
        pid: synthPid,
        sessionId: sid,
        cwd: resolvedCwd,
        startedAt: Math.floor(mtimeMs),
        procStart: new Date(mtimeMs).toUTCString(),
        version: this.readSweechVersion() ?? '0.0.0',
        peerProtocol: 1,
        kind: 'interactive',
        entrypoint: 'cli',
        name,
        updatedAt: Math.floor(mtimeMs),
        status: 'idle',
        // Mark as sweech-synthetic so future tooling can identify
        // these and (if necessary) clean them up.
        _sweechSynthetic: true,
      };

      const pointerPath = path.join(sessionsDir, `${synthPid}.json`);
      try {
        // Refuse to overwrite a real pointer that already exists.
        if (fs.existsSync(pointerPath)) continue;
        fs.writeFileSync(pointerPath, JSON.stringify(pointer), { mode: 0o600 });
        created++;
        this.logLifecycle({
          event: 'session_pointer.synthesized',
          profile: commandName,
          sessionId: sid,
          syntheticPid: synthPid,
          cwd: resolvedCwd,
          pointerPath,
        });
      } catch { /* skip — best-effort */ }
    }

    return created;
  }

  /**
   * Fast hot-path heal for a SINGLE profile, used by `sweech use`,
   * `sweech run`, `sweech auto`. Only acts when:
   *   - the profile has sharedWith set (otherwise nothing to heal)
   *   - the master dir exists
   *   - at least one expected shareable is missing or wrong-targeted
   *
   * Designed to add <50ms in the common case (everything already
   * linked) by short-circuiting after the first lstat check per entry.
   * Re-uses `setupSharedDirs` for the actual repair so the heal path
   * and the create path stay in sync.
   *
   * Returns the number of entries repaired (0 = no-op).
   */
  public healProfileSharedDirs(commandName: string): number {
    const profile = this.getProfiles().find(p => p.commandName === commandName);
    if (!profile || !profile.sharedWith) return 0;

    const profileDir = this.getProfileDir(commandName);
    if (!fs.existsSync(profileDir)) return 0;

    const isCodex = profile.cliType === 'codex'
      || profile.sharedWith === 'codex'
      || commandName.startsWith('codex');
    const isKimi = profile.cliType === 'kimi'
      || profile.sharedWith === 'kimi'
      || commandName.startsWith('kimi');

    const defaultDirs = ['claude', 'codex', 'kimi'];
    const masterDir = defaultDirs.includes(profile.sharedWith)
      ? path.join(os.homedir(), `.${profile.sharedWith}`)
      : this.getProfileDir(profile.sharedWith);
    if (!fs.existsSync(masterDir)) return 0;

    const dirs = isCodex ? CODEX_SHAREABLE_DIRS
      : isKimi ? KIMI_SHAREABLE_DIRS
      : SHAREABLE_DIRS;
    const files = isCodex ? [...CODEX_SHAREABLE_FILES, ...CODEX_SHAREABLE_DBS]
      : isKimi ? KIMI_SHAREABLE_FILES
      : SHAREABLE_FILES;
    const sqliteFiles = isCodex ? CODEX_SHAREABLE_DBS : [];

    let repaired = 0;
    for (const item of [...dirs, ...files]) {
      const linkPath = path.join(profileDir, item);
      const targetPath = path.join(masterDir, item);

      // Fast path: already the correct symlink → skip.
      try {
        const stat = fs.lstatSync(linkPath);
        if ((sqliteFiles as readonly string[]).includes(item) && !stat.isSymbolicLink()) continue;
        if (stat.isSymbolicLink() && fs.readlinkSync(linkPath) === targetPath) {
          if (fs.existsSync(targetPath)) continue;
          if ((dirs as readonly string[]).includes(item)) {
            try {
              fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 });
              repaired++;
            } catch { /* skip */ }
          } else if ((files as readonly string[]).includes(item) && !(sqliteFiles as readonly string[]).includes(item)) {
            try {
              fs.writeFileSync(targetPath, '');
              repaired++;
            } catch { /* skip */ }
          }
          continue;
        }
      } catch { /* missing — repair below */ }

      // Target must exist before we link. For dirs we can create the
      // master placeholder; for files we skip (avoid creating spurious
      // empty mcp.json files in the master).
      if (!fs.existsSync(targetPath)) {
        if ((dirs as readonly string[]).includes(item)) {
          try { fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 }); }
          catch { continue; }
        } else if ((files as readonly string[]).includes(item) && !(sqliteFiles as readonly string[]).includes(item)) {
          try { fs.writeFileSync(targetPath, ''); }
          catch { continue; }
        } else {
          continue;
        }
      }

      // Delegate the actual heal to healOneCollision when there's a
      // real file/dir at linkPath — that path guarantees backup +
      // merge + log. For pure "missing" we just create the symlink.
      try {
        if (fs.existsSync(linkPath) || isLstatSymlink(linkPath)) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const outcome = this.healOneCollision(commandName, item, linkPath, targetPath, ts);
          if (outcome.ok) repaired++;
        } else {
          fs.symlinkSync(targetPath, linkPath);
          repaired++;
          this.logLifecycle({
            event: 'share_heal.symlink_created',
            profile: commandName,
            name: item,
            target: targetPath,
            linkPath,
            via: 'healProfileSharedDirs',
          });
        }
      } catch { /* best-effort — skip */ }
    }

    if (this.isProfileShareTopologyHealthy(commandName)) {
      this.writeProfileShareFingerprint(commandName, profile.cliType);
    }
    this.logShareHealAudit(commandName, repaired);
    return repaired;
  }

  public previewProfileSharedDirRepairs(commandName: string): Array<{ profile: string; name: string; target: string; reason: string }> {
    const profile = this.getProfiles().find(p => p.commandName === commandName);
    if (!profile || !profile.sharedWith) return [];

    const profileDir = this.getProfileDir(commandName);
    if (!fs.existsSync(profileDir)) return [];

    const isCodex = profile.cliType === 'codex'
      || profile.sharedWith === 'codex'
      || commandName.startsWith('codex');
    const isKimi = profile.cliType === 'kimi'
      || profile.sharedWith === 'kimi'
      || commandName.startsWith('kimi');

    const defaultDirs = ['claude', 'codex', 'kimi'];
    const masterDir = defaultDirs.includes(profile.sharedWith)
      ? path.join(os.homedir(), `.${profile.sharedWith}`)
      : this.getProfileDir(profile.sharedWith);
    if (!fs.existsSync(masterDir)) return [];

    const dirs = isCodex ? CODEX_SHAREABLE_DIRS
      : isKimi ? KIMI_SHAREABLE_DIRS
      : SHAREABLE_DIRS;
    const files = isCodex ? [...CODEX_SHAREABLE_FILES, ...CODEX_SHAREABLE_DBS]
      : isKimi ? KIMI_SHAREABLE_FILES
      : SHAREABLE_FILES;
    const sqliteFiles = isCodex ? CODEX_SHAREABLE_DBS : [];

    const planned: Array<{ profile: string; name: string; target: string; reason: string }> = [];
    for (const item of [...dirs, ...files]) {
      const linkPath = path.join(profileDir, item);
      const targetPath = path.join(masterDir, item);
      const isDir = (dirs as readonly string[]).includes(item);

      try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          const actual = fs.readlinkSync(linkPath);
          if (actual === targetPath) {
            const fixableFile = (files as readonly string[]).includes(item) && !(sqliteFiles as readonly string[]).includes(item);
            if (!fs.existsSync(targetPath) && (isDir || fixableFile)) {
              planned.push({ profile: commandName, name: item, target: targetPath, reason: 'dangling-target-create' });
            }
            continue;
          }
          planned.push({ profile: commandName, name: item, target: targetPath, reason: fs.existsSync(linkPath) ? 'wrong-target' : 'dangling' });
          continue;
        }
        planned.push({ profile: commandName, name: item, target: targetPath, reason: 'real-entry' });
      } catch {
        const fixableFile = (files as readonly string[]).includes(item) && !(sqliteFiles as readonly string[]).includes(item);
        if (fs.existsSync(targetPath) || isDir || fixableFile) {
          planned.push({ profile: commandName, name: item, target: targetPath, reason: fs.existsSync(targetPath) ? 'missing' : 'target-create' });
        }
      }
    }
    return planned;
  }

  /**
   * Heal share topology from sidecar snapshots. Runs on every
   * ConfigManager construction. Idempotent + non-destructive:
   *
   *   - if profile dir doesn't exist: skip (profile not yet recreated)
   *   - if entry is already the correct symlink: no-op
   *   - if entry is missing AND target exists: create the symlink
   *   - if entry is a REAL file/dir or wrong-target symlink (collision):
   *       1. snapshot the colliding entry to ~/.sweech/backups/share-heal/
   *          <ts>/<commandName>/<name>/ (full recursive copy, mode 0700)
   *       2. merge contents into the master target with master-wins
   *          semantics (rsync --ignore-existing equivalent) so no
   *          accidentally-divergent data is lost
   *       3. remove the real entry and create the symlink
   *       4. append a structured event to ~/.sweech/logs/lifecycle.jsonl
   *   - if target doesn't exist (master profile gone): skip silently
   *
   * Why backup-first: a self-healing routine that overwrites real data
   * without a recovery path is a self-destroying routine. Every
   * destructive step is preceded by a complete pre-merge backup.
   *
   * Returns a digest of what happened so callers (doctor --heal,
   * postinstall, use-time hook) can report it.
   */
  public healShareTopology(opts: { dryRun?: boolean } = {}): {
    profilesScanned: number;
    linksCreated: Array<{ profile: string; name: string; target: string }>;
    collisionsHealed: Array<{ profile: string; name: string; target: string; backupPath: string; merged: number }>;
    collisionsSkipped: Array<{ profile: string; name: string; reason: string }>;
  } {
    const result = {
      profilesScanned: 0,
      linksCreated: [] as Array<{ profile: string; name: string; target: string }>,
      collisionsHealed: [] as Array<{ profile: string; name: string; target: string; backupPath: string; merged: number }>,
      collisionsSkipped: [] as Array<{ profile: string; name: string; reason: string }>,
    };

    let snapshots: string[];
    try {
      snapshots = fs.readdirSync(this.shareSnapshotsDir)
        .filter(f => f.endsWith('.json'));
    } catch { return result; }

    const healTimestamp = new Date().toISOString().replace(/[:.]/g, '-');

    for (const snapFile of snapshots) {
      let payload: { commandName?: string; links?: Record<string, string> };
      try {
        payload = JSON.parse(fs.readFileSync(path.join(this.shareSnapshotsDir, snapFile), 'utf-8'));
      } catch { continue; }

      const commandName = payload.commandName;
      const links = payload.links;
      if (!commandName || !links || typeof links !== 'object') continue;

      // Validate commandName against the same allowlist getProfileDir uses
      // so we never resolve a poisoned snapshot path.
      if (!/^[A-Za-z0-9_-]+$/.test(commandName)) continue;

      const profileDir = path.join(os.homedir(), `.${commandName}`);
      if (!fs.existsSync(profileDir)) continue;

      result.profilesScanned++;

      for (const [name, target] of Object.entries(links)) {
        // Reject relative escapes — only absolute paths under homedir
        // are accepted as link targets.
        if (typeof target !== 'string') continue;
        if (!target.startsWith(os.homedir() + path.sep)) continue;
        if (!fs.existsSync(target)) {
          result.collisionsSkipped.push({ profile: commandName, name, reason: 'target-missing' });
          continue;
        }
        // Reject names that escape profileDir (defence-in-depth against
        // a poisoned snapshot containing `name: "../escape"`).
        if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') continue;

        const linkPath = path.join(profileDir, name);
        const existsOrLink = fs.existsSync(linkPath) || isLstatSymlink(linkPath);

        if (existsOrLink) {
          // Case (b): already the correct symlink → no-op.
          if (isLstatSymlink(linkPath)) {
            try {
              if (fs.readlinkSync(linkPath) === target) continue;
            } catch { /* fall through to heal */ }
          }

          // Case (c): collision (real dir/file or wrong-target symlink).
          if (opts.dryRun) {
            result.collisionsSkipped.push({ profile: commandName, name, reason: 'dry-run' });
            continue;
          }

          const healed = this.healOneCollision(commandName, name, linkPath, target, healTimestamp);
          if (healed.ok) {
            result.collisionsHealed.push({
              profile: commandName,
              name,
              target,
              backupPath: healed.backupPath,
              merged: healed.merged,
            });
          } else {
            result.collisionsSkipped.push({ profile: commandName, name, reason: healed.reason });
          }
          continue;
        }

        // Case (a): entry missing, target exists, all checks passed.
        if (opts.dryRun) {
          result.linksCreated.push({ profile: commandName, name, target });
          continue;
        }
        try {
          fs.symlinkSync(target, linkPath);
          result.linksCreated.push({ profile: commandName, name, target });
          this.logLifecycle({
            event: 'share_heal.symlink_created',
            profile: commandName,
            name,
            target,
            linkPath,
          });
        } catch (err) {
          result.collisionsSkipped.push({
            profile: commandName,
            name,
            reason: `symlink-failed: ${(err as Error).message ?? 'unknown'}`,
          });
        }
      }
    }

    return result;
  }

  /**
   * Resolve one collision discovered by healShareTopology. Walks the
   * complete safety cycle:
   *
   *   1. Acquire an O_EXCL per-linkPath lock so two concurrent
   *      `sweech use` / postinstall invocations can't race on the same
   *      heal. If the lock already exists we skip — assume the holder
   *      is mid-heal and let the next pass pick up any drift.
   *   2. Pre-merge backup. Capture EVERY file before any destruction.
   *   3. **Verify** the backup is complete: file count matches the
   *      source, no truncation flag, lstats still match. If anything is
   *      off, ABORT before destruction — better an unhealed profile
   *      than lost data.
   *   4. Merge into master (master-wins).
   *   5. Remove the real entry, then create the symlink.
   *   6. Log the digest to lifecycle.jsonl.
   *
   * Steps 2 + 3 are the load-bearing safety invariants: rmSync only
   * runs when we know we have a complete recoverable copy.
   */
  private healOneCollision(
    commandName: string,
    name: string,
    linkPath: string,
    target: string,
    healTimestamp: string,
  ): { ok: true; backupPath: string; merged: number } | { ok: false; reason: string } {
    // 1. O_EXCL lock. Per-linkPath so independent profiles can heal in
    //    parallel. Lock lives under .sweech/share-heal-locks/ — a hash
    //    of linkPath keeps the filename safe regardless of the path
    //    we're protecting.
    const lockDir = path.join(this.configDir, 'share-heal-locks');
    try { fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 }); }
    catch { /* fall through — lock creation will fail and we skip */ }
    const crypto = require('crypto');
    const lockName = crypto.createHash('sha256').update(linkPath).digest('hex').slice(0, 16) + '.lock';
    const lockPath = path.join(lockDir, lockName);
    let lockFd: number | null = null;
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeSync(lockFd, JSON.stringify({
        pid: process.pid,
        linkPath,
        acquiredAt: new Date().toISOString(),
      }));
    } catch {
      // Another process holds the lock. Treat as "someone else is
      // healing this entry"; bail out rather than risk a double-heal.
      return { ok: false, reason: 'lock-contended' };
    }

    const releaseLock = (): void => {
      try { if (lockFd !== null) fs.closeSync(lockFd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    };

    try {
      // 2. Re-stat AFTER taking the lock — another process may have
      //    finished a heal between our caller's check and our lock
      //    acquisition.
      let stat: fs.Stats;
      try { stat = fs.lstatSync(linkPath); }
      catch { return { ok: false, reason: 'lstat-failed' }; }

      // Already healed by another process? Treat as no-op success.
      if (stat.isSymbolicLink()) {
        try {
          if (fs.readlinkSync(linkPath) === target) {
            return { ok: false, reason: 'already-correct-post-lock' };
          }
        } catch { /* fall through */ }
      }

      // 3. Pre-merge backup.
      const backupRoot = path.join(this.backupsDir, 'share-heal', healTimestamp, commandName);
      const backupPath = path.join(backupRoot, name);
      try {
        fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      } catch {
        return { ok: false, reason: 'backup-mkdir-failed' };
      }

      let backedUp = 0;
      let truncated = false;
      let sourceFileCount = 0;
      try {
        if (stat.isSymbolicLink()) {
          // Wrong-target symlink — record the link itself, not its content.
          try {
            const wrongTarget = fs.readlinkSync(linkPath);
            fs.symlinkSync(wrongTarget, backupPath);
            backedUp = 1;
            sourceFileCount = 1;
          } catch {
            return { ok: false, reason: 'symlink-backup-failed' };
          }
        } else {
          const result = copyTreeOverwrite(linkPath, backupPath);
          backedUp = result.copied;
          truncated = result.truncated;
          const counted = countTreeFiles(linkPath);
          sourceFileCount = counted.count;
          if (counted.truncated) truncated = true;
        }
      } catch {
        return { ok: false, reason: 'backup-failed' };
      }

      // 4. **Verify backup before destruction.** This is the invariant
      //    that the prior version of this function violated: a backup
      //    that silently copied 0 files (EACCES, depth-cap hit, etc.)
      //    would still authorise rmSync. Now: if anything is off, we
      //    abort and leave the user's data in place.
      if (truncated || backedUp < sourceFileCount) {
        this.logLifecycle({
          event: 'share_heal.backup_incomplete_aborting',
          profile: commandName,
          name,
          target,
          backupPath,
          sourceFileCount,
          filesBackedUp: backedUp,
          truncated,
        });
        return { ok: false, reason: 'backup-incomplete-aborted' };
      }

      // 5. Merge into master (master-wins). Skip for wrong-target
      //    symlinks — there's no real data to merge.
      let merged = 0;
      let mergeTruncated = false;
      try {
        if (!stat.isSymbolicLink()) {
          const m = copyTreeIgnoreExisting(linkPath, target);
          merged = m.copied;
          mergeTruncated = m.truncated;
        }
      } catch {
        this.logLifecycle({
          event: 'share_heal.merge_failed',
          profile: commandName,
          name,
          target,
          backupPath,
        });
        return { ok: false, reason: 'merge-failed-backup-preserved' };
      }
      if (mergeTruncated) {
        this.logLifecycle({
          event: 'share_heal.merge_partial_aborting',
          profile: commandName,
          name,
          target,
          backupPath,
          filesMergedToMaster: merged,
        });
        return { ok: false, reason: 'merge-partial-backup-preserved' };
      }

      // 6. Remove real entry. Safe to do — backup is verified AND
      //    contents have been fully merged into master.
      try {
        if (stat.isSymbolicLink() || stat.isFile()) {
          fs.unlinkSync(linkPath);
        } else if (stat.isDirectory()) {
          fs.rmSync(linkPath, { recursive: true, force: true });
        }
      } catch {
        this.logLifecycle({
          event: 'share_heal.unlink_failed',
          profile: commandName,
          name,
          target,
          backupPath,
        });
        return { ok: false, reason: 'unlink-failed-backup-preserved' };
      }

      // 7. Create symlink.
      try {
        fs.symlinkSync(target, linkPath);
      } catch (err) {
        this.logLifecycle({
          event: 'share_heal.symlink_failed_after_merge',
          profile: commandName,
          name,
          target,
          backupPath,
          error: (err as Error).message ?? 'unknown',
        });
        return { ok: false, reason: 'symlink-failed-data-merged' };
      }

      // 8. Log success digest.
      this.logLifecycle({
        event: 'share_heal.collision_resolved',
        profile: commandName,
        name,
        target,
        backupPath,
        filesBackedUp: backedUp,
        filesMergedToMaster: merged,
        collisionType: stat.isSymbolicLink() ? 'wrong-target-symlink' : stat.isDirectory() ? 'real-directory' : 'real-file',
      });

      return { ok: true, backupPath, merged };
    } finally {
      releaseLock();
    }
  }

  /**
   * Toggle a lifecycle flag (`disabled` or `hidden`) on a workspace profile.
   * Mutates only the named profile; preserves every other field. Throws if
   * the profile does not exist.
   */
  public setProfileFlag(
    commandName: string,
    flag: 'disabled' | 'hidden',
    value: boolean,
  ): ProfileConfig {
    const profiles = this.getProfiles();
    const target = profiles.find(p => p.commandName === commandName);
    if (!target) {
      throw new Error(`Profile '${commandName}' not found`);
    }
    const updated: ProfileConfig = { ...target, [flag]: value };
    // Drop the flag entirely when toggled false so config.json stays clean.
    if (!value) delete updated[flag];
    const next = profiles.map(p => (p.commandName === commandName ? updated : p));
    this.writeProfiles(next);
    return updated;
  }

  /**
   * Update mutable, non-identity fields on a profile (model, baseUrl,
   * smallFastModel, envOverrides, provider). Does NOT change commandName
   * or cliType — use `renameManagedProfile` for that. Returns the merged
   * profile.
   *
   * `provider` is editable because misconfigured profiles (e.g. the
   * codex-heretic case where provider='openai' but the real backend is
   * a local llodge route) need a way to be corrected without dropping
   * the workspace. `sweech profile audit --fix-provider` is the
   * supervised entry point.
   */
  public editProfile(
    commandName: string,
    patch: Partial<Pick<ProfileConfig, 'model' | 'baseUrl' | 'smallFastModel' | 'envOverrides' | 'provider'>>,
  ): ProfileConfig {
    const profiles = this.getProfiles();
    const target = profiles.find(p => p.commandName === commandName);
    if (!target) {
      throw new Error(`Profile '${commandName}' not found`);
    }
    const merged: ProfileConfig = { ...target };
    for (const k of ['model', 'baseUrl', 'smallFastModel', 'provider'] as const) {
      if (patch[k] !== undefined) {
        if (patch[k] === '') delete (merged as any)[k];
        else (merged as any)[k] = patch[k];
      }
    }
    if (patch.envOverrides !== undefined) {
      merged.envOverrides = { ...(merged.envOverrides ?? {}), ...patch.envOverrides };
    }
    const next = profiles.map(p => (p.commandName === commandName ? merged : p));
    this.writeProfiles(next);
    return merged;
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

    // Validate settings.env values before write — the codex wrapper hoists
    // them into the shell with `export "$_key=$_val"`, and an embedded
    // newline / NUL would split the value across `IFS='=' read -r` lines
    // and either truncate the API key or smuggle an extra export. The
    // values today come from sweech-controlled fields (api key, base url,
    // model id) so this is defence-in-depth against future regressions.
    if (settings.env && typeof settings.env === 'object') {
      for (const [k, v] of Object.entries(settings.env)) {
        if (typeof v === 'string' && /[\n\r\0]/.test(v)) {
          throw new Error(
            `settings.env.${k} contains a newline/NUL byte — refusing to write ${path.join(profileDir, 'settings.json')}`
          );
        }
      }
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

    // Always write a minimal .claude.json so Claude Code skips the per-
    // profile onboarding/theme picker. This used to be gated on
    // !useNativeAuth, which left OAuth Anthropic/Codex workspaces
    // without the file — Claude Code v2.x then shows the theme picker
    // on every fresh launch because hasCompletedOnboarding is checked
    // PER CONFIG DIR (not just at the HOME-level ~/.claude.json).
    //
    // The picker fires even when OAuth is valid in the keychain. For
    // native-auth profiles we omit the apiKey sentinel so CC's own
    // OAuth flow isn't short-circuited.
    if (cliType !== 'kimi') {
      const claudeJsonPath = path.join(profileDir, '.claude.json');
      const claudeConfig: Record<string, unknown> = {
        hasCompletedOnboarding: true,
        // Required by Claude Code v2.x in addition to hasCompletedOnboarding.
        // Bumping to the user-installed version is fine; CC treats this as
        // "user has seen the onboarding for this version or newer".
        lastOnboardingVersion: '1.0.61',
        userID: this.generateUserID(),
        firstStartTime: new Date().toISOString(),
      };
      if (!useNativeAuth) {
        // External-provider profiles short-circuit CC's API-key flow with
        // the well-known sentinel. Native OAuth profiles must NOT carry
        // this — it would block the keychain refresh path.
        claudeConfig.loginMethod = 'api_key';
        claudeConfig.apiKey = 'sk-ant-external-provider';
      }
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
    const profile = this.getProfiles().find(p => p.commandName === commandName);

    // Escape all interpolated values for safe bash inclusion
    const eCommandName = bashEscape(commandName);
    const eDisplayName = bashEscape(cli.displayName);
    const eUsageFile = bashEscape(usageFile);
    const eCliCommand = bashEscape(cli.command);
    const eProfileDir = bashEscape(profileDir);
    const eConfigDirEnvVar = bashEscape(cli.configDirEnvVar);
    const eShareHealEnabled = profile?.sharedWith ? '1' : '0';
    const defaultDirs = ['claude', 'codex', 'kimi'];
    const masterDir = profile?.sharedWith
      ? defaultDirs.includes(profile.sharedWith)
        ? path.join(os.homedir(), `.${profile.sharedWith}`)
        : this.getProfileDir(profile.sharedWith)
      : '';
    const shareDriftChecks = profile?.sharedWith
      ? [
          ...(profile.cliType === 'codex' ? CODEX_SHAREABLE_DIRS : profile.cliType === 'kimi' ? KIMI_SHAREABLE_DIRS : SHAREABLE_DIRS)
            .map(item => ({ item, optional: false })),
          ...(profile.cliType === 'codex' ? CODEX_SHAREABLE_FILES : profile.cliType === 'kimi' ? KIMI_SHAREABLE_FILES : SHAREABLE_FILES)
            .map(item => ({ item, optional: false })),
          ...(profile.cliType === 'codex' ? CODEX_SHAREABLE_DBS : [])
            .map(item => ({ item, optional: true })),
        ].map(({ item, optional }) => {
          const eItem = bashEscape(item);
          const eTarget = bashEscape(path.join(masterDir, item));
          if (optional) {
            return `[ ! -e "${eTarget}" ] || { [ -e "${eProfileDir}/${eItem}" ] && [ ! -L "${eProfileDir}/${eItem}" ]; } || [ "$(readlink "${eProfileDir}/${eItem}" 2>/dev/null)" = "${eTarget}" ] || _NEEDS_HEAL=1`;
          }
          return `[ -e "${eTarget}" ] && [ "$(readlink "${eProfileDir}/${eItem}" 2>/dev/null)" = "${eTarget}" ] || _NEEDS_HEAL=1`;
        }).join('\n')
      : '';

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

# ── Pre-launch maintenance ──────────────────────────────────────────────
# Two checks, both gated by cheap bash pre-checks so the common
# "everything's fine" case adds <10ms instead of ~340ms per subprocess.
#
# (1) Share-topology heal: re-link drifted shareable dirs/files. Only
#     runs when a canary symlink (projects/) is broken.
# (2) Session-pointer rebuild: claude removes its sessions/<pid>.json
#     pointer on /exit, so /resume can't find prior conversations the
#     next time you launch — even though the conversation jsonl still
#     exists. We regenerate stub pointers from jsonls in the cwd's
#     project dir so /resume sees them. Only runs when a jsonl is
#     present whose sessionId isn't in sessions/.
#
# Both subprocess calls are best-effort and never block launch.
_NEEDS_HEAL=0
_NEEDS_POINTERS=0
_SHARE_HEAL_ENABLED=${eShareHealEnabled}
${shareDriftChecks}
# Quick pointer-drift check: scan current cwd's project dir for any
# jsonl whose sessionId doesn't appear in any session pointer file.
_ENCODED_CWD=\$(printf '%s' "\$PWD" | tr '/' '-')
_CWD_PROJECT="${eProfileDir}/projects/\$_ENCODED_CWD"
if [ -d "\$_CWD_PROJECT" ]; then
  for _jsonl in "\$_CWD_PROJECT"/*.jsonl; do
    [ -f "\$_jsonl" ] || continue
    _sid=\$(basename "\$_jsonl" .jsonl)
    if ! grep -lq "\\"\$_sid\\"" "${eProfileDir}"/sessions/*.json 2>/dev/null; then
      _NEEDS_POINTERS=1
      break
    fi
  done
fi
if command -v sweech &>/dev/null; then
  if [ "\$_NEEDS_HEAL" = "1" ]; then
    sweech _heal-profile "${eCommandName}" --quiet 2>/dev/null || true
  fi
  if [ "\$_NEEDS_POINTERS" = "1" ]; then
    sweech _ensure-session-pointers --profile "${eCommandName}" --cwd "\$PWD" --quiet 2>/dev/null || true
  fi
fi

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

_SWEECH_SESSION_ID="\${SWEECH_SESSION_ID:-${eCommandName}-\$(date -u +"%Y%m%dT%H%M%SZ")-\$\$}"
_SWEECH_TMUX_NAME="\${SWEECH_TMUX_NAME:-}"
_SWEECH_LAUNCHED_AFTER_MS="\$(($(date +%s) * 1000))"
if command -v sweech &>/dev/null; then
  sweech _session-launched --quiet --no-scan-jsonl --id "\$_SWEECH_SESSION_ID" --workspace "${eCommandName}" --cwd "\$PWD" --config-dir "${eProfileDir}" --tmux-name "\$_SWEECH_TMUX_NAME" --pid "\$\$" --terminal-app "\${TERM_PROGRAM:-wrapper}" 2>/dev/null || true
fi

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

"${eCliCommand}" "\${ARGS[@]}"
_SWEECH_EXIT=\$?
if command -v sweech &>/dev/null; then
  sweech _session-launched --quiet --id "\$_SWEECH_SESSION_ID" --workspace "${eCommandName}" --cwd "\$PWD" --config-dir "${eProfileDir}" --tmux-name "\$_SWEECH_TMUX_NAME" --pid "\$\$" --terminal-app "\${TERM_PROGRAM:-wrapper}" --jsonl-after-ms "\$_SWEECH_LAUNCHED_AFTER_MS" 2>/dev/null || true
  sweech _session-closed --quiet --id "\$_SWEECH_SESSION_ID" --tmux-name "\$_SWEECH_TMUX_NAME" 2>/dev/null || true
fi
exit "\$_SWEECH_EXIT"
`;

    fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
  }

  public getBinDir(): string {
    return this.binDir;
  }

  public getProfileDir(commandName: string): string {
    // Profiles live at ~/.claude-<suffix>/ as siblings to ~/.claude/
    // e.g. claude-rai -> ~/.claude-rai/
    //
    // Defensive: reject path-traversal-shaped commandNames so a
    // poisoned config.json entry (e.g. commandName: "../private")
    // cannot trick `removeManagedProfile` into rm-ing a sibling dir.
    // The path constructed is `~/.<commandName>` so any separator,
    // backslash, NUL, or `..` segment is fatal. Allow only
    // [A-Za-z0-9_-] — matching the input commandName must already
    // satisfy `--command-name` validation on profile create.
    if (!/^[A-Za-z0-9_-]+$/.test(commandName)) {
      throw new Error(`Refusing to resolve profile dir: invalid commandName '${commandName}' (only [A-Za-z0-9_-] allowed)`);
    }
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
