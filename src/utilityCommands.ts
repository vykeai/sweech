/**
 * Utility commands for sweetch
 * doctor, path, test, edit, clone, rename
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ConfigManager, ProfileConfig, SHAREABLE_DIRS, SHAREABLE_FILES, CODEX_SHAREABLE_DIRS, CODEX_SHAREABLE_FILES, CODEX_SHAREABLE_DBS, KIMI_SHAREABLE_DIRS, KIMI_SHAREABLE_FILES, resolveApiKey, KEYCHAIN_SERVICE } from './config';
import { getCredentialStore } from './credentialStore';
import { getCLI } from './clis';
import { getProvider, ModelInfo } from './providers';
import { detectInstalledCLIs } from './cliDetection';
import { renameManagedProfile } from './profileManagement';
import { getAccountInfo, getKnownAccounts } from './subscriptions';
import { DEFAULT_DAEMON_PORT } from './constants';
import { getAllRefreshEtas } from './tokenRefresh';
import { isLaunchdInstalled, isLaunchdRunning, LAUNCHD_LABEL, LAUNCHD_PLIST_PATH } from './launchd';
import { isMacOS } from './platform';

const execFileAsync = promisify(execFile);

/**
 * Check if sweetch bin directory is in PATH
 */
export function isInPath(binDir: string): boolean {
  const pathEnv = process.env.PATH || '';
  const paths = pathEnv.split(path.delimiter);
  return paths.some(p => path.resolve(p) === path.resolve(binDir));
}

/**
 * Detect user's shell
 */
export function detectShell(): string {
  const shell = process.env.SHELL || '';

  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('fish')) return 'fish';

  // Default to bash on Unix, cmd on Windows
  return process.platform === 'win32' ? 'cmd' : 'bash';
}

/**
 * Get shell RC file path
 */
export function getShellRCFile(): string {
  const shell = detectShell();
  const home = os.homedir();

  const rcFiles: Record<string, string> = {
    zsh: path.join(home, '.zshrc'),
    bash: path.join(home, '.bashrc'),
    fish: path.join(home, '.config', 'fish', 'config.fish'),
    cmd: '' // Windows doesn't have RC file in same way
  };

  return rcFiles[shell] || path.join(home, '.bashrc');
}

interface HealthIssue {
  profile: string;
  item: string;
  problem: string;
  fix: string;
}

/** Per-check severity used by runDoctor to compute the exit code. */
export type CheckSeverity = 'ok' | 'warn' | 'error';

/** T-053: timeout budget for individual doctor network checks. */
export const DOCTOR_CHECK_TIMEOUT_MS = 5000;

/** T-053: shape of a daemon /healthz probe outcome. */
export interface DaemonHealthzProbe {
  /** ok = 2xx + body.ok===true; timeout = AbortSignal fired; unreachable = no socket; error = anything else. */
  status: 'ok' | 'timeout' | 'unreachable' | 'error';
  /** Human-readable detail used by the doctor row. */
  message: string;
  /** Daemon version when reachable. */
  version?: string;
  /** Daemon uptime (seconds) when reachable. */
  uptime?: number;
  /** Daemon lifecycle state (e.g. 'ready', 'starting') when reachable. */
  state?: string;
}

/**
 * T-053: collapse a set of check severities to the worst exit code.
 * Exit semantics: 0 = all ok, 1 = at least one warning, 2 = at least one error.
 */
export function worstSeverity(severities: CheckSeverity[]): 0 | 1 | 2 {
  let exit: 0 | 1 | 2 = 0;
  for (const s of severities) {
    if (s === 'error') return 2;
    if (s === 'warn' && exit === 0) exit = 1;
  }
  return exit;
}

/**
 * T-053: race a promise against a deadline. On timeout the returned promise
 * rejects with an Error whose `code === 'TIMEOUT'`, so callers can label the
 * check as "timeout" (acceptance criterion #1) instead of "hung" or a generic
 * fetch error. The wrapped promise keeps running in the background — this is
 * intentional and matches Node's fetch-with-AbortSignal behaviour.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`) as Error & { code?: string };
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
    // Don't keep the event loop alive just for the timer.
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([p, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * T-053: resolve the daemon HTTP port the same way other CLI commands do.
 * Order: SWEECH_PORT env var → ~/.fed/config.json (`tools.sweech-engine.dash`)
 * → DEFAULT_DAEMON_PORT.
 */
function resolveDaemonPortForDoctor(): number {
  const envPort = parseInt(process.env.SWEECH_PORT ?? '', 10);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.fed', 'config.json'), 'utf-8');
    const cfg = JSON.parse(raw) as { tools?: Record<string, { dash?: number }> };
    return cfg?.tools?.['sweech-engine']?.dash ?? DEFAULT_DAEMON_PORT;
  } catch {
    return DEFAULT_DAEMON_PORT;
  }
}

/**
 * T-053: probe the daemon /healthz endpoint with a hard 5s deadline. The
 * /healthz route is intentionally public (see packages/engine/src/daemon/auth.ts)
 * so no HMAC signing is needed. Caller injects `fetchImpl` for tests.
 */
