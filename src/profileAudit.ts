/**
 * Profile audit engine for `sweech profile audit` (T-LU-008).
 *
 * Scans every managed profile and emits findings for:
 *   - dormant: no thread / session / history activity within N days
 *   - cross_bleed: profile name implies one provider but auth points elsewhere
 *     (e.g. profile-name 'kimi' with an Anthropic sk-ant-... key, or a
 *     bearer token whose JWT `iss` claim doesn't match the configured
 *     provider)
 *   - orphan_credentials: settings.env has keys for a provider that
 *     doesn't match `profile.provider`
 *   - missing_settings: profile directory or settings.json is missing
 *   - expired_token: stored OAuth refresh token is past `expiresAt` and
 *     can no longer be silently refreshed
 *
 * The engine is intentionally I/O light — it only reads from disk and
 * never writes. The CLI command in src/cli.ts maps findings with
 * `suggestion === 'prune'` to an interactive removal flow.
 *
 * Per CLAUDE.md: audit must NEVER auto-prune. Every destructive action is
 * gated behind explicit user confirmation in the CLI layer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager, ProfileConfig } from './config';
import { readSettingsEnv } from './autoCommand';

// ── Types ────────────────────────────────────────────────────────────────────

export type AuditSeverity = 'info' | 'warn' | 'critical';

export type AuditKind =
  | 'dormant'
  | 'cross_bleed'
  | 'orphan_credentials'
  | 'missing_settings'
  | 'expired_token';

export type AuditSuggestion = 'prune' | 'rename' | 'rotate' | null;

export interface AuditFinding {
  /** Profile commandName. */
  profile: string;
  /** Profile CLI type (claude / codex / kimi). */
  cliType: string;
  /** Configured provider key. */
  provider: string;
  severity: AuditSeverity;
  kind: AuditKind;
  /** Human-readable explanation, safe to render in the terminal. */
  detail: string;
  /** Raw data backing the finding (mtimes, expected vs actual provider, etc.). */
  evidence: Record<string, unknown>;
  /** Suggested user action. Only `dormant` + `cross_bleed` propose `prune`. */
  suggestion?: AuditSuggestion;
}

export interface AuditReport {
  /** Number of profiles inspected. */
  scanned: number;
  /** Dormancy threshold (days) used for this run. */
  dormancyDays: number;
  /** When the audit ran. ISO-8601. */
  generatedAt: string;
  findings: AuditFinding[];
  summary: {
    dormant: number;
    cross_bleed: number;
    orphan_credentials: number;
    missing_settings: number;
    expired_token: number;
    /** Number of findings whose severity is `warn` or `critical`. */
    total_issues: number;
    /** Number of findings whose `suggestion === 'prune'`. */
    prunable: number;
  };
}

export interface AuditOptions {
  /** Override config manager (used by tests). */
  config?: ConfigManager;
  /** Days of inactivity before a profile is considered dormant. Default 30. */
  dormancyDays?: number;
  /** Override `Date.now()` (used by tests). */
  now?: () => number;
}

// ── Activity probe ───────────────────────────────────────────────────────────

/**
 * Candidate activity paths inside a profile dir. We accept either claude-
 * style (`projects/*\/sessions/*`, `sessions/`, `todos/`, `history.jsonl`)
 * or codex-style (`history.jsonl`, `sessions/`, `state_*.sqlite`,
 * `logs_*.sqlite`, `archived_sessions/`) or kimi-style (`user-history/`,
 * `sessions/`). The newest mtime across any of these wins.
 *
 * Per CLAUDE.md global rules: "tooling we build that ingests AI session
 * data MUST cover BOTH Claude Code AND Codex". This list keeps both in
 * scope; symlinked dirs (sharedWith profiles) follow the link so dormant
 * detection still sees real activity from the master profile.
 */
export const ACTIVITY_PATHS_BY_CLI: Record<string, string[]> = {
  claude: ['projects', 'sessions', 'todos', 'history.jsonl', 'plans', 'tasks'],
  codex: ['history.jsonl', 'sessions', 'archived_sessions'],
  kimi: ['sessions', 'user-history', 'logs'],
};

