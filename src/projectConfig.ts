/**
 * Project-aware routing via `.sweech.json`.
 *
 * Walks upward from the current working directory looking for a
 * `.sweech.json` file that pins routing for everything inside that
 * project root. The first one found wins. Unknown keys are tolerated
 * (logged once to stderr) so we can grow the schema without breaking
 * existing files. Malformed JSON returns null and logs to stderr —
 * the CLI keeps working with the empty pin instead of crashing.
 *
 * Schema (forward-compatible):
 *   {
 *     "profile":  "claude-work",        // sweech profile commandName
 *     "cliType":  "claude",             // claude | codex | kimi
 *     "maxTier":  "max",                // free | pro | max | team | enterprise
 *     "model":    "claude-opus-4-7",    // optional model hint
 *     "budget":   { ... }               // forward-compat
 *   }
 *
 * Why upward walk: monorepos pin once at the root and every nested
 * package inherits. The walk stops at the user's HOME so we never
 * leak a pin from `/Users/luke/.sweech.json` into an unrelated repo
 * checked out next to it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export type ProjectPinCliType = 'claude' | 'codex' | 'kimi';

export type ProjectPinTier = 'free' | 'pro' | 'max' | 'team' | 'enterprise';

export interface ProjectPin {
  /** Sweech profile commandName (e.g. "claude-work") to prefer. */
  profile?: string;
  /** Restrict routing to a specific CLI engine. */
  cliType?: ProjectPinCliType;
  /** Cap the tier — candidates above this are filtered out. */
  maxTier?: ProjectPinTier;
  /** Optional model hint (forwarded to recommendRoute as preferredModel). */
  model?: string;
  /** Forward-compat: a budget object the caller may read on its own. */
  budget?: Record<string, unknown>;
}

export interface ProjectPinResolved {
  /** The parsed pin contents. */
  pin: ProjectPin;
  /** Absolute path to the `.sweech.json` file that won. */
  source: string;
  /** Directory containing `source` (i.e. the project root). */
  projectRoot: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PIN_FILENAME = '.sweech.json';

const VALID_CLI_TYPES: ReadonlySet<string> = new Set(['claude', 'codex', 'kimi']);
const VALID_TIERS: ReadonlySet<string> = new Set([
  'free', 'pro', 'max', 'team', 'enterprise',
]);

/**
 * Ordered tier list — index = strictness rank. A candidate with rank > pin.maxTier
 * rank is filtered out.
 */
const TIER_RANK: Record<ProjectPinTier, number> = {
  free: 0,
  pro: 1,
  max: 2,
  team: 3,
  enterprise: 4,
};

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'profile', 'cliType', 'maxTier', 'model', 'budget',
]);

/**
 * Track keys we've already warned about so a long-running daemon doesn't
 * spam stderr each time it re-reads the same malformed pin.
 */
const warnedUnknownKeys: Set<string> = new Set();
const warnedMalformedPaths: Set<string> = new Set();

// ── Utility ──────────────────────────────────────────────────────────────────

/**
 * Resolve the cwd safely. If `process.cwd()` throws (deleted directory),
 * fall back to HOME — matches `cwdGuard.ts` semantics so the CLI keeps
 * running instead of crashing on a stale shell.
 */