export async function probeDaemonHealthz(opts: {
  port?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<DaemonHealthzProbe> {
  const port = opts.port ?? resolveDaemonPortForDoctor();
  const timeoutMs = opts.timeoutMs ?? DOCTOR_CHECK_TIMEOUT_MS;
  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    let body: { ok?: boolean; version?: string; uptime?: number; state?: string; reason?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // ignore — treat as error below if body is unusable
    }
    if (res.ok && body.ok) {
      return {
        status: 'ok',
        message: `ready (v${body.version ?? '?'}, uptime ${Math.round(body.uptime ?? 0)}s)`,
        version: body.version,
        uptime: body.uptime,
        state: body.state,
      };
    }
    return {
      status: 'error',
      message: `unhealthy (HTTP ${res.status}${body.state ? `, state=${body.state}` : ''}${body.reason ? `, reason=${body.reason}` : ''})`,
      version: body.version,
      uptime: body.uptime,
      state: body.state,
    };
  } catch (err: unknown) {
    const e = err as { name?: string; code?: string; message?: string; cause?: { name?: string; code?: string } };
    // Node's fetch wraps network errors in a TypeError whose `name` is
    // 'TypeError' — the real AbortError / ECONNREFUSED lives on `.cause`.
    // Check both layers so the probe classifies correctly regardless of
    // which Node/undici version produced the error.
    const names = new Set([e?.name, e?.cause?.name].filter(Boolean));
    const codes = new Set([e?.code, e?.cause?.code].filter(Boolean));
    // AbortController.abort() makes fetch throw a DOMException whose name is AbortError;
    // surface that as "timeout" per acceptance criterion #1.
    if (names.has('AbortError') || names.has('TimeoutError') || codes.has('TIMEOUT') || codes.has('ABORT_ERR')) {
      return { status: 'timeout', message: `no response in ${timeoutMs}ms` };
    }
    if (codes.has('ECONNREFUSED') || codes.has('ENOTFOUND') || codes.has('EHOSTUNREACH') || codes.has('ECONNRESET')) {
      return { status: 'unreachable', message: `daemon not running on port ${port}` };
    }
    return { status: 'error', message: e?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * sweetch doctor - Health check
 */
export async function runDoctor(): Promise<void> {
  console.log(chalk.bold('\n🏥 Sweetch Health Check\n'));

  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const binDir = config.getBinDir();
  const symlinkIssues: HealthIssue[] = [];
  const largeProfiles: string[] = [];
  let healthyProfileCount = 0;

  // T-053: severities feed `worstSeverity()` to compute the final exit code
  // (0=all ok, 1=warnings, 2=errors). Every check that prints a row should
  // also push its severity here.
  const severities: CheckSeverity[] = [];

  // Check Node.js
  console.log(chalk.bold('Environment:'));
  try {
    const nodeVersion = process.version;
    console.log(chalk.green(`  ✓ Node.js: ${nodeVersion}`));
    severities.push('ok');
  } catch {
    console.log(chalk.red('  ✗ Node.js: Not detected'));
    severities.push('error');
  }

  // Check sweetch version
  try {
    const packagePath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    console.log(chalk.green(`  ✓ sweetch: v${pkg.version}`));
  } catch {
    console.log(chalk.gray('  ✓ sweetch: Development version'));
  }

  // Check PATH
  console.log(chalk.bold('\nPATH Configuration:'));
  if (isInPath(binDir)) {
    const rcFile = getShellRCFile();
    console.log(chalk.green(`  ✓ ${binDir} is in PATH`));
    console.log(chalk.gray(`    Location: ${rcFile}`));
    severities.push('ok');
  } else {
    console.log(chalk.red(`  ✗ ${binDir} is NOT in PATH`));
    console.log(chalk.yellow(`    Run: ${chalk.bold('sweetch path')} for help`));
    severities.push('warn');
  }

  // Check installed CLIs
  console.log(chalk.bold('\nInstalled CLIs:'));
  const detectedCLIs = await detectInstalledCLIs();
  detectedCLIs.forEach(result => {
    if (result.installed) {
      const version = result.version ? ` (${result.version})` : '';
      console.log(chalk.green(`  ✓ ${result.cli.displayName}${version}`));
    } else {
      console.log(chalk.gray(`  ✗ ${result.cli.displayName}: Not installed`));
      if (result.cli.installUrl) {
        console.log(chalk.gray(`    Install: ${result.cli.installUrl}`));
      }
    }
  });

  // Check usage cache staleness
  console.log(chalk.bold('\nUsage Cache:'));
  const cachePath = path.join(os.homedir(), '.sweech', 'rate-limit-cache.json');
  if (fs.existsSync(cachePath)) {
    const cacheStats = fs.statSync(cachePath);
    const cacheAgeMs = Date.now() - cacheStats.mtimeMs;
    const cacheAgeHours = Math.floor(cacheAgeMs / (1000 * 60 * 60));
    if (cacheAgeMs > 24 * 60 * 60 * 1000) {
      console.log(chalk.yellow(`  ⚠ Usage cache is stale (last updated ${cacheAgeHours}h ago) — run \`sweech usage --refresh\``));
      severities.push('warn');
    } else {
      const agoLabel = cacheAgeHours > 0 ? `${cacheAgeHours}h ago` : 'just now';
      console.log(chalk.green(`  ✓ Usage cache is fresh (updated ${agoLabel})`));
      severities.push('ok');
    }
  } else {
    console.log(chalk.gray(`  ✗ No usage cache found — run \`sweech usage\` to populate`));
    // No cache is informational, not a warning — fresh installs land here.
    severities.push('ok');
  }

  // T-053: daemon /healthz probe — surfaces as its own row, with a 5s
  // timeout so a stuck daemon never hangs `sweech doctor`. Public route
  // (no HMAC), see packages/engine/src/daemon/auth.ts PUBLIC_PATHS.
  console.log(chalk.bold('\nDaemon:'));
  const healthz = await probeDaemonHealthz({ timeoutMs: DOCTOR_CHECK_TIMEOUT_MS });
  if (healthz.status === 'ok') {
    console.log(chalk.green(`  ✓ /healthz: ${healthz.message}`));
    severities.push('ok');
  } else if (healthz.status === 'unreachable') {
    // Daemon being down is a warning, not an error — the CLI works fine without it.
    console.log(chalk.yellow(`  ⚠ /healthz: ${healthz.message}`));
    console.log(chalk.gray(`    Run: sweech daemon start`));
    severities.push('warn');
  } else if (healthz.status === 'timeout') {
    // Stuck daemon is a real error — the probe explicitly says "timeout"
    // (acceptance criterion #1) instead of letting the check appear to hang.
    console.log(chalk.red(`  ✗ /healthz: timeout (${healthz.message})`));
    console.log(chalk.gray(`    Run: sweech daemon stop && sweech daemon start`));
    severities.push('error');
  } else {
    console.log(chalk.red(`  ✗ /healthz: ${healthz.message}`));
    severities.push('error');
  }

  // T-LU-005: launchd auto-restart status (macOS only). The /healthz probe
  // above only tells us if `sweech serve` is *currently* reachable —
  // operators also need to know whether the process will auto-restart on
  // crash/reboot via launchd. Four states:
  //   1. installed + running         → green
  //   2. installed + not running     → warn (KeepAlive cooldown, manual unload)
  //   3. !installed + healthz ok     → gray "running standalone"
  //   4. !installed + healthz down   → gray "not installed"
  // Silently skipped on non-macOS (launchd is darwin-only).
  if (isMacOS()) {
    console.log(chalk.bold('\nlaunchd daemon:'));
    try {
      const status = isLaunchdRunning();
      const plistOnDisk = isLaunchdInstalled();
      if (status.installed && status.running) {
        console.log(chalk.green(`  ✓ ${LAUNCHD_LABEL}: running (pid ${status.pid})`));
        severities.push('ok');
      } else if (status.installed && !status.running) {
        // Loaded into launchd but not running — KeepAlive is in cooldown
        // (crash loop) or the service was throttled. Warn, not error.
        console.log(chalk.yellow(`  ⚠ ${LAUNCHD_LABEL}: installed but not running`));
        console.log(chalk.gray(`    Run: launchctl load "${LAUNCHD_PLIST_PATH}"`));
        severities.push('warn');
      } else if (plistOnDisk) {
        // Plist exists on disk but not loaded into launchd — operator
        // ran `launchctl unload` but kept the plist file. Warn.
        console.log(chalk.yellow(`  ⚠ ${LAUNCHD_LABEL}: plist on disk but not loaded`));
        console.log(chalk.gray(`    Run: launchctl load "${LAUNCHD_PLIST_PATH}"`));
        severities.push('warn');
      } else if (healthz.status === 'ok') {
        // Server is running but not under launchd supervision — works
        // but won't auto-restart on crash/reboot. Informational.
        console.log(chalk.gray(`  ✓ ${LAUNCHD_LABEL}: running standalone (no auto-restart)`));
        console.log(chalk.gray(`    Run: sweech serve --install (for auto-restart)`));
        severities.push('ok');
      } else {
        // Not installed, not running standalone — informational, not a
        // problem. The CLI works fine without the fed server.
        console.log(chalk.gray(`  ✗ ${LAUNCHD_LABEL}: not installed`));
        console.log(chalk.gray(`    Run: sweech serve --install (for auto-restart)`));
        severities.push('ok');
      }
    } catch (err: unknown) {
      // launchctl missing or unexpected error — surface as warn rather
      // than crash the whole doctor run.
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  ⚠ ${LAUNCHD_LABEL}: status check failed — ${msg}`));
      severities.push('warn');
    }
  }

  // Check credential freshness (OAuth tokens in Keychain)
  console.log(chalk.bold('\nCredentials:'));
  const reauthNeeded: string[] = [];
  try {
    const accountList = getKnownAccounts(profiles);
    // T-053: wrap the entire account-info fetch in a hard 5s deadline. The
    // inner getAccountInfo also takes timeoutMs but only applies it per-account
    // for the live-usage subcall; the outer race guarantees the whole check
    // reports "timeout" (criterion #1) even if some other step inside stalls.
    const accounts = await withTimeout(
      getAccountInfo(accountList, { timeoutMs: DOCTOR_CHECK_TIMEOUT_MS }),
      DOCTOR_CHECK_TIMEOUT_MS,
      'credential check',
    );
    for (const acct of accounts) {
      if (acct.needsReauth) {
        reauthNeeded.push(acct.name);
        console.log(chalk.red(`  ✗ ${acct.name}: needs re-authentication`));
        console.log(chalk.gray(`    Run: sweech auth ${acct.commandName}`));
        severities.push('error');
      } else if (acct.live?.tokenStatus === 'expired') {
        reauthNeeded.push(acct.name);
        console.log(chalk.yellow(`  ⚠ ${acct.name}: token expired`));
        console.log(chalk.gray(`    Run: sweech auth ${acct.commandName}`));
        severities.push('warn');
      } else if (acct.live?.tokenExpiresAt) {
        const hoursLeft = (acct.live.tokenExpiresAt - Date.now()) / 3600000;
        if (hoursLeft > 0 && hoursLeft < 24) {
          console.log(chalk.yellow(`  ⚠ ${acct.name}: token expires in ${Math.round(hoursLeft)}h`));
          severities.push('warn');
        } else {
          console.log(chalk.green(`  ✓ ${acct.name}: token valid`));
          severities.push('ok');
        }
      } else {
        console.log(chalk.green(`  ✓ ${acct.name}: ok`));
        severities.push('ok');
      }
    }
    if (reauthNeeded.length === 0 && accounts.length > 0 && !accounts.some(a => a.live?.tokenStatus === 'expired')) {
      // Only emit the summary line when nothing above flagged a problem.
      console.log(chalk.green(`  All ${accounts.length} account credentials valid`));
    }
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === 'TIMEOUT') {
      // Acceptance criterion #1: explicitly labelled "timeout" instead of
      // letting a stalled keychain call quietly degrade to "fetch failed".
      console.log(chalk.yellow(`  ⚠ credential check: timeout (no response in ${DOCTOR_CHECK_TIMEOUT_MS}ms)`));
      severities.push('warn');
    } else {
      console.log(chalk.gray('  ✗ Could not check credentials (fetch failed)'));
      severities.push('warn');
    }
  }

  // T-LU-006: Token refresh ETA — when will the daemon refresh each OAuth
  // profile? Surfaces "due now" (within 24h) and "ok" (>24h) so operators
  // can confirm the background refresh loop has work to do. Profiles
  // without OAuth (API-key only) are skipped silently.
  const refreshEtas = getAllRefreshEtas(profiles);
  if (refreshEtas.length > 0) {
    console.log(chalk.bold('\nToken refresh ETA:'));
    for (const eta of refreshEtas) {
      if (eta.expiresAt == null) {
        console.log(chalk.gray(`  • ${eta.profile}: no expiry (non-expiring token)`));
        severities.push('ok');
      } else if (eta.dueNow) {
        const label = (eta.hoursUntil ?? 0) <= 0
          ? `expired (${eta.expiresAt})`
          : `due now — ${eta.hoursUntil}h until expiry (${eta.expiresAt})`;
        console.log(chalk.yellow(`  ⚠ ${eta.profile}: ${label}`));
        severities.push('warn');
      } else {
        console.log(chalk.green(`  ✓ ${eta.profile}: ok — ${eta.hoursUntil}h until expiry (${eta.expiresAt})`));
        severities.push('ok');
      }
    }
  }

  // Check profiles
  console.log(chalk.bold(`\nProfiles (${profiles.length}):`));
  if (profiles.length === 0) {
    console.log(chalk.gray('  No profiles configured yet'));
    console.log(chalk.gray(`  Run: ${chalk.bold('sweetch add')} to add a provider`));
  } else {
    for (const profile of profiles) {
      const provider = getProvider(profile.provider);
      const wrapperPath = path.join(binDir, profile.commandName);
      const profileDir = config.getProfileDir(profile.commandName);
      const settingsPath = path.join(profileDir, 'settings.json');

      const wrapperExists = fs.existsSync(wrapperPath);
      const wrapperExecutable = wrapperExists &&
        (fs.statSync(wrapperPath).mode & parseInt('111', 8)) !== 0;
      const configExists = fs.existsSync(settingsPath);

      const sharedTag = profile.sharedWith
        ? chalk.magenta(` [shared ↔ ${profile.sharedWith}]`)
        : '';

      const profileHealthy = wrapperExecutable && configExists;
      if (profileHealthy) {
        healthyProfileCount++;
        console.log(chalk.green(`  ✓ ${profile.commandName} → ${provider?.displayName}`) + sharedTag);
        severities.push('ok');
      } else {
        console.log(chalk.yellow(`  ⚠ ${profile.commandName} → ${provider?.displayName}`) + sharedTag);
        if (!wrapperExists) {
          console.log(chalk.gray(`    Missing wrapper script`));
        } else if (!wrapperExecutable) {
          console.log(chalk.gray(`    Wrapper not executable`));
        }
        if (!configExists) {
          console.log(chalk.gray(`    Missing config file`));
        }
        // Missing wrapper / config is a hard error — the profile won't run.
        severities.push('error');
      }

      // Check profile data directory size
      try {
        const { stdout } = await execFileAsync('du', ['-sk', profileDir], { timeout: DOCTOR_CHECK_TIMEOUT_MS });
        const sizeKB = parseInt(stdout.split('\t')[0], 10);
        if (!isNaN(sizeKB) && sizeKB > 5 * 1024 * 1024) { // 5GB in KB
          const sizeGB = (sizeKB / (1024 * 1024)).toFixed(1);
          console.log(chalk.yellow(`    ⚠ Profile data is large (${sizeGB} GB)`));
          largeProfiles.push(profile.commandName);
          severities.push('warn');
        }
      } catch {
        // du not available or dir doesn't exist — skip size check
      }

      // Check SQLite database integrity
      try {
        const dbFiles: string[] = [];
        if (fs.existsSync(profileDir)) {
          const entries = fs.readdirSync(profileDir);
          for (const entry of entries) {
            if (entry.endsWith('.sqlite') || entry.endsWith('.db')) {
              dbFiles.push(path.join(profileDir, entry));
            }
          }
        }
        for (const dbFile of dbFiles) {
          try {
            const { stdout } = await execFileAsync('sqlite3', [dbFile, 'PRAGMA integrity_check'], { timeout: DOCTOR_CHECK_TIMEOUT_MS });
            if (stdout.trim() === 'ok') {
              console.log(chalk.green(`    ✓ ${path.basename(dbFile)}: integrity ok`));
              severities.push('ok');
            } else {
              console.log(chalk.yellow(`    ⚠ ${path.basename(dbFile)}: integrity issue — ${stdout.trim()}`));
              console.log(chalk.gray(`      Run: sqlite3 "${dbFile}" "PRAGMA integrity_check" for details`));
              severities.push('warn');
            }
          } catch (dbErr: unknown) {
            const e = dbErr as { killed?: boolean; signal?: string; code?: string; message?: string };
            const dbMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
            // child_process kills with SIGTERM when its `timeout` option fires — surface as timeout.
            if (e?.killed && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL')) {
              console.log(chalk.yellow(`    ⚠ ${path.basename(dbFile)}: check timed out after ${DOCTOR_CHECK_TIMEOUT_MS}ms`));
            } else {
              console.log(chalk.yellow(`    ⚠ ${path.basename(dbFile)}: check failed — ${dbMsg}`));
            }
            console.log(chalk.gray(`      Run: sqlite3 "${dbFile}" ".recover" to attempt recovery`));
            severities.push('warn');
          }
        }
      } catch {
        // readdirSync failed — skip DB check
      }

      // Check symlinks for profiles that share data with a master profile
      if (profile.sharedWith) {
        const isCodex = profile.cliType === 'codex'
          || profile.commandName.startsWith('codex');
        const isKimi = profile.cliType === 'kimi'
          || profile.commandName.startsWith('kimi');
        const masterDir = ['claude', 'codex', 'kimi'].includes(profile.sharedWith)
          ? path.join(os.homedir(), `.${profile.sharedWith}`)
          : config.getProfileDir(profile.sharedWith);

        const expectedDirs = isCodex ? CODEX_SHAREABLE_DIRS : isKimi ? KIMI_SHAREABLE_DIRS : SHAREABLE_DIRS;
        const expectedFiles = isCodex
          ? [...CODEX_SHAREABLE_FILES, ...CODEX_SHAREABLE_DBS]
          : isKimi
          ? [...KIMI_SHAREABLE_FILES]
          : [...SHAREABLE_FILES];

        console.log(chalk.gray(`    Shared symlinks (→ ${profile.sharedWith}):`));
        for (const item of [...expectedDirs, ...expectedFiles]) {
          const linkPath = path.join(profileDir, item);
          const expectedTarget = path.join(masterDir, item);
          let status: 'ok' | 'missing' | 'not-symlink' | 'wrong-target' = 'ok';

          try {
            const stat = fs.lstatSync(linkPath);
            if (stat.isSymbolicLink()) {
              const actual = fs.readlinkSync(linkPath);
              if (actual !== expectedTarget) {
                try {
                  if (fs.realpathSync(linkPath) !== fs.realpathSync(expectedTarget)) {
                    status = 'wrong-target';
                  }
                } catch {
                  status = 'wrong-target';
                }
              }
            } else {
              status = 'not-symlink';
            }
          } catch {
            status = 'missing';
          }

          if (status === 'ok') {
            console.log(chalk.green(`      ✓ ${item}`));
            severities.push('ok');
          } else {
            const isSqlite = item.endsWith('.sqlite');
            let problem = '';
            let fix = '';

            if (status === 'missing') {
              problem = 'missing';
              fix = isSqlite
                ? `ln -s "${expectedTarget}" "${linkPath}" (ensure master DB exists first)`
                : `ln -s "${expectedTarget}" "${linkPath}"`;
            } else if (status === 'not-symlink') {
              problem = 'real file (not symlinked)';
              fix = isSqlite
                ? `merge divergent data then replace with symlink (needs DB merge)`
                : `rm "${linkPath}" && ln -s "${expectedTarget}" "${linkPath}"`;
            } else {
              problem = `wrong target → ${fs.readlinkSync(linkPath)}`;
              fix = `rm "${linkPath}" && ln -s "${expectedTarget}" "${linkPath}"`;
            }

            console.log(chalk.red(`      ✗ ${item}`) + chalk.gray(` — ${problem}`));
            symlinkIssues.push({ profile: profile.commandName, item, problem, fix });
            // Broken/missing share-links can silently desync session state — error, not warn.
            severities.push('error');
          }
        }
      }
    }
  }

  // Profile health summary
  if (profiles.length > 0) {
    console.log(chalk.bold('\nProfile Summary:'));
    const totalProfiles = profiles.length;
    const summaryColor = healthyProfileCount === totalProfiles
      ? chalk.green
      : healthyProfileCount > 0
        ? chalk.yellow
        : chalk.red;
    console.log(summaryColor(`  ${healthyProfileCount} of ${totalProfiles} profiles healthy`));
    if (largeProfiles.length > 0) {
      console.log(chalk.yellow(`  ${largeProfiles.length} profile${largeProfiles.length > 1 ? 's' : ''} over 5 GB: ${largeProfiles.join(', ')}`));
    }
  }

  console.log();

  // Print symlink fix suggestions if any
  if (symlinkIssues.length > 0) {
    console.log(chalk.bold('Suggested fixes:\n'));

    const sqliteIssues = symlinkIssues.filter(i => i.item.endsWith('.sqlite') && i.problem.includes('real file'));
    const simpleIssues = symlinkIssues.filter(i => !sqliteIssues.includes(i));

    for (const issue of simpleIssues) {
      console.log(chalk.gray(`# ${issue.profile}/${issue.item} — ${issue.problem}`));
      console.log(`  ${issue.fix}`);
    }

    if (sqliteIssues.length > 0) {
      console.log(chalk.yellow('\nSQLite databases need merge before symlinking:'));
      for (const issue of sqliteIssues) {
        console.log(chalk.gray(`  ${issue.profile}/${issue.item}`));
      }
      console.log(chalk.gray('\nRun sweech resync <profile> to flush WAL, merge, and re-symlink.'));
      console.log(chalk.gray('Or fix manually with an AI agent — the DBs may have divergent threads.'));
    }

    console.log();
  }

  // T-053: exit code reflects the worst severity across every check
  // (0 = all ok, 1 = warnings, 2 = errors). Acceptance criterion #3.
  const exit = worstSeverity(severities);
  if (exit === 2) {
    console.log(chalk.red('❌ Errors detected. See above for details.\n'));
  } else if (exit === 1) {
    console.log(chalk.yellow('⚠️  Some warnings detected. See above for details.\n'));
  } else {
    console.log(chalk.green('✅ Everything looks good! 🎉\n'));
  }
  process.exitCode = exit;
}

/**
 * sweetch path - PATH configuration helper
 */
export async function runPath(): Promise<void> {
  console.log(chalk.bold('\n📍 PATH Configuration\n'));

  const config = new ConfigManager();
  const binDir = config.getBinDir();
  const inPath = isInPath(binDir);
  const shell = detectShell();
  const rcFile = getShellRCFile();

  if (inPath) {
    console.log(chalk.green(`Status: ✓ Configured`));
    console.log(chalk.gray(`  ${binDir} is in your PATH`));
    console.log(chalk.gray(`  Shell: ${shell}`));
    console.log();
    return;
  }

  console.log(chalk.yellow(`Status: ✗ Not configured`));
  console.log(chalk.gray(`  ${binDir} is not in your PATH\n`));

  console.log(chalk.bold('To use your commands, add this to your shell:\n'));

  const exportCmd = `export PATH="$HOME/.sweech/bin:$PATH"`;

  if (shell === 'zsh') {
    console.log(chalk.cyan(`  # For zsh (default on macOS)`));
    console.log(chalk.white(`  echo '${exportCmd}' >> ~/.zshrc`));
    console.log(chalk.white(`  source ~/.zshrc\n`));
  } else if (shell === 'bash') {
    console.log(chalk.cyan(`  # For bash`));
    console.log(chalk.white(`  echo '${exportCmd}' >> ~/.bashrc`));
    console.log(chalk.white(`  source ~/.bashrc\n`));
  } else if (shell === 'fish') {
    console.log(chalk.cyan(`  # For fish`));
    console.log(chalk.white(`  set -Ua fish_user_paths $HOME/.sweech/bin`));
    console.log(chalk.white(`  # Or add to ~/.config/fish/config.fish\n`));
  }

  // Offer to add automatically
  const { autoAdd } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'autoAdd',
      message: 'Would you like sweetch to add this automatically?',
      default: false
    }
  ]);

  if (autoAdd && rcFile) {
    try {
      // Check if already present
      if (fs.existsSync(rcFile)) {
        const content = fs.readFileSync(rcFile, 'utf-8');
        if (!content.includes('.sweech/bin')) {
          fs.appendFileSync(rcFile, `\n# Added by sweetch\n${exportCmd}\n`);
          console.log(chalk.green(`\n✓ Added to ${rcFile}`));
          console.log(chalk.yellow(`\nRestart your terminal or run: ${chalk.bold(`source ${rcFile}`)}\n`));
        } else {
          console.log(chalk.green(`\n✓ Already in ${rcFile}`));
          console.log(chalk.yellow(`\nRestart your terminal or run: ${chalk.bold(`source ${rcFile}`)}\n`));
        }
      } else {
        fs.appendFileSync(rcFile, `\n# Added by sweetch\n${exportCmd}\n`);
        console.log(chalk.green(`\n✓ Added to ${rcFile}`));
        console.log(chalk.yellow(`\nRestart your terminal or run: ${chalk.bold(`source ${rcFile}`)}\n`));
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`\nFailed to update ${rcFile}:`, msg));
      console.log(chalk.gray('Please add manually using the commands above.\n'));
    }
  }
}

