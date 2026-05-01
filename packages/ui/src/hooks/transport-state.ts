import type { SweechUIEvent } from '../types/index.js'
import type { ParsedSweechUiEnvelopeMeta } from '../utils/parse.js'

export interface WebSessionReconnectPolicy {
  enabled: boolean
  initialDelayMs: number
  maxDelayMs: number
  multiplier: number
  jitterMs: number
  maxAttempts: number
  replayWindowSize: number
}

export type WebSessionReconnectInput = boolean | Partial<WebSessionReconnectPolicy>

export const DEFAULT_WEB_SESSION_RECONNECT_POLICY: WebSessionReconnectPolicy = {
  enabled: true,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  multiplier: 2,
  jitterMs: 250,
  maxAttempts: 8,
  replayWindowSize: 128,
}

export function resolveReconnectPolicy(input?: WebSessionReconnectInput): WebSessionReconnectPolicy {
  if (input === false) {
    return { ...DEFAULT_WEB_SESSION_RECONNECT_POLICY, enabled: false }
  }

  if (input === true || input === undefined) {
    return { ...DEFAULT_WEB_SESSION_RECONNECT_POLICY }
  }

  return {
    ...DEFAULT_WEB_SESSION_RECONNECT_POLICY,
    ...input,
    enabled: input.enabled ?? DEFAULT_WEB_SESSION_RECONNECT_POLICY.enabled,
  }
}

export function getReconnectDelayMs(
  attempt: number,
  policy: WebSessionReconnectPolicy,
  randomValue = Math.random(),
): number {
  const normalizedAttempt = Math.max(1, attempt)
  const exponentialDelay = policy.initialDelayMs * (policy.multiplier ** (normalizedAttempt - 1))
  const baseDelay = Math.min(exponentialDelay, policy.maxDelayMs)
  const jitter = policy.jitterMs > 0 ? Math.floor(Math.max(0, randomValue) * policy.jitterMs) : 0
  return Math.min(baseDelay + jitter, policy.maxDelayMs + policy.jitterMs)
}

export function getEnvelopeReplayKey(meta?: ParsedSweechUiEnvelopeMeta): string | null {
  if (!meta?.streamId || meta.sequence === undefined) {
    return null
  }

  return `${meta.streamId}:${meta.sequence}`
}

export function registerReplayKey(
  replayKeys: string[],
  key: string,
  limit: number,
): { duplicate: boolean; next: string[] } {
  if (replayKeys.includes(key)) {
    return { duplicate: true, next: replayKeys }
  }

  const normalizedLimit = Math.max(1, limit)
  const next = replayKeys.length >= normalizedLimit
    ? [...replayKeys.slice(replayKeys.length - normalizedLimit + 1), key]
    : [...replayKeys, key]

  return { duplicate: false, next }
}

export function isTerminalSessionEvent(event: SweechUIEvent): boolean {
  return event.type === 'session_completed' || event.type === 'session_failed'
}
