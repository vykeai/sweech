import type { AgentEvent, ModelRunner, EngineId, Provider, RunOptions, TokenUsage } from '../types.js';

export type Middleware = (
  runner: ModelRunner,
  prompt: string,
  opts: RunOptions,
  next: (prompt: string, opts: RunOptions) => AsyncGenerator<AgentEvent>,
) => AsyncGenerator<AgentEvent>;

export interface CostAccumulator {
  totalCost: number;
  runs: { engine: EngineId; model?: string; cost: number; usage: TokenUsage }[];
  add(engine: EngineId, model: string | undefined, cost: number, usage: TokenUsage): void;
}

export interface RetryPolicy {
  /** Who manages retry: 'sweech' for built-in retry, 'consumer' to let the calling tool handle it. Default: 'consumer'. */
  managedBy: 'sweech' | 'consumer';
  maxRetries?: number;
  engines?: EngineId[];
  retryOn?: ('error' | 'rate_limit' | 'timeout' | 'network')[];
  delayMs?: number;
  safeToRetryTools?: boolean;
  retryClasses?: Partial<Record<RetryOperationClass, Partial<RetryClassPolicy>>>;
}

export type RetryOperationClass = 'infra' | 'throttle' | 'tool' | 'auth' | 'parse' | 'fatal';

export interface RetryClassPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  retriable: boolean;
  requiresSafeRetry?: boolean;
}

export interface RetryDecisionAudit {
  classification: RetryOperationClass;
  code: string;
  attempt: number;
  maxAttempts: number;
  waitMs: number;
  terminalReason: string;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
  provider: 'anthropic' | 'openai';
}

export interface Profile {
  // Identity
  name: string;
  commandName?: string;
  cliType?: string;

  // Provider
  provider: Provider;

  // Credentials
  /** @deprecated Use keychain instead. Kept for migration compat. */
  apiKey?: string;
  keyInKeychain?: boolean;
  oauth?: OAuthToken;
  env?: Record<string, string>;

  // Network
  baseUrl?: string;

  // Model selection
  model?: string;
  smallFastModel?: string;

  // CLI-specific
  claudeConfigDir?: string;
  sharedWith?: string;

  // Metadata
  createdAt?: string;
}

/** @deprecated Use Profile instead. */
export type CredentialProfile = Profile;

export interface BudgetGuard {
  maxCostUsd: number;
  downgradeTo?: string;  // tier name — required when action is 'fallback_tier'
  maxLatencyMs?: number;
  maxErrorRate?: number;
  rollingWindow?: number;
  minimumSamples?: number;
  hysteresisPct?: number;
  cooldownAttempts?: number;
  action: 'fallback_tier' | 'abort';
}

export type BudgetTrigger = 'cost' | 'latency' | 'error_rate';
export type BudgetProjectionConfidence = 'low' | 'medium' | 'high';

export interface BudgetProjectionMetric {
  mean: number;
  lowerBound: number;
  upperBound: number;
  sampleCount: number;
}

export interface BudgetProjectionSnapshot {
  costUsd: BudgetProjectionMetric;
  latencyMs: BudgetProjectionMetric;
  errorRate: BudgetProjectionMetric;
  confidence: BudgetProjectionConfidence;
}

export interface BudgetRerouteAudit {
  reason: BudgetTrigger;
  attempt: number;
  provider?: Provider;
  fromEngine: EngineId;
  toEngine?: EngineId;
  targetTier?: string;
  threshold: number;
  observed: number;
  hysteresisPct: number;
  cooldownAttempts: number;
  cooldownRemaining: number;
  projection: BudgetProjectionSnapshot;
  avoidEngines: EngineId[];
}

export type ToolIntent = 'read' | 'write' | 'network' | 'exec' | 'mcp' | 'unknown';
export type ToolDecision = 'allow' | 'deny';

export interface ToolPolicyAuditRecord {
  policyId: string;
  actor: string;
  target: string;
  toolName: string;
  intent: ToolIntent;
  decision: ToolDecision;
  reasonCode: string;
  commandHash: string;
  requiresApproval: boolean;
}

export interface ToolPolicy {
  policyId?: string;
  actor?: string;
  allowHighRisk?: boolean;
  allowTools?: string[];
  denyTools?: string[];
  auditSink?: (record: ToolPolicyAuditRecord) => void;
}