/**
 * sweetch test - Test provider connection
 */
export async function runTest(commandName: string): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const profile = profiles.find(p => p.commandName === commandName);

  if (!profile) {
    console.error(chalk.red(`\nProfile '${commandName}' not found\n`));
    process.exit(1);
  }

  const provider = getProvider(profile.provider);
  const cli = getCLI(profile.cliType);

  console.log(chalk.bold(`\n🧪 Testing ${commandName} (${provider?.displayName})...\n`));

  // Check configuration
  process.stdout.write(chalk.gray('Checking configuration...        '));
  const profileDir = config.getProfileDir(commandName);
  const settingsPath = path.join(profileDir, 'settings.json');
  const wrapperPath = path.join(config.getBinDir(), commandName);

  if (!fs.existsSync(settingsPath)) {
    console.log(chalk.red('✗'));
    console.error(chalk.red(`\nConfig file not found: ${settingsPath}\n`));
    process.exit(1);
  }

  if (!fs.existsSync(wrapperPath)) {
    console.log(chalk.red('✗'));
    console.error(chalk.red(`\nWrapper script not found: ${wrapperPath}\n`));
    process.exit(1);
  }

  console.log(chalk.green('✓'));

  // Test CLI installation
  process.stdout.write(chalk.gray('Checking CLI installation...     '));
  try {
    await execFileAsync(cli?.command || 'claude', ['--version'], { timeout: 5000 });
    console.log(chalk.green('✓'));
  } catch {
    console.log(chalk.red('✗'));
    console.error(chalk.red(`\n${cli?.displayName} is not installed or not in PATH\n`));
    process.exit(1);
  }

  // Note: We can't actually test the API without making a real request
  // which would require the CLI's authentication flow
  console.log(chalk.gray('Testing API connection...        ') + chalk.yellow('⊘ Skipped'));
  console.log(chalk.gray('  (Requires CLI authentication flow)\n'));

  console.log(chalk.green('✅ Configuration is valid!\n'));
  console.log(chalk.gray('Configuration:'));
  console.log(chalk.gray(`  Provider: ${provider?.displayName}`));
  console.log(chalk.gray(`  Model: ${profile.model}`));
  console.log(chalk.gray(`  Config: ${profileDir}`));
  console.log(chalk.gray(`  Wrapper: ${wrapperPath}\n`));
  console.log(chalk.cyan(`To use: ${chalk.bold(commandName)}\n`));
}

