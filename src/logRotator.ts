/**
 * T-054: Daemon log rotation for `sweech serve` (the fed server).
 *
 * The launchd plist redirects `sweech serve` stdout/stderr to
 * `~/Library/Logs/sweech-serve.log`. Without rotation it grows unbounded.
 * This module rotates the file when either:
 *
 *   - its size exceeds maxBytes (default 10 MiB), OR
 *   - its mtime is from a previous local calendar day.
 *
 * Up to `keep` historical files are retained as `<log>.1` … `<log>.keep`.
 *
 * ## Why copy-truncate instead of rename
 *
 * The `sweech serve` process does NOT own the writer fd — launchd attached
 * the file to the daemon's stdout/stderr when it spawned the process. A
 * plain `rename(current, current.1)` would move the inode; launchd's fd
 * would continue writing into `current.1`, and the new `current` would
 * stay empty forever. The standard logrotate "copytruncate" pattern is the
 * only safe option here: copy the file content into the rotated slot, then
 * truncate the original to zero length. Truncation preserves the inode, so
 * the writer's fd keeps producing output into the same file.
 *
 * This is a CommonJS sibling of packages/engine/src/daemon/log.ts. The two
 * files implement the same algorithm; they are duplicated because the root
 * package (CommonJS) and the engine package (ESM) cannot share modules
 * across rootDir boundaries.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** Maximum log size in bytes before rotation triggers. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

/** Number of historical rotations to retain. `<log>.1` … `<log>.5`. */
export const DEFAULT_KEEP = 5

/** Default rotation check cadence when scheduled by `LogRotator.start()`. */
export const DEFAULT_INTERVAL_MS = 60 * 60 * 1000

/**
 * Resolve the canonical fed-server log path.
 *
 * Honours `SWEECH_LOG_PATH` so the launchd plist's `StandardOutPath` and
 * the rotator agree on the file even if an operator overrides it. Falls
 * back to the macOS convention `~/Library/Logs/sweech-serve.log`.
 */
export function getServeLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SWEECH_LOG_PATH?.trim()
  if (override) return override
  return path.join(os.homedir(), 'Library', 'Logs', 'sweech-serve.log')
}

export interface RotateOptions {
  maxBytes?: number
  keep?: number
  now?: () => Date
}

export interface RotateResult {
  rotated: boolean
  reason: 'size' | 'daily' | 'no-op' | 'missing'
  sizeBefore: number
}

function isPreviousDay(a: Date, b: Date): boolean {
  if (a.getFullYear() !== b.getFullYear()) return true
  if (a.getMonth() !== b.getMonth()) return true
  return a.getDate() !== b.getDate()
}

function backupPath(logPath: string, index: number): string {
  return `${logPath}.${index}`
}

/**
 * One-shot rotation check. See module header for the full procedure.
 */
export function maybeRotateLog(logPath: string, opts: RotateOptions = {}): RotateResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const keep = opts.keep ?? DEFAULT_KEEP
  const now = opts.now ?? (() => new Date())

  if (keep < 1) throw new Error(`LogRotator: keep must be >= 1, got ${keep}`)
  if (maxBytes < 1) throw new Error(`LogRotator: maxBytes must be >= 1, got ${maxBytes}`)

  let st: fs.Stats
  try {
    st = fs.statSync(logPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rotated: false, reason: 'missing', sizeBefore: 0 }
    }
    throw err
  }

  const sizeBefore = st.size
  const sizeTriggered = sizeBefore > maxBytes
  const dailyTriggered = !sizeTriggered && isPreviousDay(st.mtime, now())

  if (!sizeTriggered && !dailyTriggered) {
    return { rotated: false, reason: 'no-op', sizeBefore }
  }

  // Drop the oldest slot if it exists.
  const oldest = backupPath(logPath, keep)
  if (fs.existsSync(oldest)) {
    try { fs.unlinkSync(oldest) } catch { /* best-effort */ }
  }

  // Shift backups down: .(k-1) → .k, .(k-2) → .(k-1), … .1 → .2.
  for (let i = keep - 1; i >= 1; i--) {
    const from = backupPath(logPath, i)
    const to = backupPath(logPath, i + 1)
    if (!fs.existsSync(from)) continue
    try {
      fs.renameSync(from, to)
    } catch {
      // Cross-fs rename fallback would land here; ~/Library/Logs is single-fs.
    }
  }

  // Copy active log into .1.
  try {
    fs.copyFileSync(logPath, backupPath(logPath, 1))
  } catch (err) {
    throw new Error(`LogRotator: failed to copy ${logPath} → ${backupPath(logPath, 1)}: ${(err as Error).message}`)
  }

  // Truncate the active log — preserves the inode so launchd's writer fd
  // keeps producing output into the same file.
  try {
    fs.truncateSync(logPath, 0)
  } catch (err) {
    throw new Error(`LogRotator: failed to truncate ${logPath}: ${(err as Error).message}`)
  }

  return {
    rotated: true,
    reason: sizeTriggered ? 'size' : 'daily',
    sizeBefore,
  }
}

/**
 * Scheduled rotator. Owns a `setInterval` handle so the fed server can
 * stop() it during shutdown.
 */
export class LogRotator {
  private readonly logPath: string
  private readonly maxBytes: number
  private readonly keep: number
  private readonly intervalMs: number
  private readonly now: () => Date
  private timer: NodeJS.Timeout | null = null
  private rotating = false
  private readonly onError: (err: unknown) => void

  constructor(opts: {
    logPath: string
    maxBytes?: number
    keep?: number
    intervalMs?: number
    now?: () => Date
    onError?: (err: unknown) => void
  }) {
    this.logPath = opts.logPath
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.keep = opts.keep ?? DEFAULT_KEEP
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    this.now = opts.now ?? (() => new Date())
    this.onError = opts.onError ?? ((err) => {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[log-rotator] ${message}\n`)
    })
  }

  maybeRotate(): RotateResult {
    if (this.rotating) {
      return { rotated: false, reason: 'no-op', sizeBefore: 0 }
    }
    this.rotating = true
    try {
      return maybeRotateLog(this.logPath, {
        maxBytes: this.maxBytes,
        keep: this.keep,
        now: this.now,
      })
    } finally {
      this.rotating = false
    }
  }

  start(): void {
    if (this.timer) return
    try { this.maybeRotate() } catch (err) { this.onError(err) }
    this.timer = setInterval(() => {
      try { this.maybeRotate() } catch (err) { this.onError(err) }
    }, this.intervalMs)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}
