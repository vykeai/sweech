/// T-054: Daemon log rotation.
///
/// `~/Library/Logs/sweech-serve.log` is the launchd-redirected stdout/stderr
/// for the daemon. Without rotation it grows unbounded — observed multi-gig
/// files on long-running installs. This module rotates the file when either:
///
///   - its size exceeds `maxBytes` (default 10 MiB), OR
///   - its mtime is from a previous local calendar day (daily boundary).
///
/// Up to `keep` historical files are retained as `<log>.1` … `<log>.keep`.
/// Older ones are dropped.
///
/// ## Why copy-truncate instead of rename
///
/// The daemon process does NOT own the writer fd — launchd attached the file
/// to the daemon's stdout/stderr when it spawned the process. A plain
/// `rename(current, current.1)` would move the inode; launchd's fd would
/// continue writing into `current.1`, and the new `current` would stay empty
/// forever. The standard logrotate "copytruncate" pattern is the only safe
/// option here: copy the file content into the rotated slot, then truncate
/// the original to zero length. Truncation preserves the inode, so the
/// writer's fd keeps producing output into the same file.
///
/// Backup slots (`.1` → `.2`, `.2` → `.3`, …) can use plain rename because
/// nothing holds an fd to those files. Only the active log uses copy-truncate.
///
/// ## Concurrency
///
/// The daemon is single-process, so the only realistic race is back-to-back
/// invocations of `maybeRotate()` within the same tick. An in-instance
/// `rotating` flag short-circuits the second call. Tests assert that two
/// sequential calls produce one rotation, not two.
import {
  statSync,
  copyFileSync,
  truncateSync,
  renameSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/// Maximum log size in bytes before rotation triggers. 10 MiB matches the
/// acceptance criterion in T-054.
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/// Number of historical rotations to retain. `<log>.1` … `<log>.5`.
export const DEFAULT_KEEP = 5;

/// Default rotation check cadence when scheduled by `LogRotator.start()`.
/// One hour is a reasonable balance: short enough to catch a runaway log
/// before it gets multi-gig out of hand, long enough that rotation overhead
/// is negligible.
export const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/// Resolve the canonical daemon log path.
///
/// Honours the `SWEECH_LOG_PATH` env var so operators can redirect logs
/// (and so the launchd plist's `StandardOutPath` can stay in sync with
/// the rotator without recompiling). Falls back to the macOS convention
/// `~/Library/Logs/sweech-serve.log`.
export function getDaemonLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SWEECH_LOG_PATH?.trim();
  if (override) return override;
  return join(homedir(), 'Library', 'Logs', 'sweech-serve.log');
}

export interface RotateOptions {
  /// Maximum log file size in bytes. Files larger than this rotate on the
  /// next check. Default: 10 MiB.
  maxBytes?: number;
  /// How many historical files to keep (`<log>.1` … `<log>.keep`). Default: 5.
  keep?: number;
  /// Override the wall clock for tests.
  now?: () => Date;
}

export interface RotateResult {
  /// True if a rotation occurred this call.
  rotated: boolean;
  /// Reason rotation triggered (or didn't).
  reason: 'size' | 'daily' | 'no-op' | 'missing';
  /// Size of the active file before rotation (0 if absent).
  sizeBefore: number;
}

function isPreviousDay(a: Date, b: Date): boolean {
  // Local-time calendar comparison. Daily rotation is from the operator's
  // perspective, not UTC — a log mtime from 2 PM local on Monday should
  // count as "previous day" once it's any time on Tuesday local.
  if (a.getFullYear() !== b.getFullYear()) return true;
  if (a.getMonth() !== b.getMonth()) return true;
  return a.getDate() !== b.getDate();
}

function backupPath(logPath: string, index: number): string {
  return `${logPath}.${index}`;
}

