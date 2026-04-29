import type { Command } from 'commander';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const PID_FILE = join(homedir(), '.omnai', 'daemon.pid');
const DEFAULT_PORT = 7801;

async function resolvePort(): Promise<number> {
  const envPort = parseInt(process.env.OMNAI_PORT ?? '');
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  try {
    const raw = await readFile(join(homedir(), '.fed', 'config.json'), 'utf-8');
    const cfg = JSON.parse(raw) as { tools?: Record<string, { dash?: number }> };
    return cfg?.tools?.omnai?.dash ?? DEFAULT_PORT;
  } catch { return DEFAULT_PORT; }
}
const HEALTHZ_TIMEOUT_MS = 2_000;
const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_INTERVAL_MS = 250;
const WATCH_POLL_INTERVAL_MS = 30_000;
const WATCH_MAX_RESTARTS = 10;
const WATCH_BACKOFF_BASE_MS = 5_000;
const WATCH_BACKOFF_MAX_MS = 120_000;

async function readPid(): Promise<number | null> {
  try {
    const raw = await readFile(PID_FILE, 'utf-8');
    const pid = parseInt(raw.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isDaemonHealthy(): Promise<boolean> {
  const pid = await readPid();
  if (!pid || !isProcessAlive(pid)) return false;
  const port = await resolvePort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTHZ_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    const data = await res.json() as { ok?: boolean };
    return !!data.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function spawnDaemon(entryPoint: string): number | undefined {
  const child = spawn('node', [entryPoint], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_INTERVAL_MS));
  }
  return !isProcessAlive(pid);
}

export function registerDaemonCommands(program: Command) {
  const daemon = program
    .command('daemon')
    .description('Manage the omnai HTTP daemon');

  daemon
    .command('start')
    .description('Start the daemon in the background; check readiness with `omnai daemon status` or `/healthz`')
    .action(async () => {
      const existingPid = await readPid();
      if (existingPid && isProcessAlive(existingPid)) {
        console.log(`Daemon already running (pid ${existingPid})`);
        return;
      }

      const entryPoint = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');
      const child = spawn('node', [entryPoint], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      console.log(`omnai daemon started (pid ${child.pid})`);
    });

  daemon
    .command('stop')
    .description('Stop the running daemon and wait for graceful lifecycle shutdown')
    .action(async () => {
      const pid = await readPid();
      if (!pid) {
        console.log('No PID file found — daemon not running');
        return;
      }

      if (!isProcessAlive(pid)) {
        console.log(`PID ${pid} not running — cleaning up stale PID file`);
        await unlink(PID_FILE).catch(() => {});
        return;
      }

      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to daemon (pid ${pid}); waiting up to ${Math.round(STOP_TIMEOUT_MS / 1000)}s for shutdown`);
      const stopped = await waitForProcessExit(pid);
      if (!stopped) {
        console.log(`Daemon did not stop within ${Math.round(STOP_TIMEOUT_MS / 1000)}s`);
        process.exitCode = 1;
        return;
      }
      await unlink(PID_FILE).catch(() => {});
      console.log('Daemon stopped cleanly');
    });

  daemon
    .command('status')
    .description('Check daemon process state and readiness via /healthz')
    .action(async () => {
      const pid = await readPid();
      if (!pid || !isProcessAlive(pid)) {
        console.log('Daemon is not running');
        process.exitCode = 1;
        return;
      }

      const port = await resolvePort();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTHZ_TIMEOUT_MS);

      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
        const data = await res.json();
        console.log(`Daemon process exists (pid ${pid})`);
        console.log(`  state: ${data.state}`);
        console.log(`  ready: ${data.ok}`);
        if (!data.ok) {
          console.log(`  reason: ${data.reason}`);
          process.exitCode = 1;
          return;
        }
        console.log(`  activeSessions: ${data.activeSessions}`);
        console.log(`  uptime: ${Math.round(data.uptime)}s`);
        console.log(`  version: ${data.version}`);
      } catch {
        console.log(`Daemon process exists (pid ${pid}) but /healthz not reachable`);
        process.exitCode = 1;
      } finally {
        clearTimeout(timer);
      }
    });

  daemon
    .command('watch')
    .description('Start and watchdog the daemon — auto-restarts on crash (runs in foreground)')
    .option('--max-restarts <n>', 'Maximum restart attempts before giving up', String(WATCH_MAX_RESTARTS))
    .action(async (opts: { maxRestarts: string }) => {
      const maxRestarts = Math.max(1, parseInt(opts.maxRestarts, 10) || WATCH_MAX_RESTARTS);
      const entryPoint = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');

      let restarts = 0;
      let backoffMs = WATCH_BACKOFF_BASE_MS;

      const log = (msg: string) => console.log(`[omnai watchdog ${new Date().toISOString()}] ${msg}`);

      log(`Starting watchdog (max-restarts=${maxRestarts})`);

      // Start daemon if not already running
      const initialPid = await readPid();
      if (!initialPid || !isProcessAlive(initialPid)) {
        const pid = spawnDaemon(entryPoint);
        log(`Daemon started (pid ${pid})`);
        // Brief pause to let it bind the port
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        log(`Daemon already running (pid ${initialPid})`);
      }

      // Gracefully exit on SIGINT/SIGTERM — don't kill the daemon, just stop watching
      let stopped = false;
      const stop = () => { stopped = true; log('Watchdog stopping (signal received)'); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);

      while (!stopped) {
        await new Promise((r) => setTimeout(r, WATCH_POLL_INTERVAL_MS));
        if (stopped) break;

        const healthy = await isDaemonHealthy();
        if (healthy) {
          backoffMs = WATCH_BACKOFF_BASE_MS; // reset backoff on recovery
          continue;
        }

        restarts += 1;
        if (restarts > maxRestarts) {
          log(`Daemon failed ${maxRestarts} restart(s) — giving up`);
          process.exitCode = 1;
          return;
        }

        log(`Daemon unhealthy — restart ${restarts}/${maxRestarts} (backoff ${backoffMs}ms)`);

        // Kill stale process if still holding PID
        const stalePid = await readPid();
        if (stalePid && isProcessAlive(stalePid)) {
          try { process.kill(stalePid, 'SIGTERM'); } catch { /* already dead */ }
          await new Promise((r) => setTimeout(r, 1000));
          if (isProcessAlive(stalePid)) {
            try { process.kill(stalePid, 'SIGKILL'); } catch { /* already dead */ }
          }
        }

        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, WATCH_BACKOFF_MAX_MS);

        const pid = spawnDaemon(entryPoint);
        log(`Daemon restarted (pid ${pid})`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    });
}
