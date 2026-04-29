import type { AgentEvent, EngineStatus } from './types.js';
import type { Estate } from './estate.js';
import {
  type OmnaiDaemonStreamEnvelope,
  type OmnaiUnsupportedStreamEvent,
  isOmnaiDaemonStreamEnvelope,
  isOmnaiUnsupportedStreamEvent,
} from './stream-contract.js';

type DaemonSSEFrame = AgentEvent | OmnaiDaemonStreamEnvelope | OmnaiUnsupportedStreamEvent;

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

  if (isOmnaiDaemonStreamEnvelope(payload)) {
    return payload.event;
  }
  if (isOmnaiUnsupportedStreamEvent(payload)) {
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

export class OmnaiClient {
  private baseUrl: string;

  constructor(opts?: { port?: number; host?: string }) {
    const port = opts?.port ?? 7845;
    const host = opts?.host ?? '127.0.0.1';
    this.baseUrl = `http://${host}:${port}`;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async select(opts: { provider?: string; engine?: string; budgetTier?: string; taskType?: string; account?: string; fallbackAccounts?: string[]; accountStrategy?: string }): Promise<{ engine: string; account?: string }> {
    const res = await fetch(`${this.baseUrl}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!res.ok) throw new Error(`Daemon select failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async *run(prompt: string, opts?: Record<string, unknown>): AsyncGenerator<AgentEvent> {
    const res = await fetch(`${this.baseUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, ...opts }),
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
    const res = await fetch(`${this.baseUrl}/engines`);
    if (!res.ok) throw new Error(`Daemon engines failed: ${res.status}`);
    return res.json();
  }

  async getEstate(): Promise<Estate> {
    const res = await fetch(`${this.baseUrl}/estate`);
    if (!res.ok) throw new Error(`Daemon estate failed: ${res.status}`);
    return res.json();
  }

  async getQuota(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/quota`);
    if (!res.ok) throw new Error(`Daemon quota failed: ${res.status}`);
    return res.json();
  }
}
