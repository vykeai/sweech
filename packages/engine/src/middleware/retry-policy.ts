import type { AgentEvent } from '../types.js';
import type { RetryClassPolicy, RetryDecisionAudit, RetryOperationClass, RetryPolicy } from './types.js';

export interface RetryClassification {
  classification: RetryOperationClass;
  code: string;
  reason: string;
}

export interface RetryDecision {
  shouldRetry: boolean;
  classification: RetryOperationClass;
  code: string;
  reason: string;
  waitMs: number;
  attempt: number;
  maxAttempts: number;
  terminalReason: string;
}

const RATE_LIMIT_PATTERNS = [/rate.?limit/i, /too many requests/i, /\b429\b/, /throttl/i];
const AUTH_PATTERNS = [/unauthori[sz]ed/i, /\b401\b/, /\b403\b/, /invalid api key/i, /authentication/i, /token expired/i];
const NETWORK_PATTERNS = [/ECONNREFUSED/i, /ECONNRESET/i, /ETIMEDOUT/i, /ENOTFOUND/i, /fetch failed/i, /socket hang up/i, /network/i];

const DEFAULT_RETRY_CLASS_POLICIES: Record<RetryOperationClass, RetryClassPolicy> = {
  infra: { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 2_000, jitterMs: 50, retriable: true },
  throttle: { maxAttempts: 2, baseDelayMs: 750, maxDelayMs: 5_000, jitterMs: 125, retriable: true },
  tool: { maxAttempts: 1, baseDelayMs: 200, maxDelayMs: 1_000, jitterMs: 25, retriable: true, requiresSafeRetry: true },
  auth: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0, retriable: false },
  parse: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, jitterMs: 10, retriable: false },
  fatal: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0, retriable: false },
};

function clonePolicyTable(): Record<RetryOperationClass, RetryClassPolicy> {
  return {
    infra: { ...DEFAULT_RETRY_CLASS_POLICIES.infra },
    throttle: { ...DEFAULT_RETRY_CLASS_POLICIES.throttle },
    tool: { ...DEFAULT_RETRY_CLASS_POLICIES.tool },
    auth: { ...DEFAULT_RETRY_CLASS_POLICIES.auth },
    parse: { ...DEFAULT_RETRY_CLASS_POLICIES.parse },
    fatal: { ...DEFAULT_RETRY_CLASS_POLICIES.fatal },
  };
}

export function classifyRetryEvent(event: AgentEvent): RetryClassification {
  if (event.type === 'stream_parse_error') {
    return { classification: 'parse', code: 'stream_parse_error', reason: event.reason };
  }

  if (event.type === 'hook_error') {
    return { classification: 'tool', code: event.code, reason: event.message };
  }

  if (event.type === 'tool_result' && event.isError) {
    return { classification: 'tool', code: 'tool_error', reason: event.content };
  }

  if (event.type !== 'error') {
    return { classification: 'fatal', code: 'not_retryable_event', reason: event.type };
  }

  if (AUTH_PATTERNS.some((pattern) => pattern.test(event.message))) {
    return { classification: 'auth', code: 'auth_error', reason: event.message };
  }

  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(event.message))) {
    return { classification: 'throttle', code: 'rate_limited', reason: event.message };
  }

  if (NETWORK_PATTERNS.some((pattern) => pattern.test(event.message)) || /timeout/i.test(event.message)) {
    return { classification: 'infra', code: 'transient_infra_error', reason: event.message };
  }

  if (/unexpected token|parse error|invalid json/i.test(event.message)) {
    return { classification: 'parse', code: 'parse_error', reason: event.message };
  }

  return { classification: 'fatal', code: 'unclassified_error', reason: event.message };
}