/**
 * sweetch edit - Edit profile configuration
 */
export async function runEdit(commandName: string): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const profile = profiles.find(p => p.commandName === commandName);

  if (!profile) {
    console.error(chalk.red(`\nProfile '${commandName}' not found\n`));
    process.exit(1);
  }

  const provider = getProvider(profile.provider);

  console.log(chalk.bold(`\n✏️  Edit ${commandName}\n`));
  console.log(chalk.gray('Current configuration:'));
  console.log(chalk.gray(`  Provider: ${provider?.displayName}`));
  console.log(chalk.gray(`  Model: ${profile.model}`));
  const authMethod = profile.oauth ? 'OAuth' : 'API Key';
  const resolvedKey = await resolveApiKey(profile);
  const authDisplay = resolvedKey
    ? `API Key: ${resolvedKey.substring(0, 10)}***`
    : `OAuth (${profile.oauth?.provider})`;
  console.log(chalk.gray(`  Auth: ${authDisplay}`));
  console.log();

  const { field } = await inquirer.prompt([
    {
      type: 'list',
      name: 'field',
      message: 'What would you like to edit?',
      choices: [
        { name: 'API Key', value: 'apiKey' },
        { name: 'Model', value: 'model' },
        { name: 'Base URL', value: 'baseUrl' },
        { name: 'Cancel', value: 'cancel' }
      ]
    }
  ]);

  if (field === 'cancel') {
    console.log(chalk.yellow('\nCancelled\n'));
    return;
  }

  let newValue: string;

  if (field === 'apiKey') {
    const answer = await inquirer.prompt([
      {
        type: 'password',
        name: 'value',
        message: 'Enter new API key:',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'API key required'
      }
    ]);
    newValue = answer.value.trim();
  } else if (field === 'model') {
    // If provider has a model catalog, show a selector
    const models = provider?.availableModels;
    if (models && models.length > 0) {
      const choices = models.map((m: ModelInfo) => {
        const meta = [m.type, m.context, m.note].filter(Boolean).join(', ');
        const current = m.id === profile.model ? chalk.green(' ← current') : '';
        return {
          name: `${m.name}  ${chalk.dim(meta)}${current}`,
          value: m.id
        };
      });
      choices.push({ name: chalk.dim('Custom model ID...'), value: '__custom__' });

      const { selected } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selected',
          message: 'Select model:',
          choices,
          default: profile.model
        }
      ]);

      if (selected === '__custom__') {
        const custom = await inquirer.prompt([
          {
            type: 'input',
            name: 'value',
            message: 'Enter model ID:',
            default: profile.model,
            validate: (input: string) => input.trim().length > 0 || 'Model name required'
          }
        ]);
        newValue = custom.value.trim();
      } else {
        newValue = selected;
      }
    } else {
      const answer = await inquirer.prompt([
        {
          type: 'input',
          name: 'value',
          message: 'Enter new model name:',
          default: profile.model,
          validate: (input: string) => input.trim().length > 0 || 'Model name required'
        }
      ]);
      newValue = answer.value.trim();
    }
  } else if (field === 'baseUrl') {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'value',
        message: 'Enter new base URL:',
        default: profile.baseUrl,
        validate: (input: string) => input.trim().length > 0 || 'Base URL required'
      }
    ]);
    newValue = answer.value.trim();
  } else {
    return;
  }

  // Update profile — handle apiKey specially (store in keychain, not config.json)
  let effectiveApiKey = await resolveApiKey(profile);
  if (field === 'apiKey') {
    effectiveApiKey = newValue;
    // Store the new key in keychain
    try {
      const store = getCredentialStore();
      await store.set(KEYCHAIN_SERVICE, commandName, newValue);
    } catch { /* keychain write best-effort */ }
    // Mark key in keychain, remove inline apiKey
    delete profile.apiKey;
    profile.keyInKeychain = true;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (profile as any)[field] = newValue;
  }

  // Save to config.json (round-trips the bumped object shape if present)
  const allProfiles = profiles.map(p =>
    p.commandName === commandName ? profile : p
  );
  config.writeProfiles(allProfiles);

  // Update settings.json (pass model override if model was changed)
  if (provider) {
    const modelOverride = field === 'model' ? newValue : profile.model;
    const baseUrlOverride = field === 'baseUrl' ? newValue : profile.baseUrl;
    config.createProfileConfig(commandName, provider, effectiveApiKey, profile.cliType, undefined, false, modelOverride, baseUrlOverride, profile.envOverrides);
  }

  console.log(chalk.green(`\n✓ Updated ${field} for ${commandName}\n`));
}