/**
 * Glob-ish patterns matched against the basenames in the profile dir.
 * Captures rotating per-account databases like `state_5.sqlite`,
 * `logs_1.sqlite`, `state_2026_05_17.sqlite`.
 */
export const ACTIVITY_FILE_PATTERNS: RegExp[] = [
  /^state_.*\.sqlite$/,
  /^logs_.*\.sqlite$/,
];

interface ActivityProbe {
  /** Most recent mtime found across any activity path, in ms since epoch. */
  lastActivityMs: number | null;
  /** Specific paths inspected, with their mtimes. Used in evidence. */
  paths: Array<{ path: string; mtimeMs: number | null }>;
}

/**
 * Recursively find the newest *file* mtime under `dir`, following symlinks.
 * Returns null on any error or when the tree contains only empty dirs.
 *
 * Directory mtimes are ignored because they bubble up on every child
 * write — using them would defeat dormancy detection. We only care about
 * actual file timestamps (sessions, history, sqlite databases).
 *
 * Bounded depth — we don't want to walk into massive `projects/*` trees
 * indefinitely on disks full of years of sessions. `maxDepth = 4` covers
 * `projects/<repo>/sessions/<id>/foo.jsonl`.
 */
function newestMtimeRecursive(dir: string, maxDepth = 4): number | null {
  let best: number | null = null;
  const visit = (p: string, depth: number): void => {
    if (depth > maxDepth) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p); // statSync follows symlinks
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const child of entries) {
        if (child.startsWith('.')) continue;
        visit(path.join(p, child), depth + 1);
      }
    } else if (stat.isFile()) {
      if (stat.mtimeMs && (best === null || stat.mtimeMs > best)) {
        best = stat.mtimeMs;
      }
    }
  };
  visit(dir, 0);
  return best;
}

/**
 * Probe a profile directory for the newest activity timestamp.
 *
 * Exposed as part of the public surface so tests can target the activity
 * detection without spinning up a full ConfigManager.
 */
export function probeProfileActivity(profileDir: string, cliType: string): ActivityProbe {
  const probe: ActivityProbe = { lastActivityMs: null, paths: [] };
  if (!fs.existsSync(profileDir)) return probe;

  const candidates = ACTIVITY_PATHS_BY_CLI[cliType] ?? ACTIVITY_PATHS_BY_CLI.claude;

  for (const rel of candidates) {
    const full = path.join(profileDir, rel);
    let mt: number | null = null;
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        // Directories: only the newest file mtime under them counts.
        // The dir's own mtime bubbles up on every child write and is
        // useless as a dormancy signal.
        mt = newestMtimeRecursive(full);
      } else if (stat.isFile()) {
        mt = stat.mtimeMs ?? null;
      }
    } catch {
      mt = null;
    }
    probe.paths.push({ path: rel, mtimeMs: mt });
    if (mt !== null && (probe.lastActivityMs === null || mt > probe.lastActivityMs)) {
      probe.lastActivityMs = mt;
    }
  }

  // Sweep top-level for rotating sqlite databases (state_*.sqlite, etc.)
  try {
    for (const entry of fs.readdirSync(profileDir)) {
      if (!ACTIVITY_FILE_PATTERNS.some(rx => rx.test(entry))) continue;
      const full = path.join(profileDir, entry);
      try {
        const stat = fs.statSync(full);
        probe.paths.push({ path: entry, mtimeMs: stat.mtimeMs ?? null });
        if (stat.mtimeMs && (probe.lastActivityMs === null || stat.mtimeMs > probe.lastActivityMs)) {
          probe.lastActivityMs = stat.mtimeMs;
        }
      } catch {
        // skip unreadable entry
      }
    }
  } catch {
    // profileDir not enumerable — fine
  }

  return probe;
}

// ── Provider inference (key + name heuristics) ──────────────────────────────