/// One-shot rotation check. Returns `{ rotated, reason, sizeBefore }`.
///
/// Behaviour:
///   - If the log file does not exist → no-op (`reason: 'missing'`).
///   - If size > maxBytes → rotate (`reason: 'size'`).
///   - Else if mtime is from a previous local day → rotate (`reason: 'daily'`).
///   - Else → no-op (`reason: 'no-op'`).
///
/// Rotation procedure:
///   1. Drop `<log>.<keep>` if it exists.
///   2. Rename `<log>.<i>` → `<log>.<i+1>` for i = keep-1 .. 1.
///   3. Copy `<log>` → `<log>.1`.
///   4. Truncate `<log>` to length 0.
///
/// Step 3+4 (copy-truncate) is mandatory because launchd holds the writer
/// fd — see module header for the full rationale.
export function maybeRotateLog(logPath: string, opts: RotateOptions = {}): RotateResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = opts.keep ?? DEFAULT_KEEP;
  const now = opts.now ?? (() => new Date());

  if (keep < 1) {
    throw new Error(`LogRotator: keep must be >= 1, got ${keep}`);
  }
  if (maxBytes < 1) {
    throw new Error(`LogRotator: maxBytes must be >= 1, got ${maxBytes}`);
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(logPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rotated: false, reason: 'missing', sizeBefore: 0 };
    }
    throw err;
  }

  const sizeBefore = st.size;
  const sizeTriggered = sizeBefore > maxBytes;
  const dailyTriggered = !sizeTriggered && isPreviousDay(st.mtime, now());

  if (!sizeTriggered && !dailyTriggered) {
    return { rotated: false, reason: 'no-op', sizeBefore };
  }

  // Phase 1: drop the oldest slot if it exists.
  const oldest = backupPath(logPath, keep);
  if (existsSync(oldest)) {
    try { unlinkSync(oldest); } catch { /* best-effort */ }
  }

  // Phase 2: shift backups down. Move .(k-1) → .k, .(k-2) → .(k-1), … .1 → .2.
  for (let i = keep - 1; i >= 1; i--) {
    const from = backupPath(logPath, i);
    const to = backupPath(logPath, i + 1);
    if (!existsSync(from)) continue;
    try {
      renameSync(from, to);
    } catch {
      // Cross-filesystem rename can fall back to copy+unlink, but for
      // ~/Library/Logs/* this should never trigger. Skip silently rather
      // than abort the rotation mid-shift.
    }
  }

  // Phase 3: copy active log into .1. Use copyFileSync (which honours the
  // size at copy time) — any writes that land while we're copying are
  // either captured in .1 or remain in the active file post-truncate.
  // Either outcome avoids data loss; a tiny window of duplicated lines
  // is acceptable.
  try {
    copyFileSync(logPath, backupPath(logPath, 1));
  } catch (err) {
    throw new Error(`LogRotator: failed to copy ${logPath} → ${backupPath(logPath, 1)}: ${(err as Error).message}`);
  }

  // Phase 4: truncate the active log. This preserves the inode, so launchd's
  // writer fd keeps producing output into the same file.
  try {
    truncateSync(logPath, 0);
  } catch (err) {
    throw new Error(`LogRotator: failed to truncate ${logPath}: ${(err as Error).message}`);
  }

  return {
    rotated: true,
    reason: sizeTriggered ? 'size' : 'daily',
    sizeBefore,
  };
}

/// Scheduled rotator. Owns a `setInterval` handle so the daemon can stop()
/// it during shutdown. Single-instance per daemon process.
///
/// Usage:
///
///   const rotator = new LogRotator({ logPath: getDaemonLogPath() });
///   rotator.start();   // immediate check + every hour thereafter
///   ...
///   rotator.stop();    // on daemon shutdown
export class LogRotator {
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rotating = false;
  private onError: (err: unknown) => void;

  constructor(opts: {
    logPath: string;
    maxBytes?: number;
    keep?: number;
    intervalMs?: number;
    now?: () => Date;
    onError?: (err: unknown) => void;
  }) {
    this.logPath = opts.logPath;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keep = opts.keep ?? DEFAULT_KEEP;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    this.onError = opts.onError ?? ((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[log-rotator] ${message}\n`);
    });
  }

  /// Run a rotation check now. Re-entrancy guard: a second call while the
  /// first is in flight returns the no-op result without rotating twice.
  /// (Rotation itself is synchronous, but the guard remains valuable for
  /// callers that wrap maybeRotate in async chains.)
  maybeRotate(): RotateResult {
    if (this.rotating) {
      return { rotated: false, reason: 'no-op', sizeBefore: 0 };
    }
    this.rotating = true;
    try {
      return maybeRotateLog(this.logPath, {
        maxBytes: this.maxBytes,
        keep: this.keep,
        now: this.now,
      });
    } finally {
      this.rotating = false;
    }
  }

  /// Start the timer. Runs an immediate check, then every intervalMs.
  /// Calling start() on an already-started rotator is a no-op.
  start(): void {
    if (this.timer) return;
    // Immediate check so a daemon restart after a long offline period
    // rotates a stale log right away rather than waiting an hour.
    try { this.maybeRotate(); } catch (err) { this.onError(err); }
    this.timer = setInterval(() => {
      try { this.maybeRotate(); } catch (err) { this.onError(err); }
    }, this.intervalMs);
    // Don't keep the event loop alive just for the rotator — if the daemon
    // is otherwise idle and ready to exit, the rotation timer should not
    // prevent shutdown.
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /// Stop the timer. Idempotent.
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
