import { detectEngines } from '../detect.js';
import { makeRunner } from '../select.js';
import type { AgentEvent, ModelRunner, EngineId } from '../types.js';
import type { Middleware, RetryPolicy } from './types.js';
import { resolveRetryDecision, toRetryAudit } from './retry-policy.js';
import { selectByBudget } from './budget.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Opt-in retry middleware. Off by default — consumers must set `retryPolicy`
 * in RunOptions to activate. Designed for transient network failures, not
 * application-level failover (which consumers handle themselves).
 *
 * Set `retryPolicy.managedBy: 'omnai'` to use omnai's built-in retry.
 * When `managedBy` is `'consumer'` (default), this middleware is a no-op.
 *
 * Note: Quota exhaustion is handled at the daemon level (POST /select with
 * estate failoverOrder + QuotaTracker). This middleware only handles transient
 * network/rate-limit errors during execution — the two systems don't conflict.
 */
export function fallbackMiddleware(
  policy?: RetryPolicy,
  getRunner?: (engine: EngineId) => ModelRunner | undefined,
): Middleware {
  return async function* (runner, prompt, opts, next) {
    const retryManagedByOmnai = policy?.managedBy === 'omnai';
    const engines = policy?.engines ?? [];
    let attempt = 0;
    let currentNext = next;
    let currentRunner = runner;

    while (true) {
      const events: AgentEvent[] = [];
      let failed = false;
      let retryDecision: ReturnType<typeof resolveRetryDecision> | null = null;
      let rerouteDecision: Extract<AgentEvent, { type: 'error' }>['reroute'] | null = null;

      try {
        for await (const event of currentNext(prompt, opts)) {
          if (event.type === 'error' && event.code === 'budget_reroute_requested' && event.reroute) {
            failed = true;
            rerouteDecision = event.reroute;
            break;
          }

          if (retryManagedByOmnai) {
            const decision = resolveRetryDecision(policy, event, attempt);
            if (decision.shouldRetry) {
              failed = true;
              retryDecision = decision;
              break;
            }
          }

          events.push(event);
        }
      } catch (err) {
        const event = {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        } as AgentEvent;
        if (retryManagedByOmnai) {
          const decision = resolveRetryDecision(policy, event, attempt);
          if (decision.shouldRetry) {
            failed = true;
            retryDecision = decision;
          } else {
            events.push(event);
          }
        } else {
          events.push(event);
        }
      }

      if (!failed) {
        for (const e of events) yield e;
        return;
      }

      for (const event of events) yield event;
      attempt++;

      if (rerouteDecision) {
        const nextRunner = await resolveBudgetRerouteRunner(rerouteDecision, currentRunner, getRunner);
        if (!nextRunner || nextRunner.engine === currentRunner.engine) {
          yield {
            type: 'error',
            code: 'budget_reroute_unavailable',
            message: `[omnai reroute ${rerouteDecision.reason}] no alternate engine available for tier "${rerouteDecision.targetTier ?? 'unknown'}".`,
            reroute: rerouteDecision,
          } as AgentEvent;
          return;
        }

        const scheduledReroute = {
          ...rerouteDecision,
          toEngine: nextRunner.engine,
        };
        currentRunner = nextRunner;
        currentNext = (p, o) => nextRunner.run(p, o);

        yield {
          type: 'error',
          code: 'reroute_scheduled',
          message: `[omnai reroute ${rerouteDecision.reason} ${rerouteDecision.attempt}] switching from ${rerouteDecision.fromEngine} to ${nextRunner.engine}${rerouteDecision.targetTier ? ` via tier "${rerouteDecision.targetTier}"` : ''}`,
          reroute: scheduledReroute,
        } as AgentEvent;
        continue;
      }

      const delayMs = retryDecision?.waitMs ?? 0;
      await sleep(delayMs);

      const nextRunner = await resolveRetryRunner(engines, attempt, getRunner);
      if (nextRunner) {
        currentRunner = nextRunner;
        currentNext = (p, o) => nextRunner.run(p, o);
      }

      yield {
        type: 'error',
        code: 'retry_scheduled',
        message: `[omnai retry ${retryDecision?.classification ?? 'fatal'} ${retryDecision?.attempt ?? attempt}/${retryDecision?.maxAttempts ?? attempt}] retrying on ${currentRunner.engine} in ${delayMs}ms`,
        retry: retryDecision ? toRetryAudit(retryDecision) : undefined,
      } as AgentEvent;
    }
  };
}

async function resolveRetryRunner(
  engines: EngineId[],
  attempt: number,
  getRunner?: (engine: EngineId) => ModelRunner | undefined,
): Promise<ModelRunner | undefined> {
  if (engines.length === 0) return undefined;
  const nextEngine = engines[(attempt - 1) % engines.length];
  if (!nextEngine) return undefined;
  return getRunner?.(nextEngine) ?? resolveEngineRunner(nextEngine);
}

async function resolveBudgetRerouteRunner(
  reroute: NonNullable<Extract<AgentEvent, { type: 'error' }>['reroute']>,
  currentRunner: ModelRunner,
  getRunner?: (engine: EngineId) => ModelRunner | undefined,
): Promise<ModelRunner | undefined> {
  if (reroute.toEngine) {
    return getRunner?.(reroute.toEngine) ?? resolveEngineRunner(reroute.toEngine);
  }

  if (!reroute.targetTier) return undefined;

  try {
    return await selectByBudget(reroute.targetTier, {}, reroute.avoidEngines);
  } catch {
    return undefined;
  }
}

async function resolveEngineRunner(engine: EngineId): Promise<ModelRunner | undefined> {
  const engines = await detectEngines();
  const detected = engines.find((candidate) => candidate.engine === engine);
  if (!detected?.available || !detected.binaryPath) return undefined;
  return makeRunner(engine, detected.binaryPath);
}