/**
 * Mapping from common API-key prefix to the upstream vendor key. Order
 * matters — `sk-ant-` must be checked before bare `sk-` because the
 * Anthropic prefix is a superset.
 *
 * `null` means "we can't infer a single vendor from this prefix" (e.g.
 * `sk-` alone is shared by OpenAI, DeepSeek, OpenRouter, GLM, ...).
 */
export const KEY_PREFIX_VENDOR: Array<{ prefix: string; vendor: string | null }> = [
  { prefix: 'sk-ant-api03-', vendor: 'anthropic' },
  { prefix: 'sk-ant-', vendor: 'anthropic' },
  { prefix: 'bearer_sk-ant', vendor: 'anthropic' },
  { prefix: 'sk-or-v1-', vendor: 'openrouter' },
  { prefix: 'sk-or-', vendor: 'openrouter' },
  { prefix: 'sk-proj-', vendor: 'openai' },
  { prefix: 'sk-oat-', vendor: 'openai' },
  { prefix: 'sk-oauth-', vendor: 'openai' },
  { prefix: 'sk-sp-', vendor: 'dashscope' },
  { prefix: 'gsk_', vendor: 'groq' },
  { prefix: 'AIzaSy', vendor: 'gemini' },
  { prefix: 'nvapi-', vendor: 'nvidia' },
  // Moonshot (Kimi) keys look like `ms-` or `mse_` per Moonshot docs.
  { prefix: 'ms-', vendor: 'kimi' },
  { prefix: 'mse_', vendor: 'kimi' },
  // GLM (z.ai) keys are `<uuid>.<uuid>` shape, no fixed prefix. Skip.
];

/**
 * Profile commandName tokens that imply a vendor identity. Used to flag
 * cross-bleed where the name says `kimi-...` but the key/issuer says
 * Anthropic.
 *
 * The mapping is intentionally narrow — only confident matches. False
 * positives turn into noise the user has to suppress.
 */
export const NAME_VENDOR_HINTS: Array<{ pattern: RegExp; vendor: string }> = [
  // Only flag a name as belonging to a vendor when the name contains a
  // recognisable vendor token. The bare CLI-family prefixes `claude-` /
  // `codex-` are intentionally NOT included — most sweech profiles in the
  // wild use them as namespace markers (e.g. `claude-ali` for Alibaba via
  // the Claude CLI). Without a vendor token, we have no opinion.
  //
  // Cross-bleed against `auth.token` is still detected via the
  // configured-provider mismatch fallback in `auditProfiles`.
  { pattern: /(^|-)moonshot(-|$)/i, vendor: 'kimi' },
  { pattern: /(^|-)kimi(-|$)/i, vendor: 'kimi' },
  { pattern: /(^|-)glm(-|$)/i, vendor: 'glm' },
  { pattern: /(^|-)minimax(-|$)/i, vendor: 'minimax' },
  { pattern: /(^|-)deepseek(-|$)/i, vendor: 'deepseek' },
  { pattern: /(^|-)dashscope(-|$)/i, vendor: 'dashscope' },
  { pattern: /(^|-)alibaba(-|$)/i, vendor: 'dashscope' },
  { pattern: /(^|-)qwen(-|$)/i, vendor: 'dashscope' },
  { pattern: /(^|-)openrouter(-|$)/i, vendor: 'openrouter' },
  { pattern: /(^|-)groq(-|$)/i, vendor: 'groq' },
  { pattern: /(^|-)gemini(-|$)/i, vendor: 'gemini' },
  { pattern: /(^|-)ollama(-|$)/i, vendor: 'ollama' },
  { pattern: /(^|-)anthropic(-|$)/i, vendor: 'anthropic' },
  { pattern: /(^|-)openai(-|$)/i, vendor: 'openai' },
];

/**
 * Normalise a configured provider key to the same vendor namespace used
 * by `KEY_PREFIX_VENDOR`. Without this, `kimi-coding` wouldn't match
 * `kimi`, and `qwen` wouldn't match `dashscope`.
 */
