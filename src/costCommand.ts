/**
 * Pure builders for `sweech cost`.
 *
 * The CLI action handler in cli.ts is intentionally thin: gather
 * profile + cost data, then feed it through these builders. All
 * shape + math + filtering lives here so the JSON contract and
 * --budget filter can be unit-tested without spawning the CLI.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager } from './config';
import type { ProfileConfig } from './config';
import { getProvider, PROVIDERS, effectiveProvider } from './providers';
import { enumerateAccounts, recommendRoute, type RouteCandidate } from './accountSelector';
import { readAuditLog } from './auditLog';
import { estimateCostUsd, getModelPricing, type ModelPricing } from './costs';

// ── Public types ─────────────────────────────────────────────────────

export interface CostTableRow {
  profile: string;
  cliType: string;
  provider: string;
  model: string;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cacheReadUsdPerMillion: number | null;
  cacheWriteUsdPerMillion: number | null;
  estCostPerCallUsd: number | null;
  spent7dUsd: number;
  lastUseTs: number | null;
}

export interface CostTableOptions {
  /** USD ceiling — only include rows whose est cost fits. Default: no filter. */
  budgetUsd?: number;
  /** Restrict to a single profile. */
  profile?: string;
  /** Estimated input tokens for the projection. Default 5000. */
  estInputTokens?: number;
  /** Estimated output tokens for the projection. Default 1500. */
  estOutputTokens?: number;
  /** Restrict to one CLI type (claude/codex/kimi). */
  cliType?: string;
}

export interface CostTable {
  /** Stable JSON contract version for downstream parsers. */
  schemaVersion: 'sweech.cost-table.v1';
  /** Producer tag — always `'sweech'` so consumers can disambiguate. */
  producer: 'sweech';
  rows: CostTableRow[];
  estInputTokens: number;
  estOutputTokens: number;
  budgetUsd: number | null;
  generatedAt: string;
}

export interface ProfileSpend {
  profile: string;
  spent_7d_usd: number;
  last_use_ts: number | null;
}

// ── 7-day spend computation ──────────────────────────────────────────

const AUDIT_FILE = path.join(os.homedir(), '.sweech', 'audit.jsonl');
const LAUNCHES_LOG = path.join(os.homedir(), '.sweech', 'launches.log');
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
/** Estimated tokens-per-launch when a real `token_usage` event is absent. */
const ESTIMATED_INPUT_PER_LAUNCH = 5_000;
const ESTIMATED_OUTPUT_PER_LAUNCH = 1_500;

/**
 * Read the audit log + launches.log and return per-profile USD spent
 * in the last 7d.
 *
 * Source preference (richest signal wins):
 *   1. `token_usage` events in audit.jsonl with explicit input/output
 *      token counts + model id — these are exact spend records, used
 *      when a caller pushes accurate token telemetry
 *   2. `launches.log` entries (written by `logLaunch` on every CLI/TUI
 *      launch) — fall back to estimating spend per launch using a
 *      default token budget × the profile's default model price. Codex
 *      adversarial review caught that without this, `sweech cost` 7d
 *      column always reported $0 because no caller emits `token_usage`.
 *
 * Profiles with both signals get the SUM (`token_usage` is exact for
 * the calls it records; launches without `token_usage` get estimated).
 * If precision matters, callers should emit `token_usage` events.
 *
 * Returns one row per profile in the supplied `profiles` list.
 * Profiles with zero activity get `spent_7d_usd: 0` and
 * `last_use_ts: null`.
 *
 * `profiles` may include an optional `defaultModel` for each entry —
 * required for the launches.log estimate to produce a non-zero result.
 * The 22 fields needed to compute exact spend aren't in launches.log,
 * so we use the same 5000/1500 tokens default as `routeWithinBudget`.
 */
