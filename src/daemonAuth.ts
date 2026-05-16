/// T-039: client-side helper that signs sweech daemon requests with the
/// per-host secret stored at ~/.sweech/daemon.secret. Used by the CLI's
/// daemon-touching commands (`sweech run`, `sweech engines`, etc.).
///
/// Mirrors the signing contract in packages/engine/src/daemon/auth.ts:
///   - HMAC-SHA256 over `<METHOD> <path-with-query> <bodyHashHex> <unixMillis>`
///   - The body hash is HMAC-SHA256 with an empty key (matches engine).
///   - X-Sweech-Auth carries the signature hex; X-Sweech-Ts carries the ts.
///
/// Public routes (/healthz, /health, /check, /check/all) don't need a
/// signature — the helper still returns headers but the caller can skip
/// the signing path when probing them.
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SWEECH_AUTH_HEADER = 'X-Sweech-Auth';
export const SWEECH_TS_HEADER = 'X-Sweech-Ts';
const DEFAULT_SECRET_PATH = join(homedir(), '.sweech', 'daemon.secret');

let cachedSecret: string | null = null;
let cachedSecretPath: string | null = null;

export function getDefaultDaemonSecretPath(): string {
  return DEFAULT_SECRET_PATH;
}

export async function loadDaemonSecret(path: string = DEFAULT_SECRET_PATH): Promise<string | null> {
  if (cachedSecret && cachedSecretPath === path) return cachedSecret;
  try {
    const raw = await readFile(path, 'utf-8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    cachedSecret = trimmed;
    cachedSecretPath = path;
    return trimmed;
  } catch {
    return null;
  }
}

export function resetDaemonSecretCacheForTesting(): void {
  cachedSecret = null;
  cachedSecretPath = null;
}

function hashBody(body: string): string {
  return createHmac('sha256', '').update(body).digest('hex');
}

function buildSigningString(method: string, pathWithQuery: string, bodyHash: string, ts: number | string): string {
  return `${method.toUpperCase()} ${pathWithQuery} ${bodyHash} ${ts}`;
}

/// Sign a payload and return Hono-compatible auth headers. The caller is
/// responsible for picking the right method/path; this helper does not
/// know anything about which routes are public.
export function signDaemonRequest(secret: string, method: string, pathWithQuery: string, body: string, ts: number = Date.now()): Record<string, string> {
  const bodyHash = hashBody(body);
  const message = buildSigningString(method, pathWithQuery, bodyHash, ts);
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  return {
    [SWEECH_AUTH_HEADER]: signature,
    [SWEECH_TS_HEADER]: String(ts),
  };
}

/// Convenience wrapper: read the secret from disk and return the headers
/// (plus Content-Type when a body is supplied). If the secret can't be
/// read returns just Content-Type and lets the daemon reject the request
/// with 401 — the CLI surfaces that to the user with a clear hint.
export async function buildAuthedHeaders(method: string, pathWithQuery: string, body: string = ''): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  const secret = await loadDaemonSecret();
  if (!secret) return headers;
  Object.assign(headers, signDaemonRequest(secret, method, pathWithQuery, body));
  return headers;
}