export function normaliseProviderToVendor(provider: string): string {
  const p = provider.toLowerCase();
  if (p === 'kimi' || p === 'kimi-coding') return 'kimi';
  if (p === 'dashscope' || p === 'qwen' || p === 'dashscope-openai' || p === 'qwen-openai') return 'dashscope';
  if (p === 'deepseek' || p === 'deepseek-openai') return 'deepseek';
  if (p === 'glm' || p === 'glm-openai') return 'glm';
  if (p === 'openrouter' || p === 'openrouter-openai') return 'openrouter';
  if (p === 'minimax' || p === 'minimax-openai') return 'minimax';
  return p;
}

/**
 * Map a profile commandName to the vendor it implies via NAME_VENDOR_HINTS.
 * Returns `null` if no hint matches (treat as "no opinion").
 */
export function inferVendorFromName(commandName: string): string | null {
  for (const hint of NAME_VENDOR_HINTS) {
    if (hint.pattern.test(commandName)) return hint.vendor;
  }
  return null;
}

/**
 * Map an API key value to the vendor it most likely belongs to. Returns
 * `null` when no prefix matches (typical for opaque GLM keys).
 */
export function inferVendorFromKey(key: string): string | null {
  if (!key) return null;
  for (const { prefix, vendor } of KEY_PREFIX_VENDOR) {
    if (key.startsWith(prefix)) return vendor;
  }
  return null;
}

/**
 * Best-effort base64url decode + JSON parse of a bearer token's payload.
 * Used to read the `iss` claim on Anthropic / Codex OAuth tokens without
 * any signature verification (we're only inferring identity, not trusting it).
 *
 * Returns null on any parse failure.
 */
export function decodeBearerIssuer(rawToken: string): string | null {
  // Accept both `bearer_<jwt>` and `sk-oauth-<jwt>` and plain `<jwt>`.
  let token = rawToken.trim();
  if (token.startsWith('bearer_')) token = token.slice('bearer_'.length);
  if (token.startsWith('sk-oauth-')) token = token.slice('sk-oauth-'.length);

  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded, 'base64url').toString('utf-8');
    const payload = JSON.parse(json) as Record<string, unknown>;
    const iss = payload.iss;
    if (typeof iss !== 'string' || iss.length === 0) return null;
    return iss;
  } catch {
    return null;
  }
}

/**
 * Map an OAuth `iss` claim to the vendor key. Conservative — only known
 * hosts are mapped; unknown issuers return null so we don't flag
 * legitimate-but-unrecognised tokens as cross-bleed.
 */
export function vendorFromIssuer(iss: string): string | null {
  const lower = iss.toLowerCase();
  if (lower.includes('anthropic.com') || lower.includes('claude.ai')) return 'anthropic';
  if (lower.includes('openai.com') || lower.includes('platform.openai')) return 'openai';
  if (lower.includes('moonshot.ai') || lower.includes('kimi.com')) return 'kimi';
  if (lower.includes('z.ai')) return 'glm';
  if (lower.includes('minimax.io')) return 'minimax';
  if (lower.includes('dashscope') || lower.includes('aliyuncs.com')) return 'dashscope';
  if (lower.includes('openrouter.ai')) return 'openrouter';
  return null;
}

// ── Settings.env scanning ───────────────────────────────────────────────────

/**
 * Snapshot of what we extracted from a profile's settings.json env block,
 * normalised across Claude / Codex / Kimi naming.
 */
export interface SettingsAuthSnapshot {
  /** Raw token / api key value (may be empty). */
  authToken: string;
  /** Where the value came from — drives the cross-bleed message. */
  authSource: 'ANTHROPIC_AUTH_TOKEN' | 'OPENAI_API_KEY' | 'KIMI_API_KEY' | null;
  /** Any provider-specific env vars present (e.g. KIMI_API_KEY on a codex profile). */
  extraProviderEnvs: string[];
}

