/**
 * Budget-aware routing — `routeWithinBudget()`.
 *
 * Sweech's existing routing (`recommendRoute`, `suggestBestAccount`,
 * `pickFailoverTarget`) all score on quota / freshness / urgency. They
 * ignore $/call entirely, which is wrong for callers that already
 * forecasted token usage and want to constrain by USD.
 *
 * `routeWithinBudget` is the dollar-aware front door:
 *   1. enumerate every candidate via `recommendRoute` (same source of
 *      truth as quota-based routing)
 *   2. for each candidate, compute the estimated cost of one call at
 *      the requested input/output token counts using the canonical
 *      pricing table in `src/costs.ts`
 *   3. skip candidates that are still in a 429 cooldown (so a
 *      budget-cap rotation never lands on a profile we know is
 *      rate-limited)
 *   4. return the highest-scoring candidate whose cost <= budget; any
 *      rejected candidates surface in `result.rejected` with a reason
 *      so the caller can explain "why not".
 *
 * Caller examples:
 *   - vykean/codeuctor — cost-forecast a plan before dispatching it,
 *     then route the executor to a profile that fits the budget
 *   - `sweech auto --budget 0.05` — interactive launch capped at 5¢/call
 *   - downstream tooling that wants a per-call USD ceiling
 */

import type { CLIType } from './providers';
import { isInCooldown } from './failover';
import { recommendRoute } from './accountSelector';
import { estimateCostUsd, getModelPricing } from './costs';

// ── Public API ───────────────────────────────────────────────────────

export interface BudgetRouteRequest {
  /** CLI type to constrain the search to (claude | codex | kimi). */
  cliType: CLIType;
  /** Optional pricing tier hint (free | pro | max | team | enterprise). */
  tier?: 'free' | 'pro' | 'max' | 'team' | 'enterprise';
  /** Hard USD ceiling for one call. Candidates above this are rejected. */
  maxCostPerCallUsd: number;
  /** Estimated input tokens for the call. Default: 5_000. */
  estInputTokens?: number;
  /** Estimated output tokens for the call. Default: 1_500. */
  estOutputTokens?: number;
  /** Estimated cached input tokens (Anthropic/OpenAI prompt cache). Default: 0. */
  estCachedInputTokens?: number;
  /** Override list of profile commandNames to exclude (e.g. already-tried). */
  exclude?: string[];
  /** Override "now" for deterministic tests. */
  now?: number;
}

export interface BudgetRouteRejection {
  /** Profile commandName that was rejected. */
  account: string;
  /** Model the profile would have used. */
  model: string;
  /** Estimated cost in USD for the request. */
  cost: number;
  /** Why this candidate was rejected. */
  reason:
    | 'over-budget'
    | 'cooldown'
    | 'unknown-model'
    | 'unpriced-model'
    | 'cli-mismatch'
    | 'tier-mismatch'
    | 'health-failed'
    | 'excluded';
}

export interface BudgetRouteResult {
  /** Profile commandName that won. */
  account: string;
  /** Model the profile will use. */
  model: string;
  /** Estimated USD cost for the requested call. */
  estimatedCostUsd: number;
  /** Provider key (e.g. 'anthropic', 'kimi-coding'). */
  provider: string;
  /** Configured CLI type (claude | codex | kimi). */
  cliType: CLIType;
  /** Underlying account selector score, preserved for callers. */
  score: number;
  /** Tier the profile is on (when known). */
  tier: string | null;
  /** Other candidates that were rejected, with reasons. */
  rejected: BudgetRouteRejection[];
}

// ── Internal ─────────────────────────────────────────────────────────

/**
 * Map provider plan labels onto the normalised tier vocabulary used
 * by `BudgetRouteRequest.tier`. Returns null when no normalised value
 * applies (e.g. local provider, custom label).
 */
function normalizeTier(planLabel: string | null | undefined): string | null {
  if (!planLabel) return null;
  const lower = planLabel.toLowerCase();
  if (lower.includes('free')) return 'free';
  if (lower.includes('max')) return 'max';
  if (lower.includes('pro')) return 'pro';
  if (lower.includes('team')) return 'team';
  if (lower.includes('enterprise')) return 'enterprise';
  return null;
}

/** Mirror of the planTier matcher with explicit "is this tier?" boolean. */
function matchesTier(planLabel: string | null | undefined, requested: BudgetRouteRequest['tier']): boolean {
  if (!requested) return true;
  const observed = normalizeTier(planLabel);
  if (!observed) return false;
  return observed === requested;
}

// ── Main entry ───────────────────────────────────────────────────────

/**
 * Pick the best profile + model that fits a per-call USD budget.
 *
 * Algorithm:
 *   - run `recommendRoute({ cliType })` to get the scored candidate list
 *   - filter by tier (when requested), exclude set, and 429 cooldowns
 *   - estimate cost via `estimateCostUsd(model, in, out, cachedIn)`
 *   - return the highest-scoring candidate whose cost <= budget
 *
 * Returns null when no candidate fits — callers should fall back to
 * a lower tier or escalate.
 */