function safeCwd(cwd?: string): string {
  if (cwd) return cwd;
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

/**
 * Internal: warn once to stderr. The set keys prevent spam from daemon
 * processes that re-read the same pin file every recommendation cycle.
 */
function warnOnce(key: string, message: string): void {
  if (warnedUnknownKeys.has(key)) return;
  warnedUnknownKeys.add(key);
  // eslint-disable-next-line no-console
  console.error(message);
}

/**
 * For tests — clear the warned-once memo so identical bad files in
 * sequential test runs surface a fresh warning.
 */
export function _resetWarningCache(): void {
  warnedUnknownKeys.clear();
  warnedMalformedPaths.clear();
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a raw parsed JSON object against the pin schema.
 *
 * Returns the cleaned pin. Unknown keys are logged once but tolerated.
 * Wrong-typed values are dropped with a stderr warning (not thrown — the
 * CLI keeps working without that field).
 */
function validatePin(raw: unknown, source: string): ProjectPin {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const pin: ProjectPin = {};

  // profile: string only
  if (obj.profile !== undefined) {
    if (typeof obj.profile === 'string' && obj.profile.trim().length > 0) {
      pin.profile = obj.profile.trim();
    } else {
      warnOnce(
        `${source}#profile`,
        `sweech: ignoring '.sweech.json#profile' in ${source} — expected non-empty string`,
      );
    }
  }

  // cliType: claude | codex | kimi
  if (obj.cliType !== undefined) {
    if (typeof obj.cliType === 'string' && VALID_CLI_TYPES.has(obj.cliType)) {
      pin.cliType = obj.cliType as ProjectPinCliType;
    } else {
      warnOnce(
        `${source}#cliType`,
        `sweech: ignoring '.sweech.json#cliType' in ${source} — expected one of ${Array.from(VALID_CLI_TYPES).join(', ')}`,
      );
    }
  }

  // maxTier: free | pro | max | team | enterprise
  if (obj.maxTier !== undefined) {
    if (typeof obj.maxTier === 'string' && VALID_TIERS.has(obj.maxTier)) {
      pin.maxTier = obj.maxTier as ProjectPinTier;
    } else {
      warnOnce(
        `${source}#maxTier`,
        `sweech: ignoring '.sweech.json#maxTier' in ${source} — expected one of ${Array.from(VALID_TIERS).join(', ')}`,
      );
    }
  }

  // model: optional string hint
  if (obj.model !== undefined) {
    if (typeof obj.model === 'string' && obj.model.trim().length > 0) {
      pin.model = obj.model.trim();
    } else {
      warnOnce(
        `${source}#model`,
        `sweech: ignoring '.sweech.json#model' in ${source} — expected non-empty string`,
      );
    }
  }

  // budget: forward-compat object (no shape check, caller handles)
  if (obj.budget !== undefined) {
    if (obj.budget && typeof obj.budget === 'object' && !Array.isArray(obj.budget)) {
      pin.budget = obj.budget as Record<string, unknown>;
    } else {
      warnOnce(
        `${source}#budget`,
        `sweech: ignoring '.sweech.json#budget' in ${source} — expected object`,
      );
    }
  }

  // Unknown keys — log once per key, do not reject. Forward-compat: we may
  // add fields later that older CLI binaries should silently ignore.
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      warnOnce(
        `${source}#${key}`,
        `sweech: unknown key '${key}' in ${source} — ignored (will be supported in a future version?)`,
      );
    }
  }

  return pin;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read and validate a single `.sweech.json` at the exact path. Returns
 * the parsed pin or `null` on missing/malformed file. Used by tests and
 * by `findProjectPin` internally.
 *
 * Errors:
 *   - File missing → null (no log; caller is asking about a specific path)
 *   - Malformed JSON → null + one-shot stderr warning
 *   - Non-object root → empty pin (e.g. `[]` or `"string"` → {})
 *   - Permission denied → null + stderr warning (don't crash the CLI)
 */
export function readProjectPin(filePath: string): ProjectPin | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') return null;
    // Permission / unreadable — surface once.
    if (!warnedMalformedPaths.has(filePath)) {
      warnedMalformedPaths.add(filePath);
      // eslint-disable-next-line no-console
      console.error(
        `sweech: could not read .sweech.json at ${filePath}: ${e?.message ?? String(err)}`,
      );
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    if (!warnedMalformedPaths.has(filePath)) {
      warnedMalformedPaths.add(filePath);
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(
        `sweech: ignoring malformed .sweech.json at ${filePath} — ${msg}`,
      );
    }
    return null;
  }

  return validatePin(parsed, filePath);
}

/**
 * Walk from `cwd` upward looking for the nearest `.sweech.json`. The
 * search stops at the user's HOME directory or the filesystem root,
 * whichever comes first — that way a stray `~/.sweech.json` cannot
 * accidentally route every project under HOME.
 *
 * Returns the resolved pin + the absolute source path, or `null` when
 * no pin is found.
 */
export function findProjectPin(cwd?: string): ProjectPinResolved | null {
  const start = path.resolve(safeCwd(cwd));
  const home = path.resolve(os.homedir());
  const root = path.parse(start).root;

  let dir = start;
  // Track visited paths to avoid edge-case infinite loops on weird
  // mount points where `path.dirname(x) === x` returns identically.
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    const candidate = path.join(dir, PIN_FILENAME);
    if (fs.existsSync(candidate)) {
      // Guard: if HOME == start dir, allow the HOME pin to win (intentional).
      // If we've walked OUT of HOME's project tree and are above it, the
      // pin must not apply — stop before we hit `~/.sweech.json`.
      if (dir === home && start !== home && !start.startsWith(home + path.sep)) {
        // start is somewhere unrelated to HOME (e.g. /opt/...) and we
        // landed on HOME — do NOT use ~/.sweech.json for /opt/foo.
        break;
      }
      const pin = readProjectPin(candidate);
      if (pin === null) {
        // Malformed at this level — keep walking upward. A broken inner
        // pin shouldn't black out a valid outer one.
        if (dir === root) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
        continue;
      }
      return {
        pin,
        source: candidate,
        projectRoot: dir,
      };
    }

    // Stop conditions: hit the root, OR walked above HOME (unless we
    // started AT or BELOW HOME, in which case the HOME-level pin is fair game).
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    // If we've walked one level above HOME without being descended from
    // HOME, stop. Otherwise allow HOME itself to be the final candidate.
    if (parent === path.dirname(home) && dir !== home && !start.startsWith(home + path.sep) && start !== home) {
      break;
    }
    dir = parent;
  }

  return null;
}