const PROVIDER_ENV_KEYS: Array<{ env: string; vendor: string }> = [
  { env: 'ANTHROPIC_AUTH_TOKEN', vendor: 'anthropic' },
  { env: 'ANTHROPIC_API_KEY', vendor: 'anthropic' },
  { env: 'OPENAI_API_KEY', vendor: 'openai' },
  { env: 'KIMI_API_KEY', vendor: 'kimi' },
  { env: 'MOONSHOT_API_KEY', vendor: 'kimi' },
  { env: 'GLM_API_KEY', vendor: 'glm' },
  { env: 'DEEPSEEK_API_KEY', vendor: 'deepseek' },
  { env: 'DASHSCOPE_API_KEY', vendor: 'dashscope' },
  { env: 'OPENROUTER_API_KEY', vendor: 'openrouter' },
  { env: 'MINIMAX_API_KEY', vendor: 'minimax' },
  { env: 'GEMINI_API_KEY', vendor: 'gemini' },
  { env: 'GROQ_API_KEY', vendor: 'groq' },
  { env: 'NVIDIA_API_KEY', vendor: 'nvidia' },
];

/**
 * Read settings.env into a structured snapshot. Pure: takes the raw env
 * dict, returns a normalised view.
 */
export function snapshotSettingsAuth(env: Record<string, string>): SettingsAuthSnapshot {
  let authToken = '';
  let authSource: SettingsAuthSnapshot['authSource'] = null;

  if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN.length > 0) {
    authToken = env.ANTHROPIC_AUTH_TOKEN;
    authSource = 'ANTHROPIC_AUTH_TOKEN';
  } else if (typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length > 0) {
    authToken = env.OPENAI_API_KEY;
    authSource = 'OPENAI_API_KEY';
  } else if (typeof env.KIMI_API_KEY === 'string' && env.KIMI_API_KEY.length > 0) {
    authToken = env.KIMI_API_KEY;
    authSource = 'KIMI_API_KEY';
  }

  const extras: string[] = [];
  for (const { env: key } of PROVIDER_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key].length > 0) extras.push(key);
  }

  return { authToken, authSource, extraProviderEnvs: extras };
}

// ── Cross-bleed + orphan detection ──────────────────────────────────────────

/**
 * The expected-vs-observed vendor for a profile. Used by both cross-bleed
 * and orphan-credentials.
 */
export interface VendorDecision {
  /** Vendor implied by the configured provider on the profile. */
  configuredVendor: string;
  /** Vendor implied by the profile's commandName (or null). */
  nameVendor: string | null;
  /** Vendor implied by the auth token (key prefix or JWT issuer). */
  authVendor: string | null;
  /** Provider env keys present in settings.json that don't belong here. */
  orphanProviderEnvs: string[];
}

/**
 * The CLI-native auth env: every claude profile (even one wrapping
 * dashscope) ships its token in ANTHROPIC_AUTH_TOKEN because the Claude
 * Code CLI only reads that variable. The codex CLI uses OPENAI_API_KEY,
 * Kimi CLI uses KIMI_API_KEY. These are NEVER orphans regardless of the
 * configured provider — they are the wrapper's auth pipe.
 */
const CLI_NATIVE_AUTH_ENVS: Record<string, string[]> = {
  claude: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY'],
  kimi: ['KIMI_API_KEY'],
};

export function decideVendor(
  profile: ProfileConfig,
  settingsEnv: Record<string, string>,
): VendorDecision {
  const configuredVendor = normaliseProviderToVendor(profile.provider);
  const nameVendor = inferVendorFromName(profile.commandName);
  const cliType = (profile.cliType || 'claude').toLowerCase();
  const nativeEnvs = new Set(CLI_NATIVE_AUTH_ENVS[cliType] ?? []);

  const snap = snapshotSettingsAuth(settingsEnv);
  let authVendor: string | null = null;
  if (snap.authToken) {
    authVendor = inferVendorFromKey(snap.authToken);
    if (!authVendor) {
      const iss = decodeBearerIssuer(snap.authToken);
      if (iss) authVendor = vendorFromIssuer(iss);
    }
  }

  // Orphan envs = provider-specific keys for a vendor that isn't the
  // configured one, AND isn't the CLI's natural auth env. Without the
  // CLI-native exclusion, every non-anthropic claude profile would
  // false-positive (sweech wraps every claude profile's auth in
  // ANTHROPIC_AUTH_TOKEN regardless of upstream).
  const orphanProviderEnvs: string[] = [];
  for (const { env, vendor } of PROVIDER_ENV_KEYS) {
    if (typeof settingsEnv[env] !== 'string' || settingsEnv[env].length === 0) continue;
    if (nativeEnvs.has(env)) continue;
    if (vendor !== configuredVendor) orphanProviderEnvs.push(env);
  }

  return { configuredVendor, nameVendor, authVendor, orphanProviderEnvs };
}