export async function routeWithinBudget(
  req: BudgetRouteRequest,
): Promise<BudgetRouteResult | null> {
  const estInput = req.estInputTokens ?? 5_000;
  const estOutput = req.estOutputTokens ?? 1_500;
  const estCachedInput = req.estCachedInputTokens ?? 0;
  const now = req.now ?? Date.now();
  const excluded = new Set(req.exclude ?? []);

  const route = await recommendRoute({ cliType: req.cliType });
  const rejected: BudgetRouteRejection[] = [];

  for (const candidate of route.candidates) {
    const account = candidate.account.commandName;
    const model = candidate.route.model ?? '';

    if (excluded.has(account)) {
      rejected.push({ account, model, cost: 0, reason: 'excluded' });
      continue;
    }

    if (candidate.route.cliType !== req.cliType) {
      rejected.push({ account, model, cost: 0, reason: 'cli-mismatch' });
      continue;
    }

    if (!matchesTier(candidate.route.metadata.costQuotaHints.planLabel ?? candidate.route.quota.planLabel ?? null, req.tier)) {
      rejected.push({ account, model, cost: 0, reason: 'tier-mismatch' });
      continue;
    }

    if (isInCooldown(account, now)) {
      const cost = model ? estimateCostUsd(model, estInput, estOutput, estCachedInput) : 0;
      rejected.push({ account, model, cost, reason: 'cooldown' });
      continue;
    }

    // Reuse the candidate-level rejection signal from recommendRoute
    // (cli-type mismatch, missing-wrapper, auth-required, quota
    // exhausted, etc.). `reasons` is empty when the route is healthy.
    if (candidate.reasons.length > 0 && !candidate.reasons.every(r => r.startsWith('not-selected:'))) {
      const cost = model ? estimateCostUsd(model, estInput, estOutput, estCachedInput) : 0;
      rejected.push({ account, model, cost, reason: 'health-failed' });
      continue;
    }

    if (!model) {
      rejected.push({ account, model: '', cost: 0, reason: 'unknown-model' });
      continue;
    }

    const pricing = getModelPricing(model);
    if (!pricing) {
      // No pricing data → conservatively reject. Caller can fall back
      // by passing a more permissive budget OR by adding an override
      // entry to ~/.sweech/pricing.json.
      rejected.push({ account, model, cost: 0, reason: 'unpriced-model' });
      continue;
    }

    const cost = estimateCostUsd(model, estInput, estOutput, estCachedInput);
    if (cost > req.maxCostPerCallUsd) {
      rejected.push({ account, model, cost, reason: 'over-budget' });
      continue;
    }

    return {
      account,
      model,
      estimatedCostUsd: cost,
      provider: candidate.route.provider,
      cliType: candidate.route.cliType as CLIType,
      score: Number.isFinite(candidate.score) ? candidate.score : 0,
      tier: normalizeTier(candidate.route.quota.planLabel ?? candidate.route.metadata.costQuotaHints.planLabel ?? null),
      rejected,
    };
  }

  return null;
}

/**
 * Filter helper for `sweech accounts list --budget`: return only the
 * candidate command-names whose default model fits the requested
 * budget. Surfaces the per-account cost so the CLI can render a column.
 *
 * Same routing source as `routeWithinBudget` to keep the budget filter
 * consistent across the table view + the single-pick API.
 */
export interface BudgetFilterEntry {
  account: string;
  model: string;
  provider: string;
  cliType: string;
  cost: number;
  fits: boolean;
  reason: BudgetRouteRejection['reason'] | 'ok';
}

export async function filterCandidatesByBudget(
  cliType: CLIType,
  maxCostPerCallUsd: number,
  estInputTokens: number = 5_000,
  estOutputTokens: number = 1_500,
  estCachedInputTokens: number = 0,
): Promise<BudgetFilterEntry[]> {
  const route = await recommendRoute({ cliType });
  const out: BudgetFilterEntry[] = [];

  for (const candidate of route.candidates) {
    if (candidate.route.cliType !== cliType) continue;
    const model = candidate.route.model ?? '';
    if (!model) {
      out.push({
        account: candidate.account.commandName,
        model: '',
        provider: candidate.route.provider,
        cliType: candidate.route.cliType,
        cost: 0,
        fits: false,
        reason: 'unknown-model',
      });
      continue;
    }
    const pricing = getModelPricing(model);
    if (!pricing) {
      out.push({
        account: candidate.account.commandName,
        model,
        provider: candidate.route.provider,
        cliType: candidate.route.cliType,
        cost: 0,
        fits: false,
        reason: 'unpriced-model',
      });
      continue;
    }
    const cost = estimateCostUsd(model, estInputTokens, estOutputTokens, estCachedInputTokens);
    out.push({
      account: candidate.account.commandName,
      model,
      provider: candidate.route.provider,
      cliType: candidate.route.cliType,
      cost,
      fits: cost <= maxCostPerCallUsd,
      reason: cost <= maxCostPerCallUsd ? 'ok' : 'over-budget',
    });
  }

  return out;
}
