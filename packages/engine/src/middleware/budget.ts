import { detectEngines } from '../detect.js';
import { loadRules } from '../rules/config.js';
import { makeRunner } from '../select.js';
import type { AgentEvent, ModelRunner, RunOptions, EngineId, Provider } from '../types.js';
import type {
  BudgetGuard,
  BudgetProjectionConfidence,
  BudgetProjectionMetric,
  BudgetProjectionSnapshot,
  BudgetRerouteAudit,
  BudgetTrigger,
  Middleware,
} from './types.js';
import type { SelectOptions } from '../select.js';

const DEFAULT_ROLLING_WINDOW = 5;
const DEFAULT_MINIMUM_SAMPLES = 2;
const DEFAULT_HYSTERESIS_PCT = 0.15;
const DEFAULT_COOLDOWN_ATTEMPTS = 1;
const budgetStateKey = Symbol('omnai.budget.state');

interface BudgetSample {
  engine: EngineId;
  provider?: Provider;
  attempt: number;
  costUsd: number;
  latencyMs: number;
  errorRate: number;
}

interface BudgetAttemptState {
  engine: EngineId;
  provider?: Provider;
  attempt: number;
  startedAt: number;
  latestCostUsd: number;
  latestLatencyMs: number;
  failed: boolean;
  completed: boolean;
  finalized: boolean;
}

interface BudgetRerouteRecord {
  attempt: number;
  fromEngine: EngineId;
}

interface BudgetRuntimeState {
  nextAttempt: number;
  samples: BudgetSample[];
  reroutes: BudgetRerouteRecord[];
}

type RunOptionsWithBudgetState = RunOptions & {
  [budgetStateKey]?: BudgetRuntimeState;
};

/**
 * Select the first available engine from the named tier.
 * Falls back through the tier list in order. Throws if none are available.
 */
export async function selectByBudget(
  tier: string,
  opts: SelectOptions = {},
  excludeEngines: EngineId[] = [],
): Promise<ModelRunner> {
  const config = await loadRules();
  const tierEngines = config.tiers[tier];
  if (!tierEngines || tierEngines.length === 0) {
    throw new Error(
      `Tier "${tier}" not found or empty. ` +
      `Available tiers: ${Object.keys(config.tiers).join(', ')}. ` +
      `Use "omnai tiers set ${tier} <engine>..." to define it.`,
    );
  }

  const engines = await detectEngines(opts.config);
  const byId = Object.fromEntries(engines.map((e) => [e.engine, e]));
  const blocked = new Set(excludeEngines);

  for (const engineId of tierEngines) {
    if (blocked.has(engineId)) continue;
    const e = byId[engineId];
    if (e?.available && e.binaryPath) {
      return makeRunner(engineId, e.binaryPath);
    }
  }

  throw new Error(
    `No engine available in tier "${tier}". ` +
    `Tier contains: ${tierEngines.join(', ')}. ` +
    `Install one of them or adjust the tier with "omnai tiers set ${tier} ...".`,
  );
}

/**
 * Budget guard middleware. Watches cumulative cost via cost_update events.
 * When cost exceeds guard.maxCostUsd:
 *   - action 'abort': yields an error event and stops the stream.
 *   - action 'fallback_tier': yields an engine_unavailable error that the
 *     fallback middleware (or rules engine) can catch to downgrade the tier.
 *
 * Must be composed after costMiddleware so cost_update events exist:
 *   wrapRunner(runner, costMiddleware, budgetMiddleware(guard), fallbackMiddleware(...))
 */
