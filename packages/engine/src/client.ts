import type { AgentEvent, EngineStatus } from './types.js';
import type { Estate } from './estate.js';
import {
  type SweechDaemonStreamEnvelope,
  type SweechUnsupportedStreamEvent,
  isSweechDaemonStreamEnvelope,
  isSweechUnsupportedStreamEvent,
} from './stream-contract.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DAEMON_PORT } from './constants.js';
import { homedir } from 'node:os';
import { signRequest, getDefaultSecretPath } from './daemon/auth.js';

type DaemonSSEFrame = AgentEvent | SweechDaemonStreamEnvelope | SweechUnsupportedStreamEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return isRecord(value) && typeof value.type === 'string';
}

function parseDaemonEventFrame(raw: string): AgentEvent | null {
  let payload: DaemonSSEFrame;
  try {
    payload = JSON.parse(raw) as DaemonSSEFrame;
  } catch {
    return {
      type: 'error',
      message: 'daemon stream produced malformed JSON',
    };
  }

  if (isSweechDaemonStreamEnvelope(payload)) {
    return payload.event;
  }
  if (isSweechUnsupportedStreamEvent(payload)) {
    return {
      type: 'error',
      message: `daemon stream unsupported event: ${payload.reason}`,
    };
  }
  if (isAgentEvent(payload)) return payload;

  return {
    type: 'error',
    message: 'daemon stream produced unsupported payload shape',
  };
}

const FED_CONFIG_FILE = join(homedir(), '.fed', 'config.json');
const DEFAULT_PORT = DEFAULT_DAEMON_PORT;

async function resolvePort(): Promise<number> {
  const envPort = parseInt(process.env.SWEECH_PORT ?? '', 10);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  try {
    const raw = await readFile(FED_CONFIG_FILE, 'utf-8');
    const cfg = JSON.parse(raw) as { tools?: Record<string, { dash?: number; enabled?: boolean }> };
    const toolPort = cfg?.tools?.['sweech-engine']?.dash;
    if (typeof toolPort === 'number' && toolPort > 0) return toolPort;
  } catch { /* config not available */ }
  return DEFAULT_PORT;
}

/// Lazy reader for ~/.sweech/daemon.secret. Cached after first hit so we
/// don't re-read the file for every request; the daemon doesn't rotate
/// secrets during its lifetime.
let cachedClientSecret: string | null = null;

async function loadClientSecret(secretPath: string = getDefaultSecretPath()): Promise<string | null> {
  if (cachedClientSecret !== null) return cachedClientSecret;
  try {
    const raw = await readFile(secretPath, 'utf-8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    cachedClientSecret = trimmed;
    return trimmed;
  } catch {
    return null;
  }
}

/// Reset cached secret. Test-only — production callers never need this.
export function resetClientSecretCacheForTesting(): void {
  cachedClientSecret = null;
}

export class SweechClient {
  private baseUrl: string;
  private secretPath: string;

  constructor(opts?: { port?: number; host?: string; secretPath?: string }) {
    const port = opts?.port ?? DEFAULT_PORT;
    const host = opts?.host ?? '127.0.0.1';
    this.baseUrl = `http://${host}:${port}`;
    this.secretPath = opts?.secretPath ?? getDefaultSecretPath();
  }

  static async discover(opts?: { host?: string; secretPath?: string }): Promise<SweechClient> {
    const port = await resolvePort();
    return new SweechClient({ port, ...opts });
  }

  /// Build the headers needed to authenticate a request. Returns the
  /// Content-Type and (if a secret is available) the HMAC signing headers.
  /// Public routes (/healthz, /health) skip the signature; protected routes
  /// require it. When the secret cannot be read, the request is sent
  /// unsigned and the daemon will respond 401.
  private async authedHeaders(method: string, pathWithQuery: string, body: string): Promise<Record<string, string>> {
    const base: Record<string, string> = {};
    if (body) base['Content-Type'] = 'application/json';
    const secret = await loadClientSecret(this.secretPath);
    if (!secret) return base;
    const { headers } = signRequest(secret, method, pathWithQuery, body);
    return { ...base, ...headers };
  }

  async ping(): Promise<boolean> {
    try {
      // /health is public — no signature required.
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async select(opts: { provider?: string; engine?: string; budgetTier?: string; taskType?: string; account?: string; fallbackAccounts?: string[]; accountStrategy?: string }): Promise<{ engine: string; account?: string }> {
    const body = JSON.stringify(opts);
    const headers = await this.authedHeaders('POST', '/select', body);
    const res = await fetch(`${this.baseUrl}/select`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) throw new Error(`Daemon select failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async *run(prompt: string, opts?: Record<string, unknown>): AsyncGenerator<AgentEvent> {
    const body = JSON.stringify({ prompt, ...opts });
    const headers = await this.authedHeaders('POST', '/run', body);
    const res = await fetch(`${this.baseUrl}/run`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) throw new Error(`Daemon run failed: ${res.status}`);
    if (!res.body) throw new Error('No response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const json = line.slice(6).trim();
          if (json) {
            const event = parseDaemonEventFrame(json);
            if (event) {
              yield event;
            }
          }
        }
      }
    }
  }

  async getEngines(): Promise<EngineStatus[]> {
    const headers = await this.authedHeaders('GET', '/engines', '');
    const res = await fetch(`${this.baseUrl}/engines`, { headers });
    if (!res.ok) throw new Error(`Daemon engines failed: ${res.status}`);
    return res.json();
  }

  async getEstate(): Promise<Estate> {
    const headers = await this.authedHeaders('GET', '/estate', '');
    const res = await fetch(`${this.baseUrl}/estate`, { headers });
    if (!res.ok) throw new Error(`Daemon estate failed: ${res.status}`);
    return res.json();
  }

  async getQuota(): Promise<Record<string, unknown>> {
    const headers = await this.authedHeaders('GET', '/quota', '');
    const res = await fetch(`${this.baseUrl}/quota`, { headers });
    if (!res.ok) throw new Error(`Daemon quota failed: ${res.status}`);
    return res.json();
  }
}
