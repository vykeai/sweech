import type { AgentEvent, EngineId } from '../types.js';
import type { Rule, RuleAction, RuleCondition, RuleEvent, RulesConfig } from './types.js';

export interface EvalContext {
  engine: EngineId;
  provider?: string;
  cumulativeCostUsd?: number;
}

const RATE_LIMIT_PATTERNS = [/rate.?limit/i, /too many requests/i, /429/];
const TIMEOUT_PATTERNS = [/timeout/i, /ETIMEDOUT/i, /timed? ?out/i];

function resolveEventType(event: AgentEvent): RuleEvent | null {
  if (event.type === 'error') {
    if (RATE_LIMIT_PATTERNS.some(p => p.test(event.message))) return 'rate_limit';
    if (TIMEOUT_PATTERNS.some(p => p.test(event.message))) return 'timeout';
    return 'error';
  }
  if (event.type === 'cost_update') return 'cost_exceeded';
  return null;
}

function getEventMessage(event: AgentEvent): string {
  if (event.type === 'error') return event.message;
  if (event.type === 'text') return event.content;
  return '';
}

export function evaluateRule(event: AgentEvent, rule: Rule, ctx: EvalContext): boolean {
  const { when } = rule;

  // Event type must match
  const resolved = resolveEventType(event);
  if (resolved !== when.event) return false;

  // Engine filter — exact match
  if (when.engine && when.engine !== ctx.engine) return false;

  // Provider filter — exact match
  if (when.provider && when.provider !== ctx.provider) return false;

  // Pattern filter — regex against message
  if (when.pattern) {
    const msg = getEventMessage(event);
    if (!new RegExp(when.pattern, 'i').test(msg)) return false;
  }

  // Cost threshold — cumulative cost must exceed
  if (when.maxCostUsd != null) {
    if ((ctx.cumulativeCostUsd ?? 0) <= when.maxCostUsd) return false;
  }

  return true;
}

export function evaluateRules(event: AgentEvent, config: RulesConfig, ctx: EvalContext): RuleAction | null {
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (evaluateRule(event, rule, ctx)) return rule.then;
  }
  return null;
}