export function budgetMiddleware(guard: BudgetGuard): Middleware {
  return async function* (runner, prompt, opts, next) {
    const state = getBudgetRuntimeState(opts);
    const attempt = startBudgetAttempt(state, runner.engine, opts.provider);

    try {
      for await (const event of next(prompt, opts)) {
        updateAttemptTelemetry(attempt, event);

        const trigger = evaluateBudgetTrigger(guard, state, attempt);
        if (trigger) {
          finalizeBudgetAttempt(state, attempt, { rerouted: guard.action === 'fallback_tier' });
          yield event;

          if (guard.action === 'abort') {
            yield {
              type: 'error',
              code: 'budget_exceeded',
              message: `Budget exceeded: cumulative cost $${attempt.latestCostUsd.toFixed(4)} >= $${guard.maxCostUsd.toFixed(2)} limit. Aborting.`,
            } as AgentEvent;
            return;
          }

          if (trigger.cooldownRemaining > 0) {
            yield {
              type: 'error',
              code: 'budget_reroute_blocked',
              message: `[omnai budget] ${formatTriggerLabel(trigger.reason)} projection breached but reroute cooldown is active for ${trigger.cooldownRemaining} more attempt(s).`,
              reroute: trigger,
            } as AgentEvent;
            return;
          }

          state.reroutes.push({ attempt: attempt.attempt, fromEngine: attempt.engine });
          yield {
            type: 'error',
            code: 'budget_reroute_requested',
            message: `[omnai budget] ${formatTriggerLabel(trigger.reason)} projection breached on ${attempt.engine}. Downgrading to tier "${trigger.targetTier ?? guard.downgradeTo ?? 'cheap'}".`,
            reroute: trigger,
          } as AgentEvent;
          return;
        }

        yield event;
      }
    } catch (error) {
      attempt.failed = true;
      finalizeBudgetAttempt(state, attempt);
      throw error;
    }

    finalizeBudgetAttempt(state, attempt);
  };
}

function getBudgetRuntimeState(opts: RunOptions): BudgetRuntimeState {
  const scoped = opts as RunOptionsWithBudgetState;
  if (!scoped[budgetStateKey]) {
    scoped[budgetStateKey] = {
      nextAttempt: 1,
      samples: [],
      reroutes: [],
    };
  }
  return scoped[budgetStateKey];
}

function startBudgetAttempt(
  state: BudgetRuntimeState,
  engine: EngineId,
  provider?: Provider,
): BudgetAttemptState {
  const attempt = state.nextAttempt;
  state.nextAttempt += 1;
  return {
    engine,
    provider,
    attempt,
    startedAt: Date.now(),
    latestCostUsd: 0,
    latestLatencyMs: 0,
    failed: false,
    completed: false,
    finalized: false,
  };
}

function finalizeBudgetAttempt(
  state: BudgetRuntimeState,
  attempt: BudgetAttemptState,
  options: { rerouted?: boolean } = {},
): void {
  if (attempt.finalized) return;
  attempt.latestLatencyMs = Math.max(attempt.latestLatencyMs, Date.now() - attempt.startedAt);
  state.samples.push({
    engine: attempt.engine,
    provider: attempt.provider,
    attempt: attempt.attempt,
    costUsd: attempt.latestCostUsd,
    latencyMs: attempt.latestLatencyMs,
    errorRate: attempt.failed ? 1 : 0,
  });
  attempt.finalized = true;
  if (options.rerouted) {
    attempt.failed = true;
  }
}

function updateAttemptTelemetry(attempt: BudgetAttemptState, event: AgentEvent): void {
  attempt.latestLatencyMs = Math.max(attempt.latestLatencyMs, Date.now() - attempt.startedAt);

  switch (event.type) {
    case 'cost_update':
      attempt.latestCostUsd = event.costUsd;
      break;
    case 'result':
      attempt.latestCostUsd = Math.max(attempt.latestCostUsd, event.costUsd);
      attempt.latestLatencyMs = Math.max(attempt.latestLatencyMs, event.durationMs);
      attempt.completed = true;
      break;
    case 'error':
    case 'stream_parse_error':
    case 'hook_error':
      attempt.failed = true;
      break;
    case 'tool_result':
      if (event.isError) attempt.failed = true;
      break;
    default:
      break;
  }
}

