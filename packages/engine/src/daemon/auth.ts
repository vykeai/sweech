/// T-039: HMAC auth for sweech daemon HTTP API.
///
/// The daemon binds 127.0.0.1 but loopback isn't a security boundary on
/// multi-user macOS — any local process can otherwise call /run and drain
/// the user's model quota. This module:
///
///   - Lazily generates ~/.sweech/daemon.secret (32 hex bytes, 0600) on
///     first daemon start.
///   - Verifies an HMAC-SHA256 signature over `method + " " + path + " "
///     + bodyHash + " " + ts` on every mutating / sensitive request.
///   - Rejects timestamps outside a ±60s window to limit replay risk.
///   - Uses `timingSafeEqual` to neutralise length / value-comparison
///     side channels.
///
/// /healthz, /health, and the read-only check routes remain unauthenticated
/// so orchestrators (and the CLI before it has loaded the secret) can probe
/// liveness without friction.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Context } from 'hono';
import { readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const SWEECH_AUTH_HEADER = 'x-sweech-auth';
export const SWEECH_TS_HEADER = 'x-sweech-ts';
/// Replay window — requests whose `X-Sweech-Ts` falls outside this many
/// milliseconds of the server's clock are rejected. 60s mirrors what most
/// signed-request APIs use; large enough to absorb modest clock skew, tight
/// enough that a captured signature can't be replayed long after capture.
export const SWEECH_TS_SKEW_MS = 60_000;

const DEFAULT_SECRET_PATH = join(homedir(), '.sweech', 'daemon.secret');

let cachedSecret: string | null = null;
let cachedSecretPath: string | null = null;

export function getDefaultSecretPath(): string {
  return DEFAULT_SECRET_PATH;
}

/// Read the secret if it exists and load it into the in-memory cache.
/// Returns null if the file is missing. Throws if the file is unreadable
/// for reasons other than non-existence so callers can surface real I/O
/// errors instead of silently regenerating.
async function readSecretFile(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return trimmed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/// Generate a fresh secret on disk with mode 0600 and return it.
/// Created with `wx` so we never overwrite an existing secret — concurrent
/// daemons race for the file, the loser reads what the winner wrote.
async function writeSecretFile(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString('hex');
  try {
    await writeFile(path, secret + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another daemon raced us. Read what they wrote.
      const existing = await readSecretFile(path);
      if (existing) return existing;
    }
    throw err;
  }
  // Some filesystems / umasks don't honour the open() mode. Force 0600.
  try {
    await chmod(path, 0o600);
  } catch { /* best-effort — the file was created with `mode:` already */ }
  return secret;
}

/// Load the daemon secret, generating it on first call.
/// Subsequent calls return the cached value so each request doesn't hit
/// the disk. Tests / multi-instance scenarios can override `path`.
export async function loadOrCreateSecret(path: string = DEFAULT_SECRET_PATH): Promise<string> {
  if (cachedSecret && cachedSecretPath === path) return cachedSecret;
  const existing = await readSecretFile(path);
  const secret = existing ?? (await writeSecretFile(path));
  cachedSecret = secret;
  cachedSecretPath = path;
  return secret;
}

/// Force-flush the cached secret. Tests call this between cases; production
/// callers shouldn't need it.
export function resetSecretCacheForTesting(): void {
  cachedSecret = null;
  cachedSecretPath = null;
}

/// Return the file mode on the secret (or null if the file doesn't exist).
/// Used by `sweech daemon status` style introspection and by tests asserting
/// that the file was created with 0600.
export async function getSecretFileMode(path: string = DEFAULT_SECRET_PATH): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/// Compute the body hash component of the signature. Empty body hashes the
/// empty string — keeps the signature contract uniform across GET / DELETE
/// requests with no body and POST requests with one.
export function hashBody(body: string): string {
  return createHmac('sha256', '').update(body).digest('hex');
}

/// The canonical message the server signs. Clients MUST produce the same
/// string or the signatures won't match.
///
///   "<METHOD> <path-with-querystring> <bodyHashHex> <unixMillisTs>"
///
/// Including the path (with querystring) prevents a signed request for
/// /healthz being replayed at /run. Including ts in the signed material
/// means an attacker can't grab a sig and bump the ts header to bypass
/// the replay window.
export function buildSigningString(method: string, path: string, bodyHash: string, ts: string | number): string {
  return `${method.toUpperCase()} ${path} ${bodyHash} ${ts}`;
}

export function computeSignature(secret: string, method: string, path: string, body: string, ts: string | number): string {
  const bodyHash = hashBody(body);
  const message = buildSigningString(method, path, bodyHash, ts);
  return createHmac('sha256', secret).update(message).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/// Routes that remain reachable without a valid signature.
///
/// - /healthz and /health: orchestrator probes; need to work before the
///   CLI has even resolved the secret.
/// - /check, /check/all: profile readiness probes; surfaced in dashboards
///   that may not hold the host secret. Returns whether a profile's
///   binary / credentials are present, no secret material.
/// - /favicon.ico: a browser hitting the daemon URL out of curiosity.
const PUBLIC_PATHS = new Set<string>([
  '/healthz',
  '/health',
  '/check',
  '/check/all',
  '/favicon.ico',
]);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

export interface AuthMiddlewareOptions {
  /// Resolver that returns the active secret. Injected so tests can supply
  /// a fixed value without writing to ~/.sweech/.
  getSecret: () => Promise<string>;
  /// Override the wall clock for tests.
  now?: () => number;
  /// Replay-window override; defaults to SWEECH_TS_SKEW_MS.
  skewMs?: number;
}

function unauthorized(c: Context, reason: string): Response {
  return c.json({ ok: false, error: 'unauthorized', reason }, 401);
}

/// Hono middleware that authenticates every non-public route.
///
/// Auth contract:
///   - `X-Sweech-Auth: <hex>` carries the HMAC-SHA256 signature.
///   - `X-Sweech-Ts: <unixMillis>` carries the request timestamp.
///   - Signature is computed over `buildSigningString(method, path, hashBody(rawBody), ts)`.
///
/// Public paths (see PUBLIC_PATHS) bypass auth entirely. Everything else
/// must produce a matching signature within the replay window.
export function createAuthMiddleware(opts: AuthMiddlewareOptions): MiddlewareHandler {
  const skewMs = opts.skewMs ?? SWEECH_TS_SKEW_MS;
  const now = opts.now ?? (() => Date.now());

  return async (c, next) => {
    const url = new URL(c.req.url);
    const { pathname } = url;
    if (isPublicPath(pathname)) {
      return next();
    }

    const sig = c.req.header(SWEECH_AUTH_HEADER);
    const ts = c.req.header(SWEECH_TS_HEADER);
    if (!sig || !ts) {
      return unauthorized(c, 'missing signature headers');
    }

    const tsMs = Number(ts);
    if (!Number.isFinite(tsMs) || tsMs <= 0) {
      return unauthorized(c, 'invalid timestamp');
    }
    const delta = Math.abs(now() - tsMs);
    if (delta > skewMs) {
      return unauthorized(c, 'timestamp outside replay window');
    }

    // Read body as text once; downstream handlers parse via `c.req.json()`
    // which goes through `c.req.raw` — Hono retains the body internally so
    // a clone-and-text here does not consume the original stream.
    let bodyText = '';
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      try {
        const cloned = c.req.raw.clone();
        bodyText = await cloned.text();
      } catch {
        return unauthorized(c, 'unable to read body');
      }
    }

    let secret: string;
    try {
      secret = await opts.getSecret();
    } catch {
      return unauthorized(c, 'server secret unavailable');
    }

    const pathForSig = pathname + url.search;
    const expected = computeSignature(secret, c.req.method, pathForSig, bodyText, ts);
    if (!safeEqualHex(expected, sig)) {
      return unauthorized(c, 'signature mismatch');
    }

    return next();
  };
}

/// Sign a request payload from the client side. Returned headers should be
/// merged into the outbound `fetch` call.
export function signRequest(secret: string, method: string, pathWithQuery: string, body: string, ts: number = Date.now()): {
  signature: string;
  ts: number;
  headers: Record<string, string>;
} {
  const signature = computeSignature(secret, method, pathWithQuery, body, ts);
  return {
    signature,
    ts,
    headers: {
      [SWEECH_AUTH_HEADER]: signature,
      [SWEECH_TS_HEADER]: String(ts),
    },
  };
}
