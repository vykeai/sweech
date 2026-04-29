import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../types.js';
import { classifyRetryEvent, resolveRetryClassPolicies, resolveRetryDecision } from '../../middleware/retry-policy.js';

describe('retry-policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('classifies retry causes by operation class', () => {
    expect(classifyRetryEvent({ type: 'error', message: '429 Too Many Requests' } as AgentEvent)).toMatchObject({
      classification: 'throttle',
      code: 'rate_limited',
    });
    expect(classifyRetryEvent({ type: 'error', message: 'ECONNREFUSED upstream' } as AgentEvent)).toMatchObject({
      classification: 'infra',
      code: 'transient_infra_error',
    });
    expect(classifyRetryEvent({ type: 'error', message: '401 Unauthorized' } as AgentEvent)).toMatchObject({
      classification: 'auth',
      code: 'auth_error',
    });
    expect(classifyRetryEvent({ type: 'stream_parse_error', source: 'stdout', line: 1, raw: '{', reason: 'Unexpected token' })).toMatchObject({
      classification: 'parse',
      code: 'stream_parse_error',
    });
    expect(classifyRetryEvent({ type: 'tool_result', name: 'exec_command', content: 'failed', isError: true })).toMatchObject({
      classification: 'tool',
      code: 'tool_error',
    });
  });

  it('applies capped backoff with jitter and stops after max attempts', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const first = resolveRetryDecision(
      {
        managedBy: 'omnai',
        retryClasses: {
          throttle: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 180, jitterMs: 20, retriable: true },
        },
      },
      { type: 'error', message: '429 Too Many Requests' },
      0,
    );

    expect(first).toMatchObject({
      shouldRetry: true,
      classification: 'throttle',
      attempt: 1,
      maxAttempts: 2,
      waitMs: 110,
    });

    const exhausted = resolveRetryDecision(
      {
        managedBy: 'omnai',
        retryClasses: {
          throttle: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 180, jitterMs: 20, retriable: true },
        },
      },
      { type: 'error', message: '429 Too Many Requests' },
      2,
    );

    expect(exhausted).toMatchObject({
      shouldRetry: false,
      terminalReason: 'max_attempts_exhausted',
    });
  });

  it('keeps tool retries behind an explicit safety flag', () => {
    const disabled = resolveRetryDecision(
      {
        managedBy: 'omnai',
        retryClasses: {
          tool: { maxAttempts: 2, retriable: true, baseDelayMs: 10, maxDelayMs: 20, jitterMs: 0, requiresSafeRetry: true },
        },
      },
      { type: 'tool_result', name: 'exec_command', content: 'failed', isError: true },
      0,
    );

    expect(disabled).toMatchObject({
      shouldRetry: false,
      terminalReason: 'unsafe_tool_retry_disabled',
    });

    const enabled = resolveRetryDecision(
      {
        managedBy: 'omnai',
        safeToRetryTools: true,
        retryClasses: {
          tool: { maxAttempts: 2, retriable: true, baseDelayMs: 10, maxDelayMs: 20, jitterMs: 0, requiresSafeRetry: true },
        },
      },
      { type: 'tool_result', name: 'exec_command', content: 'failed', isError: true },
      0,
    );

    expect(enabled).toMatchObject({
      shouldRetry: true,
      classification: 'tool',
      attempt: 1,
    });
  });

  it('preserves explicit policy-table overrides', () => {
    const policies = resolveRetryClassPolicies({
      managedBy: 'omnai',
      retryClasses: {
        parse: { maxAttempts: 2, retriable: true, baseDelayMs: 15, maxDelayMs: 30, jitterMs: 1 },
      },
    });

    expect(policies.parse).toMatchObject({
      maxAttempts: 2,
      retriable: true,
      baseDelayMs: 15,
      maxDelayMs: 30,
      jitterMs: 1,
    });
  });
});