function evaluateBudgetTrigger(
  guard: BudgetGuard,
  state: BudgetRuntimeState,
  attempt: BudgetAttemptState,
): BudgetRerouteAudit | null {
  const hysteresisPct = normalizeFraction(guard.hysteresisPct, DEFAULT_HYSTERESIS_PCT);
  const multiplier = 1 + hysteresisPct;
  const projection = buildProjection(guard, state, attempt);
  const cooldownAttempts = normalizeInteger(guard.cooldownAttempts, DEFAULT_COOLDOWN_ATTEMPTS, 0, 10);
  const cooldownRemaining = getCooldownRemaining(state, attempt, cooldownAttempts);
  const targetTier = guard.downgradeTo ?? 'cheap';
  const avoidEngines = Array.from(new Set<EngineId>([
    ...state.reroutes.map((entry) => entry.fromEngine),
    attempt.engine,
  ]));

  const makeAudit = (
    reason: BudgetTrigger,
    threshold: number,
    observed: number,
  ): BudgetRerouteAudit => ({
    reason,
    attempt: attempt.attempt,
    ...(attempt.provider ? { provider: attempt.provider } : {}),
    fromEngine: attempt.engine,
    ...(guard.action === 'fallback_tier' ? { targetTier } : {}),
    threshold,
    observed,
    hysteresisPct,
    cooldownAttempts,
    cooldownRemaining,
    projection,
    avoidEngines,
  });

  if (attempt.latestCostUsd >= guard.maxCostUsd * multiplier) {
    return makeAudit('cost', guard.maxCostUsd, attempt.latestCostUsd);
  }

  if (guard.maxLatencyMs !== undefined && attempt.latestLatencyMs >= guard.maxLatencyMs * multiplier) {
    return makeAudit('latency', guard.maxLatencyMs, attempt.latestLatencyMs);
  }

  if (
    guard.maxErrorRate !== undefined
    && projection.errorRate.sampleCount >= normalizeInteger(guard.minimumSamples, DEFAULT_MINIMUM_SAMPLES, 1, 20)
    && projection.errorRate.upperBound >= guard.maxErrorRate * multiplier
  ) {
    return makeAudit('error_rate', guard.maxErrorRate, projection.errorRate.upperBound);
  }

  return null;
}

function getCooldownRemaining(
  state: BudgetRuntimeState,
  attempt: BudgetAttemptState,
  cooldownAttempts: number,
): number {
  if (cooldownAttempts <= 0) return 0;
  const lastReroute = state.reroutes[state.reroutes.length - 1];
  if (!lastReroute) return 0;
  const attemptsSinceLastReroute = attempt.attempt - lastReroute.attempt;
  if (attemptsSinceLastReroute > cooldownAttempts) return 0;
  return Math.max(0, cooldownAttempts - attemptsSinceLastReroute + 1);
}

function buildProjection(
  guard: BudgetGuard,
  state: BudgetRuntimeState,
  attempt: BudgetAttemptState,
): BudgetProjectionSnapshot {
  const window = normalizeInteger(guard.rollingWindow, DEFAULT_ROLLING_WINDOW, 1, 20);
  const scopedSamples = state.samples
    .filter((sample) => sample.engine === attempt.engine && sample.provider === attempt.provider)
    .slice(-Math.max(0, window - 1));
  const samples: BudgetSample[] = [
    ...scopedSamples,
    {
      engine: attempt.engine,
      provider: attempt.provider,
      attempt: attempt.attempt,
      costUsd: attempt.latestCostUsd,
      latencyMs: attempt.latestLatencyMs,
      errorRate: attempt.failed ? 1 : 0,
    },
  ];
  const sampleCount = samples.length;

  return {
    costUsd: summarizeProjection(samples.map((sample) => sample.costUsd)),
    latencyMs: summarizeProjection(samples.map((sample) => sample.latencyMs)),
    errorRate: summarizeProjection(samples.map((sample) => sample.errorRate)),
    confidence: getProjectionConfidence(sampleCount),
  };
}

function summarizeProjection(values: number[]): BudgetProjectionMetric {
  if (values.length === 0) {
    return { mean: 0, lowerBound: 0, upperBound: 0, sampleCount: 0 };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  const deviation = Math.sqrt(variance);

  return {
    mean,
    lowerBound: Math.max(0, mean - deviation),
    upperBound: Math.max(mean, mean + deviation),
    sampleCount: values.length,
  };
}

function getProjectionConfidence(sampleCount: number): BudgetProjectionConfidence {
  if (sampleCount >= 5) return 'high';
  if (sampleCount >= 3) return 'medium';
  return 'low';
}

function normalizeInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value ?? fallback));
}

function normalizeFraction(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function formatTriggerLabel(reason: BudgetTrigger): string {
  switch (reason) {
    case 'cost':
      return 'cost';
    case 'latency':
      return 'latency';
    case 'error_rate':
      return 'error-rate';
  }
}
