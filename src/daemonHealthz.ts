import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_DAEMON_PORT } from './constants';

/** Timeout budget for individual doctor/dashboard network health checks. */
export const DOCTOR_CHECK_TIMEOUT_MS = 5000;

/** Shape of a daemon /healthz probe outcome. */
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
 * Resolve the daemon HTTP port the same way other CLI commands do.
 * Order: SWEECH_PORT env var -> ~/.fed/config.json (`tools.sweech-engine.dash`)
 * -> DEFAULT_DAEMON_PORT.
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
 * Probe the daemon /healthz endpoint with a hard deadline. The route is
 * intentionally public, so no HMAC signing is needed.
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
      // Treat unusable bodies as unhealthy below.
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
    const names = new Set([e?.name, e?.cause?.name].filter(Boolean));
    const codes = new Set([e?.code, e?.cause?.code].filter(Boolean));
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