export function computeSpend7d(
  profiles: Array<{ commandName: string; defaultModel?: string }>,
  now: number = Date.now(),
  auditPath: string = AUDIT_FILE,
  launchesPath: string = LAUNCHES_LOG,
): ProfileSpend[] {
  const cutoff = now - WINDOW_7D_MS;
  const spendByProfile = new Map<string, { spent: number; last: number; counted: Set<string> }>();
  const modelByProfile = new Map<string, string>();
  for (const p of profiles) {
    if (p.defaultModel) modelByProfile.set(p.commandName, p.defaultModel);
  }

  // ── 1. Exact spend from audit.jsonl token_usage events ────────────
  let entries: ReturnType<typeof readAuditLog> = [];
  try {
    if (fs.existsSync(auditPath)) {
      entries = readAuditLog({ since: new Date(cutoff).toISOString() });
    }
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const ts = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const account = entry.account;
    if (!account) continue;

    if (entry.action !== 'token_usage') continue;

    const details = entry.details ?? {};
    const model = typeof details.model === 'string' ? details.model : '';
    const inTok = typeof details.inputTokens === 'number' ? details.inputTokens : 0;
    const outTok = typeof details.outputTokens === 'number' ? details.outputTokens : 0;
    const cachedTok = typeof details.cachedInputTokens === 'number' ? details.cachedInputTokens : 0;
    let usd = 0;
    if (model && (inTok > 0 || outTok > 0)) {
      usd = estimateCostUsd(model, inTok, outTok, cachedTok);
    } else if (typeof details.costUsd === 'number' && Number.isFinite(details.costUsd) && details.costUsd >= 0) {
      usd = details.costUsd;
    } else {
      continue;
    }

    const slot = spendByProfile.get(account) ?? { spent: 0, last: 0, counted: new Set<string>() };
    slot.spent += usd;
    if (ts > slot.last) slot.last = ts;
    // Mark this timestamp so a matching launches.log entry (best-effort
    // dedup — minute-rounded; launches.log writes seconds-precision so
    // an exact match is unlikely but minute bucketing catches the case
    // where token_usage + launch are emitted from the same launch).
    slot.counted.add(`${Math.floor(ts / 60_000)}`);
    spendByProfile.set(account, slot);
  }

  // ── 2. Estimated spend from launches.log ──────────────────────────
  if (fs.existsSync(launchesPath)) {
    try {
      const content = fs.readFileSync(launchesPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let event: { ts?: string; profile?: string } & Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const tsStr = typeof event.ts === 'string' ? event.ts : '';
        const profile = typeof event.profile === 'string' ? event.profile : '';
        if (!tsStr || !profile) continue;
        const ts = new Date(tsStr).getTime();
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const model = modelByProfile.get(profile);
        if (!model) continue; // can't estimate without a model
        const slot = spendByProfile.get(profile) ?? { spent: 0, last: 0, counted: new Set<string>() };
        const bucket = `${Math.floor(ts / 60_000)}`;
        if (slot.counted.has(bucket)) continue; // already counted by token_usage in the same minute
        const usd = estimateCostUsd(model, ESTIMATED_INPUT_PER_LAUNCH, ESTIMATED_OUTPUT_PER_LAUNCH);
        if (!Number.isFinite(usd) || usd <= 0) continue;
        slot.spent += usd;
        if (ts > slot.last) slot.last = ts;
        slot.counted.add(bucket);
        spendByProfile.set(profile, slot);
      }
    } catch {
      // best-effort; bad log file never blocks the cost table
    }
  }

  const out: ProfileSpend[] = [];
  for (const p of profiles) {
    const slot = spendByProfile.get(p.commandName);
    out.push({
      profile: p.commandName,
      spent_7d_usd: slot?.spent ?? 0,
      last_use_ts: slot?.last && slot.last > 0 ? slot.last : null,
    });
  }
  return out;
}

// ── Row builders ─────────────────────────────────────────────────────

/**
 * Build a single CostTableRow from a route candidate. Pure — the
 * caller assembles the candidates list (via recommendRoute) and the
 * spend map (via computeSpend7d) and threads them through.
 */
export function buildRowFromCandidate(
  candidate: RouteCandidate,
  spend: Map<string, ProfileSpend>,
  estInputTokens: number,
  estOutputTokens: number,
): CostTableRow {
  const model = candidate.route.model ?? '';
  const pricing = model ? getModelPricing(model) : null;
  const cost = model ? estimateCostUsd(model, estInputTokens, estOutputTokens) : 0;
  const spendRow = spend.get(candidate.account.commandName);

  return {
    profile: candidate.account.commandName,
    cliType: candidate.route.cliType,
    provider: candidate.route.provider,
    model,
    inputUsdPerMillion: pricing?.input_usd_per_million ?? null,
    outputUsdPerMillion: pricing?.output_usd_per_million ?? null,
    cacheReadUsdPerMillion: pricing?.cache_read_usd_per_million ?? null,
    cacheWriteUsdPerMillion: pricing?.cache_write_usd_per_million ?? null,
    estCostPerCallUsd: pricing ? cost : null,
    spent7dUsd: spendRow?.spent_7d_usd ?? 0,
    lastUseTs: spendRow?.last_use_ts ?? null,
  };
}

