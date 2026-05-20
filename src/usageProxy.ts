import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { estimateCostUsd, getModelPricing } from './costs';
import { classifyPricingModel, type PricingModel } from './providers';

export const DEFAULT_SESSIONS_DB_PATH = path.join(os.homedir(), '.sweech', 'sessions.db');
export const DEFAULT_LAUNCHES_LOG_PATH = path.join(os.homedir(), '.sweech', 'launches.log');
export const DEFAULT_PROXY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const ESTIMATED_INPUT_TOKENS_PER_LAUNCH = 5_000;
export const ESTIMATED_OUTPUT_TOKENS_PER_LAUNCH = 1_500;

export type UsageProxyTier = 'tier2_tokens' | 'tier3_launches' | 'free' | 'none';

export interface UsageProxyProfile {
  workspace: string;
  provider?: string;
  baseUrl?: string;
  pricingModel?: PricingModel;
  isCustom?: boolean;
  authOptional?: boolean;
  defaultModel?: string;
}

export interface UsageProxyTokenRow {
  workspace: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  costUsd?: number | null;
  timestampMs?: number | null;
}

export interface UsageProxyLaunchRow {
  workspace: string;
  timestampMs: number;
}

export interface UsageProxyOptions {
  now?: number;
  windowMs?: number;
  estimatedInputTokensPerLaunch?: number;
  estimatedOutputTokensPerLaunch?: number;
}

export interface UsageProxyEstimate {
  workspace: string;
  provider: string | null;
  pricingModel: PricingModel;
  tier: UsageProxyTier;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  launchCount: number;
  costUsd: number;
  priced: boolean;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inWindow(timestampMs: number | null | undefined, now: number, windowMs: number): boolean {
  if (timestampMs === null || timestampMs === undefined) return true;
  return Number.isFinite(timestampMs) && timestampMs >= now - windowMs && timestampMs <= now;
}

export function estimateUsageFromTokens(
  profile: UsageProxyProfile,
  rows: UsageProxyTokenRow[],
  options: UsageProxyOptions = {},
): UsageProxyEstimate {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_PROXY_WINDOW_MS;
  const pricingModel = classifyPricingModel({
    name: profile.provider,
    baseUrl: profile.baseUrl,
    pricingModel: profile.pricingModel,
    isCustom: profile.isCustom,
    authOptional: profile.authOptional,
  });

  const estimate = emptyEstimate(profile, pricingModel);
  if (pricingModel === 'free') return { ...estimate, tier: 'free', priced: true };

  let explicitCostUsd = 0;
  const byModel = new Map<string, { input: number; output: number; cached: number }>();
  for (const row of rows) {
    if (row.workspace !== profile.workspace) continue;
    if (!inWindow(row.timestampMs, now, windowMs)) continue;

    const input = Math.max(0, Math.floor(finiteNumber(row.inputTokens) ?? 0));
    const output = Math.max(0, Math.floor(finiteNumber(row.outputTokens) ?? 0));
    const cached = Math.max(0, Math.floor(finiteNumber(row.cachedInputTokens) ?? 0));
    const costUsd = finiteNumber(row.costUsd);
    if (input === 0 && output === 0 && cached === 0 && costUsd !== null && costUsd >= 0) explicitCostUsd += costUsd;
    if (input === 0 && output === 0 && cached === 0) continue;
    if (!row.model) continue;
    const bucket = byModel.get(row.model) ?? { input: 0, output: 0, cached: 0 };
    bucket.input += input;
    bucket.output += output;
    bucket.cached += cached;
    byModel.set(row.model, bucket);
  }

  let estimatedCostUsd = 0;
  let priced = explicitCostUsd > 0;
  for (const [model, tokens] of byModel) {
    estimate.inputTokens += tokens.input;
    estimate.outputTokens += tokens.output;
    estimate.cachedInputTokens += Math.min(tokens.cached, tokens.input);
    if (!estimate.model) estimate.model = model;
    if (getModelPricing(model)) priced = true;
    estimatedCostUsd += estimateCostUsd(model, tokens.input, tokens.output, tokens.cached);
  }

  estimate.costUsd = explicitCostUsd + estimatedCostUsd;
  estimate.priced = priced;
  if (estimate.inputTokens > 0 || estimate.outputTokens > 0 || explicitCostUsd > 0) {
    estimate.tier = 'tier2_tokens';
  }
  return estimate;
}

export function estimateUsageFromLaunches(
  profile: UsageProxyProfile,
  rows: UsageProxyLaunchRow[],
  options: UsageProxyOptions = {},
): UsageProxyEstimate {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_PROXY_WINDOW_MS;
  const pricingModel = classifyPricingModel({
    name: profile.provider,
    baseUrl: profile.baseUrl,
    pricingModel: profile.pricingModel,
    isCustom: profile.isCustom,
    authOptional: profile.authOptional,
  });

  const estimate = emptyEstimate(profile, pricingModel);
  if (pricingModel === 'free') return { ...estimate, tier: 'free', priced: true };

  const launchCount = rows.filter(row =>
    row.workspace === profile.workspace && inWindow(row.timestampMs, now, windowMs)
  ).length;
  const model = profile.defaultModel ?? '';
  const input = Math.max(0, Math.floor(options.estimatedInputTokensPerLaunch ?? ESTIMATED_INPUT_TOKENS_PER_LAUNCH));
  const output = Math.max(0, Math.floor(options.estimatedOutputTokensPerLaunch ?? ESTIMATED_OUTPUT_TOKENS_PER_LAUNCH));

  estimate.launchCount = launchCount;
  estimate.model = model || null;
  estimate.inputTokens = launchCount * input;
  estimate.outputTokens = launchCount * output;
  estimate.priced = !!model && !!getModelPricing(model);
  estimate.costUsd = model ? launchCount * estimateCostUsd(model, input, output) : 0;
  estimate.tier = launchCount > 0 ? 'tier3_launches' : 'none';
  return estimate;
}

export function estimateUsageProxy(
  profile: UsageProxyProfile,
  tokenRows: UsageProxyTokenRow[],
  launchRows: UsageProxyLaunchRow[],
  options: UsageProxyOptions = {},
): UsageProxyEstimate {
  const tokenEstimate = estimateUsageFromTokens(profile, tokenRows, options);
  if (tokenEstimate.tier === 'free' || tokenEstimate.tier === 'tier2_tokens') return tokenEstimate;
  return estimateUsageFromLaunches(profile, launchRows, options);
}

export function readTokenRowsFromSessionsDb(dbPath: string = DEFAULT_SESSIONS_DB_PATH): UsageProxyTokenRow[] {
  if (!fs.existsSync(dbPath)) return [];
  let db: any;
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => any };
    db = new sqlite.DatabaseSync(dbPath);
    const columns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(c => c.name));
    const workspace = pickColumn(columns, ['workspace']);
    const model = pickColumn(columns, ['model', 'summary_model']);
    const input = pickColumn(columns, ['input_tokens', 'inputTokens', 'prompt_tokens']);
    const output = pickColumn(columns, ['output_tokens', 'outputTokens', 'completion_tokens']);
    const cached = pickColumn(columns, ['cached_input_tokens', 'cachedInputTokens', 'cache_read_tokens']);
    const cost = pickColumn(columns, ['cost_usd', 'costUsd']);
    const timestamp = pickColumn(columns, ['last_active_at', 'closed_at', 'launched_at']);
    if (!workspace || !model || (!input && !output && !cost)) return [];

    const select = [
      `${quoteIdent(workspace)} AS workspace`,
      `${quoteIdent(model)} AS model`,
      input ? `${quoteIdent(input)} AS inputTokens` : '0 AS inputTokens',
      output ? `${quoteIdent(output)} AS outputTokens` : '0 AS outputTokens',
      cached ? `${quoteIdent(cached)} AS cachedInputTokens` : '0 AS cachedInputTokens',
      cost ? `${quoteIdent(cost)} AS costUsd` : 'NULL AS costUsd',
      timestamp ? `${quoteIdent(timestamp)} AS timestampMs` : 'NULL AS timestampMs',
    ].join(', ');
    return (db.prepare(`SELECT ${select} FROM sessions`).all() as Array<Record<string, unknown>>).map(row => ({
      workspace: String(row.workspace ?? ''),
      model: String(row.model ?? ''),
      inputTokens: finiteNumber(row.inputTokens),
      outputTokens: finiteNumber(row.outputTokens),
      cachedInputTokens: finiteNumber(row.cachedInputTokens),
      costUsd: finiteNumber(row.costUsd),
      timestampMs: finiteNumber(row.timestampMs),
    })).filter(row => row.workspace.length > 0);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

