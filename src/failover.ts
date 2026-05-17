/**
 * Auto-failover for rate-limited profiles (T-LU-003).
 *
 * The daemon-side fetch path (liveUsage.ts) calls `recordRateLimitCooldown`
 * whenever a probe sees a 429 / `limit_reached` status. That writes a
 * marker into ~/.sweech/failover-cooldowns.json with an expiry timestamp
 * AND fires:
 *   - an audit-log entry (`rate_limit_cooldown`)
 *   - the existing `limit_reached` event bus signal
 *
 * When something needs the "best alternative right now" — the menu bar's
 * auto-switcher, the `sweech failover` CLI, requestor v1 — it calls
 * `pickFailoverTarget(currentCmdName)` which delegates to
 * `accountSelector.suggestBestAccount` but additionally excludes any
 * profile whose cooldown hasn't expired AND the source profile itself.
 *
 * `recordFailover` is called once the caller has actually rotated and
 * fires both an audit entry (`failover_rotated`) and the typed event of
 * the same name so webhooks deliver.
 *
 * Cooldown durations:
 *   - default DEFAULT_COOLDOWN_MS (15 minutes) — long enough that a
 *     transient 429 burst doesn't constantly flap, short enough that a
 *     recovered profile re-enters the pool quickly
 *   - callable with an explicit `resetMs` so liveUsage can honour the
 *     reset epoch the upstream provider returned
 *
 * The cooldown file is intentionally simple JSON (no locks): worst-case
 * concurrent writes lose one cooldown entry, which the very next probe
 * re-creates. Atomic write via fs.rename keeps readers from observing
 * partial content.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sweechEvents } from './events';
import { logAudit } from './auditLog';
import { atomicWriteFileSync } from './atomicWrite';
import { recommendRoute, suggestBestAccount, type AccountRecommendation } from './accountSelector';
import type { ProfileConfig } from './config';

const SWEECH_DIR = path.join(os.homedir(), '.sweech');
const COOLDOWN_FILE = path.join(SWEECH_DIR, 'failover-cooldowns.json');

/** Default cooldown when the caller doesn't pass an explicit reset time. */
export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

export interface CooldownEntry {
  /** Profile commandName (matches keys in accountSelector enumerations). */
  commandName: string;
  /** When the cooldown expires (ms epoch). After this the profile is reusable. */
  expiresAt: number;
  /** Why the cooldown was recorded (e.g. "limit_reached", "manual"). */
  reason: string;
  /** When it was recorded (ms epoch) — for debug/audit. */
  recordedAt: number;
}

type CooldownStore = Record<string, CooldownEntry>;

// ─── Read / Write ────────────────────────────────────────────────────────────