/**
 * Apply the `--budget` and `--profile` filters in one pass. Pure —
 * the row list comes from `buildRowFromCandidate`.
 */
export function applyFilters(rows: CostTableRow[], opts: CostTableOptions): CostTableRow[] {
  let filtered = [...rows];
  if (opts.cliType) {
    filtered = filtered.filter(r => r.cliType === opts.cliType);
  }
  if (opts.profile) {
    filtered = filtered.filter(r => r.profile === opts.profile);
  }
  if (typeof opts.budgetUsd === 'number' && Number.isFinite(opts.budgetUsd)) {
    filtered = filtered.filter(r => r.estCostPerCallUsd !== null && r.estCostPerCallUsd <= opts.budgetUsd!);
  }
  return filtered;
}

/**
 * Assemble the full CostTable: enumerate accounts, score them, build
 * rows, apply filters. Returns a stable JSON shape — keys appear in
 * `--json` output and downstream scripts will pin to them.
 */
export async function buildCostTable(opts: CostTableOptions = {}): Promise<CostTable> {
  const estInputTokens = opts.estInputTokens ?? 5_000;
  const estOutputTokens = opts.estOutputTokens ?? 1_500;

  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const accounts = enumerateAccounts(profiles);

  // Use the route recommender as the candidate source so the rows in
  // `sweech cost` correspond 1:1 with what `sweech auto` would see.
  const route = await recommendRoute({}, profiles);
  const byCommand = new Map(route.candidates.map(c => [c.account.commandName, c]));

  // Build a spend map keyed by commandName. Pass defaultModel so the
  // launches.log ingestion path can project estimated spend per launch
  // — without that, the 7d column shows $0 for every profile until a
  // caller starts emitting `token_usage` audit events.
  const spendProfiles = accounts.map(a => {
    const profile = profiles.find(p => p.commandName === a.commandName);
    const providerKey = profile?.provider
      ?? effectiveProvider(profile?.provider, profile?.baseUrl)
      ?? (a.cliType === 'codex' ? 'openai' : 'anthropic');
    const provider = getProvider(providerKey);
    const defaultModel = profile?.model ?? provider?.defaultModel ?? '';
    return { commandName: a.commandName, defaultModel };
  });
  const spend = new Map<string, ProfileSpend>();
  for (const row of computeSpend7d(spendProfiles)) {
    spend.set(row.profile, row);
  }

  const rows: CostTableRow[] = [];
  for (const account of accounts) {
    const candidate = byCommand.get(account.commandName);
    if (candidate) {
      rows.push(buildRowFromCandidate(candidate, spend, estInputTokens, estOutputTokens));
      continue;
    }
    // Fallback: account exists but recommendRoute didn't surface it
    // (e.g. its config dir is missing). Synthesise a minimal row so
    // the user still sees the profile in the table.
    const profile = profiles.find(p => p.commandName === account.commandName);
    const providerKey = profile?.provider
      ?? effectiveProvider(profile?.provider, profile?.baseUrl)
      ?? (account.cliType === 'codex' ? 'openai' : 'anthropic');
    const provider = getProvider(providerKey);
    const model = profile?.model ?? provider?.defaultModel ?? '';
    const pricing = model ? getModelPricing(model) : null;
    const cost = model ? estimateCostUsd(model, estInputTokens, estOutputTokens) : 0;
    const spendRow = spend.get(account.commandName);
    rows.push({
      profile: account.commandName,
      cliType: account.cliType,
      provider: providerKey,
      model,
      inputUsdPerMillion: pricing?.input_usd_per_million ?? null,
      outputUsdPerMillion: pricing?.output_usd_per_million ?? null,
      cacheReadUsdPerMillion: pricing?.cache_read_usd_per_million ?? null,
      cacheWriteUsdPerMillion: pricing?.cache_write_usd_per_million ?? null,
      estCostPerCallUsd: pricing ? cost : null,
      spent7dUsd: spendRow?.spent_7d_usd ?? 0,
      lastUseTs: spendRow?.last_use_ts ?? null,
    });
  }

  const filtered = applyFilters(rows, opts);
  return {
    schemaVersion: 'sweech.cost-table.v1',
    producer: 'sweech',
    rows: filtered,
    estInputTokens,
    estOutputTokens,
    budgetUsd: opts.budgetUsd ?? null,
    generatedAt: new Date().toISOString(),
  };
}