// ── Main audit entry point ──────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_DORMANCY_DAYS = 30;

/**
 * Run the full profile audit. Reads from disk only; never mutates.
 */
export async function auditProfiles(opts: AuditOptions = {}): Promise<AuditReport> {
  const config = opts.config ?? new ConfigManager();
  const dormancyDays = opts.dormancyDays && opts.dormancyDays > 0
    ? Math.floor(opts.dormancyDays)
    : DEFAULT_DORMANCY_DAYS;
  const nowMs = (opts.now ?? Date.now)();
  const dormancyThresholdMs = nowMs - dormancyDays * MS_PER_DAY;

  const profiles = config.getProfiles();
  const findings: AuditFinding[] = [];

  for (const profile of profiles) {
    const cliType = (profile.cliType || 'claude').toLowerCase();
    const profileDir = config.getProfileDir(profile.commandName);
    const provider = profile.provider;

    // ── missing_settings ────────────────────────────────────────────
    const dirExists = fs.existsSync(profileDir);
    const settingsPath = path.join(profileDir, 'settings.json');
    let settingsExists = false;
    let settingsEnv: Record<string, string> = {};
    if (dirExists) {
      try {
        settingsExists = fs.statSync(settingsPath).isFile();
      } catch {
        settingsExists = false;
      }
      settingsEnv = readSettingsEnv(profileDir);
    }
    if (!dirExists || !settingsExists) {
      findings.push({
        profile: profile.commandName,
        cliType,
        provider,
        severity: 'critical',
        kind: 'missing_settings',
        detail: !dirExists
          ? `Profile directory does not exist: ${profileDir}`
          : `Profile directory exists but settings.json is missing: ${settingsPath}`,
        evidence: { profileDir, dirExists, settingsExists },
        suggestion: null,
      });
      // If the profile dir is gone, skip the rest — nothing else to inspect.
      if (!dirExists) continue;
    }

    // ── dormant ─────────────────────────────────────────────────────
    const activity = probeProfileActivity(profileDir, cliType);
    if (activity.lastActivityMs === null) {
      findings.push({
        profile: profile.commandName,
        cliType,
        provider,
        severity: 'warn',
        kind: 'dormant',
        detail: `No threads, sessions, or history found in ${profileDir}. Profile appears unused.`,
        evidence: {
          profileDir,
          lastActivityMs: null,
          lastActivityIso: null,
          dormancyDays,
          probedPaths: activity.paths,
        },
        suggestion: 'prune',
      });
    } else if (activity.lastActivityMs < dormancyThresholdMs) {
      const daysIdle = Math.floor((nowMs - activity.lastActivityMs) / MS_PER_DAY);
      findings.push({
        profile: profile.commandName,
        cliType,
        provider,
        severity: 'warn',
        kind: 'dormant',
        detail: `No activity for ${daysIdle} days (threshold: ${dormancyDays}). Last seen: ${new Date(activity.lastActivityMs).toISOString()}.`,
        evidence: {
          profileDir,
          lastActivityMs: activity.lastActivityMs,
          lastActivityIso: new Date(activity.lastActivityMs).toISOString(),
          dormancyDays,
          daysIdle,
          probedPaths: activity.paths,
        },
        suggestion: 'prune',
      });
    }

    // ── cross_bleed + orphan_credentials ────────────────────────────
    const decision = decideVendor(profile, settingsEnv);

    // Cross-bleed: name says X but auth points at Y.
    if (decision.nameVendor && decision.authVendor && decision.nameVendor !== decision.authVendor) {
      findings.push({
        profile: profile.commandName,
        cliType,
        provider,
        severity: 'critical',
        kind: 'cross_bleed',
        detail: `Profile name implies '${decision.nameVendor}' but auth token belongs to '${decision.authVendor}'.`,
        evidence: {
          nameVendor: decision.nameVendor,
          authVendor: decision.authVendor,
          configuredVendor: decision.configuredVendor,
        },
        suggestion: 'prune',
      });
    } else if (decision.authVendor && decision.configuredVendor && decision.authVendor !== decision.configuredVendor) {
      // Configured provider says X but auth points at Y. Likely a key
      // copy-paste mistake. Suggest rotate, not prune.
      findings.push({
        profile: profile.commandName,
        cliType,
        provider,
        severity: 'critical',
        kind: 'cross_bleed',
        detail: `Configured provider is '${decision.configuredVendor}' but the stored auth token belongs to '${decision.authVendor}'.`,
        evidence: {
          authVendor: decision.authVendor,
          configuredVendor: decision.configuredVendor,
        },
        suggestion: 'rotate',
      });
    }

    // Orphan credentials: a sibling provider's env var is set on this profile.
    if (decision.orphanProviderEnvs.length > 0) {
      findings.push({
        profile: profile.commandName,
        cliType,
        provider,
        severity: 'warn',
        kind: 'orphan_credentials',
        detail: `settings.env contains credentials for other providers: ${decision.orphanProviderEnvs.join(', ')}.`,
        evidence: {
          orphanProviderEnvs: decision.orphanProviderEnvs,
          configuredVendor: decision.configuredVendor,
        },
        suggestion: 'rotate',
      });
    }

    // ── expired_token ───────────────────────────────────────────────
    if (profile.oauth?.expiresAt && typeof profile.oauth.expiresAt === 'number') {
      if (profile.oauth.expiresAt < nowMs) {
        const ageDays = Math.floor((nowMs - profile.oauth.expiresAt) / MS_PER_DAY);
        findings.push({
          profile: profile.commandName,
          cliType,
          provider,
          severity: ageDays > 30 ? 'critical' : 'warn',
          kind: 'expired_token',
          detail: `OAuth token expired ${ageDays} days ago. Refresh required.`,
          evidence: {
            expiresAt: profile.oauth.expiresAt,
            expiredAgeDays: ageDays,
          },
          suggestion: 'rotate',
        });
      }
    }
  }

  // Build summary
  const summary = {
    dormant: findings.filter(f => f.kind === 'dormant').length,
    cross_bleed: findings.filter(f => f.kind === 'cross_bleed').length,
    orphan_credentials: findings.filter(f => f.kind === 'orphan_credentials').length,
    missing_settings: findings.filter(f => f.kind === 'missing_settings').length,
    expired_token: findings.filter(f => f.kind === 'expired_token').length,
    total_issues: findings.filter(f => f.severity !== 'info').length,
    prunable: findings.filter(f => f.suggestion === 'prune').length,
  };

  return {
    scanned: profiles.length,
    dormancyDays,
    generatedAt: new Date(nowMs).toISOString(),
    findings,
    summary,
  };
}

// ── Convenience: prunable subset ────────────────────────────────────────────

/**
 * Pull the unique profile names whose worst-finding suggests `prune`.
 *
 * A profile may collect multiple findings (e.g. dormant + cross-bleed).
 * We return one entry per profile so the CLI prune flow doesn't prompt
 * twice for the same removal.
 */
export function prunableProfiles(report: AuditReport): Array<{
  profile: string;
  cliType: string;
  provider: string;
  reasons: AuditFinding[];
}> {
  const groups = new Map<string, { cliType: string; provider: string; reasons: AuditFinding[] }>();
  for (const f of report.findings) {
    if (f.suggestion !== 'prune') continue;
    const existing = groups.get(f.profile);
    if (existing) {
      existing.reasons.push(f);
    } else {
      groups.set(f.profile, { cliType: f.cliType, provider: f.provider, reasons: [f] });
    }
  }
  return Array.from(groups.entries()).map(([profile, g]) => ({
    profile,
    cliType: g.cliType,
    provider: g.provider,
    reasons: g.reasons,
  }));
}