// ── Tier helpers ─────────────────────────────────────────────────────────────

/**
 * Return numeric rank for a tier string. Unknown / undefined → -1 so an
 * unrecognised tier never silently filters everything out.
 *
 * The Anthropic keychain stores rateLimitTier strings like
 * `default_claude_max_20x` — we map those onto our 5-value tier ladder
 * by substring matching the same way `derivePlanLabel` does in
 * src/subscriptions.ts. Order matters: check `enterprise` and `team`
 * before `max`/`pro` so a future "enterprise_max_X" can't be misranked.
 */
export function tierRank(tier: string | undefined | null): number {
  if (!tier) return -1;
  const lower = tier.toLowerCase();
  if (lower in TIER_RANK) return TIER_RANK[lower as ProjectPinTier];
  // Substring normalisation — handles keychain strings like
  // `default_claude_max_20x`, `default_claude_pro_5x`, etc.
  if (lower.includes('enterprise')) return TIER_RANK.enterprise;
  if (lower.includes('team'))       return TIER_RANK.team;
  if (lower.includes('max'))        return TIER_RANK.max;
  if (lower.includes('pro'))        return TIER_RANK.pro;
  if (lower.includes('free'))       return TIER_RANK.free;
  return -1;
}

/**
 * Decide whether a candidate's tier exceeds the pin's maxTier cap.
 *
 * Used by recommendRoute to filter candidates AFTER the rest of the
 * scoring pass. Candidates with an unknown tier (rank = -1) are NOT
 * filtered out — better to surface them and let the user pick than to
 * silently disappear an account because its tier label is non-standard.
 */
export function exceedsMaxTier(
  candidateTier: string | undefined | null,
  maxTier: ProjectPinTier | undefined,
): boolean {
  if (!maxTier) return false;
  const candidateRank = tierRank(candidateTier);
  if (candidateRank < 0) return false; // unknown — let it through
  return candidateRank > TIER_RANK[maxTier];
}

// ── Pin writer (used by `sweech pin set`) ────────────────────────────────────

/**
 * Write a `.sweech.json` to the given directory. Used by
 * `sweech pin set`. Returns the absolute path of the written file.
 *
 * Atomicity: the JSON is small (a few keys); we use writeFileSync
 * directly because `.sweech.json` is a project-level file the user
 * edits in their IDE, not a hot-path config. The CLI writer is just
 * a convenience.
 */
export function writeProjectPin(dir: string, pin: ProjectPin): string {
  const resolved = path.resolve(dir);
  const target = path.join(resolved, PIN_FILENAME);
  // Strip undefined values for a clean file.
  const clean: ProjectPin = {};
  if (pin.profile !== undefined) clean.profile = pin.profile;
  if (pin.cliType !== undefined) clean.cliType = pin.cliType;
  if (pin.maxTier !== undefined) clean.maxTier = pin.maxTier;
  if (pin.model !== undefined) clean.model = pin.model;
  if (pin.budget !== undefined) clean.budget = pin.budget;
  fs.writeFileSync(target, JSON.stringify(clean, null, 2) + '\n', 'utf-8');
  return target;
}

/**
 * Remove `./.sweech.json` from the given directory. Returns true on
 * delete, false when the file did not exist.
 */
export function removeProjectPin(dir: string): boolean {
  const target = path.join(path.resolve(dir), PIN_FILENAME);
  try {
    fs.unlinkSync(target);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') return false;
    throw err;
  }
}

/** Filename constant exported for tests and the `sweech pin` command. */
export { PIN_FILENAME };