function readCooldownStore(): CooldownStore {
  try {
    if (!fs.existsSync(COOLDOWN_FILE)) return {};
    const raw = fs.readFileSync(COOLDOWN_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as CooldownStore;
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch {
    return {};
  }
}

function writeCooldownStore(store: CooldownStore): void {
  try {
    if (!fs.existsSync(SWEECH_DIR)) fs.mkdirSync(SWEECH_DIR, { recursive: true, mode: 0o700 });
    // mode 0o600 is applied on the temp file before rename — closes the
    // TOCTOU window where a co-tenant could open() a world-readable fd
    // between rename and chmod and keep it open across the chmod.
    atomicWriteFileSync(COOLDOWN_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[sweech] failover cooldown write failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Record a cooldown on a profile because it returned 429 / limit_reached.
 *
 * - `resetMs` (optional) is honoured exactly — used when the upstream
 *   provider returned a reset time. Falls back to DEFAULT_COOLDOWN_MS.
 * - Writes audit entry + emits the typed `limit_reached` event so any
 *   webhook subscriber learns about the rate-limit immediately.
 * - Idempotent: re-recording the same profile updates the entry instead
 *   of stacking.
 */
export function recordRateLimitCooldown(
  commandName: string,
  opts: { reason?: string; resetMs?: number; window?: '5h' | '7d' } = {},
): CooldownEntry {
  const now = Date.now();
  const duration = opts.resetMs && opts.resetMs > 0 ? opts.resetMs : DEFAULT_COOLDOWN_MS;
  const entry: CooldownEntry = {
    commandName,
    expiresAt: now + duration,
    reason: opts.reason ?? 'limit_reached',
    recordedAt: now,
  };

  const store = readCooldownStore();
  store[commandName] = entry;
  writeCooldownStore(store);

  logAudit({
    timestamp: new Date(now).toISOString(),
    action: 'rate_limit_cooldown',
    account: commandName,
    details: {
      expiresAt: new Date(entry.expiresAt).toISOString(),
      reason: entry.reason,
      ...(opts.window ? { window: opts.window } : {}),
    },
  });

  if (opts.window) {
    sweechEvents.emit('limit_reached', {
      account: commandName,
      window: opts.window,
      timestamp: new Date(now).toISOString(),
    });
  }

  return entry;
}

/**
 * Return all currently-active cooldowns (expired ones are filtered out
 * AND removed from disk to keep the file from growing unboundedly).
 */
export function getActiveCooldowns(now: number = Date.now()): CooldownEntry[] {
  const store = readCooldownStore();
  const active: CooldownEntry[] = [];
  let mutated = false;

  for (const [key, entry] of Object.entries(store)) {
    if (entry.expiresAt > now) {
      active.push(entry);
    } else {
      delete store[key];
      mutated = true;
    }
  }

  if (mutated) writeCooldownStore(store);
  return active;
}

/** Is the given profile currently in a cooldown that hasn't expired? */
export function isInCooldown(commandName: string, now: number = Date.now()): boolean {
  const store = readCooldownStore();
  const entry = store[commandName];
  return Boolean(entry && entry.expiresAt > now);
}

/**
 * Clear a single cooldown. Returns true if an entry was removed.
 * Used by the `sweech failover --clear <name>` CLI affordance.
 */
export function clearCooldown(commandName: string): boolean {
  const store = readCooldownStore();
  if (!(commandName in store)) return false;
  delete store[commandName];
  writeCooldownStore(store);
  logAudit({
    timestamp: new Date().toISOString(),
    action: 'rate_limit_cooldown_cleared',
    account: commandName,
  });
  return true;
}

/** Clear all cooldowns at once — for ops/recovery use. */
export function clearAllCooldowns(): number {
  const store = readCooldownStore();
  const count = Object.keys(store).length;
  if (count === 0) return 0;
  writeCooldownStore({});
  logAudit({
    timestamp: new Date().toISOString(),
    action: 'rate_limit_cooldown_cleared_all',
    details: { count },
  });
  return count;
}

export interface FailoverPickOptions {
  /** Restrict the search to a specific CLI type. */
  cliType?: string;
  /** Explicit profile list (defaults to ConfigManager().getProfiles()). */
  profiles?: ProfileConfig[];
  /** Additional commandNames to exclude beyond the source + cooldowns. */
  exclude?: string[];
  /** Override "now" for deterministic tests. */
  now?: number;
}

/**
 * Pick the next-best profile to fail over to, excluding the source profile
 * AND any profile currently in cooldown.
 *
 * Returns undefined when nothing's available — the caller should escalate
 * (alert, retry-later, exit non-zero, etc.).
 *
 * NOTE: failover is intentionally project-pin and budget unaware.
 *   - A project pin (`.sweech.json`) typically names a specific profile;
 *     if that profile just hit a rate-limit (the reason we're failing
 *     over), honoring the pin would re-select the same profile.
 *   - `--budget` is similarly omitted: when the user calls `sweech
 *     failover`, the priority is "find anything that works", not "find
 *     something under N USD/call". A failover that respects budget and
 *     returns nothing leaves the user worse off than the rate-limit
 *     they're already escaping.
 *   If you need both pin + budget AND failover, compose them at the
 *   caller: `sweech auto --budget X` from a pinned dir is the right
 *   surface for that case.
 */
export async function pickFailoverTarget(
  fromCommandName: string | undefined,
  opts: FailoverPickOptions = {},
): Promise<AccountRecommendation | undefined> {
  const excluded = new Set<string>();
  if (fromCommandName) excluded.add(fromCommandName);
  for (const x of opts.exclude ?? []) excluded.add(x);

  const now = opts.now ?? Date.now();
  for (const entry of getActiveCooldowns(now)) {
    excluded.add(entry.commandName);
  }

  // suggestBestAccount only returns ONE candidate AND it adds built-in
  // defaults (claude, codex, kimi) on top of the passed profile list —
  // post-filtering a single result silently drops availability if the
  // default collides with `excluded`. Use recommendRoute, which returns
  // every scored candidate, and pick the highest-scoring one that's
  // actually free.
  const baseProfiles = opts.profiles ?? (() => {
    const { ConfigManager } = require('./config') as typeof import('./config');
    return new ConfigManager().getProfiles();
  })();
  const filteredProfiles = baseProfiles.filter(p => !excluded.has(p.commandName));

  const route = await recommendRoute({ cliType: opts.cliType }, filteredProfiles);

  // Walk candidates by descending score (the response already sorts that
  // way) and return the first one not in the excluded set. Each candidate
  // is wrapped to match the AccountRecommendation shape suggestBestAccount
  // would have returned — preserves the existing caller contract.
  for (const candidate of route.candidates) {
    if (excluded.has(candidate.account.commandName)) continue;
    if (candidate.reasons.length > 0) continue; // rejected by capability/auth/etc
    if (!Number.isFinite(candidate.score)) continue;
    return {
      account: {
        name: candidate.account.name,
        commandName: candidate.account.commandName,
        cliType: candidate.route.cliType,
        configDir: candidate.route.configDir,
        isDefault: candidate.account.isDefault,
        isManaged: candidate.account.isManaged,
      },
      score: candidate.score,
      reason: candidate.scoreReason,
    };
  }
  return undefined;
}

/**
 * Record a successful failover rotation. Logs to audit + emits the
 * `failover_rotated` event so webhook subscribers update their routing.
 *
 * Call this AFTER the caller has actually switched (e.g. spawned the new
 * CLI). Recording without rotating produces misleading audit history.
 */
export function recordFailover(from: string, to: string, reason: string): void {
  const timestamp = new Date().toISOString();
  logAudit({
    timestamp,
    action: 'failover_rotated',
    account: to,
    details: { from, to, reason },
  });
  sweechEvents.emit('failover_rotated', { from, to, reason, timestamp });
}

/**
 * Subscribe to the existing `limit_reached` event so any threshold-crossing
 * detected by `checkUsageThresholds` automatically records a cooldown.
 *
 * Returns the unsubscribe function. Idempotent: calling twice still only
 * registers one listener (re-registering is a no-op).
 *
 * Called by the `sweech serve` daemon at startup so the cooldown file
 * stays in sync with reality without every probe site needing to know
 * about failover.
 */
let __listenerRegistered = false;
let __listener: ((data: { account: string; window: '5h' | '7d'; timestamp: string }) => void) | null = null;

// Tag attached to our listener function so we can identify and remove our
// own callbacks across module-reload boundaries (no-op today; nodemon /
// keel-style daemon hot-reload would otherwise leak listeners). Survives
// require-cache busting because the EventEmitter holds the function ref.
const SWEECH_FAILOVER_TAG = '__sweechFailover';

export function startFailoverListener(): () => void {
  // Defence in depth: scrub any tagged listener that survived a hot reload
  // (or a previous test crash that bypassed stopFailoverListener), so we
  // never end up with two failover handlers on the same event.
  for (const l of sweechEvents.listeners('limit_reached')) {
    if ((l as unknown as Record<string, unknown>)[SWEECH_FAILOVER_TAG]) {
      sweechEvents.off('limit_reached', l as (data: any) => void);
    }
  }

  if (__listenerRegistered && __listener) {
    // State says registered but the scrub above removed any tagged
    // listener — re-attach to keep the contract honest.
    sweechEvents.on('limit_reached', __listener);
    return () => stopFailoverListener();
  }
  __listener = (data) => {
    // Map window → reset estimate. 5h → 15 minutes (generous), 7d →
    // longer (an hour) because the 7d limit takes much longer to recover.
    // Real reset epochs are honoured separately by callers that have them.
    const resetMs = data.window === '5h' ? DEFAULT_COOLDOWN_MS : 60 * 60 * 1000;
    // IMPORTANT: do NOT pass `window` here — recordRateLimitCooldown
    // would re-emit `limit_reached`, which we'd catch in this same
    // listener, infinite-looping. The bookkeeping (cooldown file +
    // audit entry) is enough; the original event already fired.
    recordRateLimitCooldown(data.account, {
      reason: `limit_reached:${data.window}`,
      resetMs,
    });
  };
  (__listener as unknown as Record<string, unknown>)[SWEECH_FAILOVER_TAG] = true;
  sweechEvents.on('limit_reached', __listener);
  __listenerRegistered = true;
  return () => stopFailoverListener();
}

export function stopFailoverListener(): void {
  // Always reset module-level state even if the listener was never set —
  // a test that throws between start and stop must NOT leave a stale
  // __listenerRegistered=true behind that suppresses the next start.
  if (__listener) {
    sweechEvents.off('limit_reached', __listener);
  }
  // Also scrub any tagged listener that survived from another module
  // instance (hot reload, test pollution).
  for (const l of sweechEvents.listeners('limit_reached')) {
    if ((l as unknown as Record<string, unknown>)[SWEECH_FAILOVER_TAG]) {
      sweechEvents.off('limit_reached', l as (data: any) => void);
    }
  }
  __listener = null;
  __listenerRegistered = false;
}