// ── Detail mode (--profile <name>) ──────────────────────────────────

export interface ProfileCostDetail {
  /** Stable JSON contract version for downstream parsers. */
  schemaVersion: 'sweech.cost-detail.v1';
  /** Producer tag — always `'sweech'` so consumers can disambiguate. */
  producer: 'sweech';
  profile: string;
  cliType: string;
  provider: string;
  defaultModel: string;
  spent7dUsd: number;
  lastUseTs: number | null;
  models: Array<{
    model: string;
    inputUsdPerMillion: number | null;
    outputUsdPerMillion: number | null;
    cacheReadUsdPerMillion: number | null;
    cacheWriteUsdPerMillion: number | null;
    estCostPerCallUsd: number | null;
    note?: string;
  }>;
}

/**
 * Detail view for a single profile — shows every model the profile's
 * provider can serve, with cost projection. Used by `sweech cost
 * --profile <name>` to answer "what does it cost to switch this
 * profile to a cheaper model?".
 */
export function buildProfileDetail(
  commandName: string,
  estInputTokens: number = 5_000,
  estOutputTokens: number = 1_500,
  profiles?: ProfileConfig[],
): ProfileCostDetail | null {
  const resolved = profiles ?? new ConfigManager().getProfiles();
  const accounts = enumerateAccounts(resolved);
  const account = accounts.find(a => a.commandName === commandName);
  if (!account) return null;

  const profile = resolved.find(p => p.commandName === commandName);
  const providerKey = profile?.provider
    ?? effectiveProvider(profile?.provider, profile?.baseUrl)
    ?? (account.cliType === 'codex' ? 'openai' : 'anthropic');
  const provider = getProvider(providerKey) ?? null;
  const defaultModel = profile?.model ?? provider?.defaultModel ?? '';

  const spendRows = computeSpend7d([{ commandName, defaultModel }]);
  const spend = spendRows[0] ?? { profile: commandName, spent_7d_usd: 0, last_use_ts: null };

  // Use the provider's catalog when available, else just project for
  // the default model so the detail view always has at least one row.
  const candidateModels: Array<{ id: string; note?: string }> = provider?.availableModels
    ? provider.availableModels.map(m => ({ id: m.id, note: m.note }))
    : defaultModel ? [{ id: defaultModel }] : [];

  return {
    schemaVersion: 'sweech.cost-detail.v1',
    producer: 'sweech',
    profile: commandName,
    cliType: account.cliType,
    provider: providerKey,
    defaultModel,
    spent7dUsd: spend.spent_7d_usd,
    lastUseTs: spend.last_use_ts,
    models: candidateModels.map(m => {
      const pricing = getModelPricing(m.id);
      const cost = estimateCostUsd(m.id, estInputTokens, estOutputTokens);
      return {
        model: m.id,
        inputUsdPerMillion: pricing?.input_usd_per_million ?? null,
        outputUsdPerMillion: pricing?.output_usd_per_million ?? null,
        cacheReadUsdPerMillion: pricing?.cache_read_usd_per_million ?? null,
        cacheWriteUsdPerMillion: pricing?.cache_write_usd_per_million ?? null,
        estCostPerCallUsd: pricing ? cost : null,
        ...(m.note ? { note: m.note } : {}),
      };
    }),
  };
}

// ── Text formatting (used by the CLI action handler) ────────────────

/**
 * Format USD per million tokens for compact table display.
 */
export function formatPerMillion(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  if (value < 0.10) return `$${value.toFixed(3)}`;
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Format the spent 7d total. Shows 4 decimals when small to surface
 * sub-dollar spend.
 */
export function formatSpend(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '$0.0000';
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