export function readLaunchRowsFromSessionsDb(dbPath: string = DEFAULT_SESSIONS_DB_PATH): UsageProxyLaunchRow[] {
  if (!fs.existsSync(dbPath)) return [];
  let db: any;
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => any };
    db = new sqlite.DatabaseSync(dbPath);
    const columns = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(c => c.name));
    if (!columns.has('workspace') || !columns.has('launched_at')) return [];
    return (db.prepare('SELECT workspace, launched_at AS timestampMs FROM sessions').all() as Array<Record<string, unknown>>).map(row => ({
      workspace: String(row.workspace ?? ''),
      timestampMs: finiteNumber(row.timestampMs) ?? 0,
    })).filter(row => row.workspace.length > 0 && row.timestampMs > 0);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

export function readLaunchRowsFromLog(logPath: string = DEFAULT_LAUNCHES_LOG_PATH): UsageProxyLaunchRow[] {
  if (!fs.existsSync(logPath)) return [];
  try {
    return fs.readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .flatMap(line => {
        try {
          const event = JSON.parse(line) as { profile?: unknown; ts?: unknown };
          const workspace = typeof event.profile === 'string' ? event.profile : '';
          const timestampMs = typeof event.ts === 'string' ? Date.parse(event.ts) : NaN;
          return workspace && Number.isFinite(timestampMs) ? [{ workspace, timestampMs }] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function emptyEstimate(profile: UsageProxyProfile, pricingModel: PricingModel): UsageProxyEstimate {
  return {
    workspace: profile.workspace,
    provider: profile.provider ?? null,
    pricingModel,
    tier: 'none',
    model: profile.defaultModel ?? null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    launchCount: 0,
    costUsd: 0,
    priced: false,
  };
}

function pickColumn(columns: Set<string>, names: string[]): string | null {
  for (const name of names) {
    if (columns.has(name)) return name;
  }
  return null;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