export function resolveRetryClassPolicies(policy: RetryPolicy): Record<RetryOperationClass, RetryClassPolicy> {
  const resolved = clonePolicyTable();
  const enabled = new Set<RetryOperationClass>(['infra', 'throttle']);
  const retryOn = policy.retryOn;

  if (retryOn) {
    enabled.clear();
    if (retryOn.includes('network') || retryOn.includes('timeout')) enabled.add('infra');
    if (retryOn.includes('rate_limit')) enabled.add('throttle');
    if (retryOn.includes('error')) {
      enabled.add('tool');
      enabled.add('parse');
      enabled.add('fatal');
    }
  }

  if (policy.safeToRetryTools) {
    enabled.add('tool');
  }

  for (const [classification, classPolicy] of Object.entries(resolved) as Array<[RetryOperationClass, RetryClassPolicy]>) {
    if (!enabled.has(classification) && classPolicy.retriable) {
      classPolicy.maxAttempts = 0;
    }
    if (policy.maxRetries !== undefined && classPolicy.retriable) {
      classPolicy.maxAttempts = policy.maxRetries;
    }
    if (policy.delayMs !== undefined && classPolicy.retriable) {
      classPolicy.baseDelayMs = policy.delayMs;
    }
  }

  if (policy.retryClasses) {
    for (const [classification, override] of Object.entries(policy.retryClasses) as Array<[RetryOperationClass, Partial<RetryClassPolicy>]>) {
      resolved[classification] = { ...resolved[classification], ...override };
    }
  }

  for (const classPolicy of Object.values(resolved)) {
    if (classPolicy.maxAttempts <= 0) {
      classPolicy.retriable = false;
    }
  }

  return resolved;
}

export function computeRetryDelay(policy: RetryClassPolicy, attempt: number, random = Math.random): number {
  if (!policy.retriable || policy.maxAttempts <= 0) return 0;
  const baseDelay = policy.baseDelayMs * Math.max(1, 2 ** (attempt - 1));
  const jitter = policy.jitterMs > 0 ? Math.floor(random() * policy.jitterMs) : 0;
  return Math.min(policy.maxDelayMs, baseDelay + jitter);
}

export function resolveRetryDecision(policy: RetryPolicy, event: AgentEvent, previousAttempts: number): RetryDecision {
  const classification = classifyRetryEvent(event);
  const classPolicy = resolveRetryClassPolicies(policy)[classification.classification];

  if (!classPolicy.retriable) {
    return {
      shouldRetry: false,
      classification: classification.classification,
      code: classification.code,
      reason: classification.reason,
      waitMs: 0,
      attempt: previousAttempts,
      maxAttempts: classPolicy.maxAttempts,
      terminalReason: 'non_retriable',
    };
  }

  if (classPolicy.requiresSafeRetry && !policy.safeToRetryTools) {
    return {
      shouldRetry: false,
      classification: classification.classification,
      code: classification.code,
      reason: classification.reason,
      waitMs: 0,
      attempt: previousAttempts,
      maxAttempts: classPolicy.maxAttempts,
      terminalReason: 'unsafe_tool_retry_disabled',
    };
  }

  if (previousAttempts >= classPolicy.maxAttempts) {
    return {
      shouldRetry: false,
      classification: classification.classification,
      code: classification.code,
      reason: classification.reason,
      waitMs: 0,
      attempt: previousAttempts,
      maxAttempts: classPolicy.maxAttempts,
      terminalReason: 'max_attempts_exhausted',
    };
  }

  const attempt = previousAttempts + 1;
  return {
    shouldRetry: true,
    classification: classification.classification,
    code: classification.code,
    reason: classification.reason,
    waitMs: computeRetryDelay(classPolicy, attempt),
    attempt,
    maxAttempts: classPolicy.maxAttempts,
    terminalReason: 'retry_scheduled',
  };
}

export function toRetryAudit(decision: RetryDecision): RetryDecisionAudit {
  return {
    classification: decision.classification,
    code: decision.code,
    attempt: decision.attempt,
    maxAttempts: decision.maxAttempts,
    waitMs: decision.waitMs,
    terminalReason: decision.terminalReason,
  };
}