/**
 * sweetch clone - Clone an existing profile
 */
export async function runClone(sourceName: string, targetName: string): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const source = profiles.find(p => p.commandName === sourceName);

  if (!source) {
    console.error(chalk.red(`\nProfile '${sourceName}' not found\n`));
    process.exit(1);
  }

  if (profiles.some(p => p.commandName === targetName)) {
    console.error(chalk.red(`\nProfile '${targetName}' already exists\n`));
    process.exit(1);
  }

  console.log(chalk.bold(`\n📋 Cloning ${sourceName} → ${targetName}...\n`));

  const { useSameKey } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useSameKey',
      message: 'Use same API key?',
      default: true
    }
  ]);

  let apiKey = await resolveApiKey(source);

  if (!useSameKey) {
    const answer = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter API key for new profile:',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'API key required'
      }
    ]);
    apiKey = answer.apiKey.trim();
  }

  // Ask about sharing inheritance if source profile has sharedWith set
  let inheritSharedWith: string | undefined = undefined;
  if (source.sharedWith) {
    const { inheritShare } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'inheritShare',
        message: `Source profile shares data with ${source.sharedWith}. Should the clone also share with ${source.sharedWith}?`,
        default: false
      }
    ]);
    if (inheritShare) {
      inheritSharedWith = source.sharedWith;
    }
  }

  // Create new profile
  const newProfile: ProfileConfig = {
    ...source,
    name: targetName,
    commandName: targetName,
    apiKey,
    createdAt: new Date().toISOString(),
    sharedWith: inheritSharedWith
  };

  config.addProfile(newProfile);

  const provider = getProvider(source.provider);
  const cli = getCLI(source.cliType);
  if (provider && cli) {
    config.createProfileConfig(targetName, provider, apiKey, cli.name);
  }
  if (cli) {
    config.createWrapperScript(targetName, cli);
  }

  // Set up shared dirs if clone inherits sharing
  if (inheritSharedWith) {
    config.setupSharedDirs(targetName, inheritSharedWith, source.cliType);
  }

  console.log(chalk.green(`\n✓ Created ${targetName} (${provider?.displayName})\n`));
}

/**
 * sweetch rename - Rename a profile
 */
export async function runRename(oldName: string, newName: string): Promise<void> {
  const result = await renameManagedProfile(oldName, newName);
  console.log(chalk.bold(`\n✏️  Renaming ${oldName} → ${result.newName}...\n`));
  console.log(chalk.green(`✓ Renamed ${oldName} → ${result.newName}\n`));
  console.log(chalk.gray('  Command: ' + result.newName));
  console.log(chalk.gray('  Config: ' + result.profileDir));
  if (result.updatedDependents.length > 0) {
    console.log(chalk.gray('  Updated shared profiles: ' + result.updatedDependents.join(', ')));
  }
  console.log();
}
