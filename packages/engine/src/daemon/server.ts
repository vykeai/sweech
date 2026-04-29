import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { detectEngines } from '../detect.js';
import { makeRunner, resolveSelectionTarget, type ContentType } from '../select.js';
import { loadEstate } from '../estate.js';
import type { Estate } from '../estate.js';
import { loadSweechTelemetry, reorderAccountsByStrategy, type AccountRoutingStrategy } from '../subscription-routing.js';
import type { AgentEvent, Provider, RunOptions, EngineId } from '../types.js';
import type { QuotaTracker } from './quota.js';
import { loadProvidersWithCache, clearProvidersCache } from '../providers.js';
import type { ProvidersConfig, ProviderAccount } from '../providers.js';
import { wrapRunner, costMiddleware, budgetMiddleware, fallbackMiddleware, toolTimingMiddleware, mcpMiddleware } from '../middleware/index.js';
import { InMemoryConversationStore } from '../memory/stores.js';
import { conversationMiddleware } from '../memory/middleware.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FedEventClient } from '@vykeai/fed';
import {
  getOmnaiStreamSeverity,
  STREAM_PROTOCOL,
  STREAM_PROTOCOL_VERSION,
  STREAM_KIND_DAEMON,
  type OmnaiDaemonStreamEnvelope,
} from '../stream-contract.js';
import { handleMcpRequest } from './mcp.js';
import { runParallel, type ParallelStrategy } from '../parallel.js';
import { registerConfigRoutes } from './config-routes.js';

let cachedEstate: Estate | null = null;
let cachedQuotaTracker: QuotaTracker | null = null;
let cachedProviders: ProvidersConfig | null = null;

// Daemon-level session store for cross-engine conversation continuity (T-LU-031)
const daemonSessionStore = new InMemoryConversationStore();
type DaemonLifecycleState = 'booting' | 'ready' | 'shutting-down' | 'terminated';
let daemonLifecycleState: DaemonLifecycleState = 'booting';
let daemonLifecycleReason = 'booting';
let daemonStartedAt = Date.now();
const activeRunControllers = new Set<AbortController>();
const fedClient = new FedEventClient('http://localhost:7840');
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_PROMPT_CHARS = 200_000;
const MAX_BUDGET_USD = 10000;
const MAX_MAX_TOKENS = 1_000_000;
const MAX_TURNS = 5_000;
const MAX_ARRAY_LENGTH = 512;
const MAX_OBJECT_KEYS = 128;

const KNOWN_ENGINES = new Set([
  'claude-code',
  'qwen-code',
  'gemini-cli',
  'amazon-q',
  'pi-mono',
  'opencode',
  'goose',
  'codex',
  'copilot',
]);
const KNOWN_TASK_TYPES = new Set(['coding', 'analysis', 'planning', 'review', 'chat', 'research']);
const KNOWN_ACCOUNT_STRATEGIES = new Set(['balanced', 'least-used', 'protect-weekly']);
const KNOWN_EFFORT = new Set(['low', 'medium', 'high', 'max']);
const KNOWN_PERMISSION_MODES = new Set(['ask', 'bypass', 'auto', 'acceptEdits', 'plan', 'dontAsk']);
const VALID_RETRY_EVENTS = new Set(['error', 'rate_limit', 'timeout', 'network']);
const VALID_RETRY_MANAGED_BY = new Set(['omnai', 'consumer']);
const VALID_RETRY_CLASSES = new Set(['infra', 'throttle', 'tool', 'auth', 'parse', 'fatal']);
const VALID_THINKING_TYPES = new Set(['disabled', 'adaptive', 'enabled']);
const VALID_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export function setDaemonLifecycleState(state: DaemonLifecycleState, reason = ''): void {
  daemonLifecycleState = state;
  daemonLifecycleReason = reason;
}

export function resetDaemonStartedAt(): void {
  daemonStartedAt = Date.now();
}

export function getDaemonLifecycleState() {
  return {
    state: daemonLifecycleState,
    ready: daemonLifecycleState === 'ready',
    startedAt: daemonStartedAt,
    activeSessions: activeRunControllers.size,
    reason: daemonLifecycleReason,
  };
}

export function startRunSession(): AbortController {
  const controller = new AbortController();
  activeRunControllers.add(controller);
  return controller;
}

export function endRunSession(controller: AbortController): void {
  activeRunControllers.delete(controller);
}

export function cancelAllRunSessions(): void {
  for (const controller of activeRunControllers) {
    if (!controller.signal.aborted) {
      controller.abort('daemon-shutdown');
    }
  }
}

type DaemonStreamEnvelope = OmnaiDaemonStreamEnvelope;

function createDaemonStreamEnvelope(
  event: AgentEvent,
  streamId: string,
  requestId: string,
  traceId: string,
  correlationId: string,
  sequence: number,
): string {
  const envelope: DaemonStreamEnvelope = {
    schema: STREAM_PROTOCOL,
    version: STREAM_PROTOCOL_VERSION,
    kind: STREAM_KIND_DAEMON,
    streamId,
    requestId,
    sequence,
    traceId,
    severity: getOmnaiStreamSeverity(event),
    componentId: 'core.daemon.run',
    correlationId,
    ts: new Date().toISOString(),
    event,
  };
  return JSON.stringify(envelope);
}

const SELECT_REQUEST_KEYS = new Set([
  'provider',
  'engine',
  'taskType',
  'contentType',
  'domain',
  'tier',
  'account',
  'profile',
  'fallbackAccounts',
  'accountStrategy',
  'capabilities',
]);

const KNOWN_TIERS = new Set(['free', 'bronze', 'economy', 'standard', 'silver', 'cheap', 'gold', 'premium', 'full']);

const TIER_TO_ACCOUNT_TYPE: Record<string, ProviderAccount['type']> = {
  free: 'free-tier',
  bronze: 'free-tier',
  economy: 'free-tier',
  standard: 'api-key',
  silver: 'api-key',
  cheap: 'api-key',
  gold: 'subscription',
  premium: 'subscription',
  full: 'subscription',
};

const KNOWN_CONTENT_TYPES = new Set(['text', 'image', 'mixed']);

const RUN_REQUEST_KEYS = new Set([
  'prompt',
  'engine',
  'provider',
  'account',
  'sweechProfile',
  'profile',
  'taskType',
  'contentType',
  'domain',
  'tier',
  'fallbackAccounts',
  'accountStrategy',
  'capabilities',
  'baseUrl',
  'maxBudgetUsd',
  'effort',
  'resumeSessionId',
  'env',
  'permissionMode',
  'systemPrompt',
  'additionalDirectories',
  'allowedTools',
  'disallowedTools',
  'thinking',
  'continueSession',
  'persistSession',
  'omnaiSessionId',
  'maxTurns',
  'outputFormat',
  'mcpServers',
  'hooks',
  'maxTokens',
  'temperature',
  'apiKey',
  'retryPolicy',
  'toolPolicy',
  'budgetGuard',
  'model',
  'budgetTier',
  'strategy',
  'parallelAccounts',
]);

interface ValidationFailure {
  code: string;
  error: string;
  field?: string;
}

interface ValidationResult<T> {
  ok: true;
  value: T;
}

interface ValidationErrorResult {
  ok: false;
  status: number;
  body: ValidationFailure;
}

type SelectRequest = {
  provider?: Provider;
  engine?: EngineId;
  taskType?: RunOptions['taskType'];
  contentType?: ContentType;
  domain?: string;
  tier?: string;
  account?: string;
  profile?: string;
  fallbackAccounts?: string[];
  accountStrategy?: AccountRoutingStrategy;
  capabilities?: string[];
};

type RunRequest = SelectRequest & RunOptions & {
  prompt: string;
  omnaiSessionId?: string;
  strategy?: ParallelStrategy;
  parallelAccounts?: string[];
};

type HandlerResult<T> = ValidationResult<T> | ValidationErrorResult;

function isValidationFailure<T>(result: HandlerResult<T>): result is ValidationErrorResult {
  return result.ok === false;
}

function toValidationErrorBody(result: ValidationErrorResult): {
  ok: false;
  code: string;
  error: string;
  field?: string;
} {
  return {
    ok: false,
    code: result.body.code,
    error: result.body.error,
    ...(result.body.field !== undefined ? { field: result.body.field } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidationErrorResultValue(value: unknown): value is ValidationErrorResult {
  return isRecord(value) && value.ok === false && isRecord(value.body);
}

function isNonEmptyString(value: unknown, field: string): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= min && value <= max;
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return isNumber(value) && value >= min && value <= max;
}

function validateStringArray(
  field: string,
  value: unknown,
  maxItems = MAX_ARRAY_LENGTH,
): ValidationErrorResult | string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    return { ok: false, status: 400, body: { code: 'invalid_field', error: `Invalid ${field}: expected string array`, field } };
  }

  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 255) {
      return { ok: false, status: 400, body: { code: 'invalid_field', error: `Invalid ${field}: expected string array`, field } };
    }
    out.push(item);
  }

  return out;
}

function validateRecordStringMap(field: string, value: unknown): ValidationErrorResult | Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > MAX_OBJECT_KEYS) {
    return { ok: false, status: 400, body: { code: 'invalid_field', error: `Invalid ${field}: expected object map`, field } };
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k !== 'string' || k.length > 255 || typeof v !== 'string' || v.length > 2000) {
      return { ok: false, status: 400, body: { code: 'invalid_field', error: `Invalid ${field}: expected string map`, field } };
    }
    out[k] = v;
  }
  return out;
}

function validateDepth(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (!isRecord(value) && !Array.isArray(value)) return true;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) return false;
    return value.every((item) => validateDepth(item, depth + 1));
  }

  if (Object.keys(value).length > MAX_OBJECT_KEYS) return false;
  for (const v of Object.values(value)) {
    if (!validateDepth(v, depth + 1)) return false;
  }
  return true;
}

function asFailure(status: number, code: string, error: string, field?: string): ValidationErrorResult {
  return { ok: false, status, body: { code, error, ...(field ? { field } : {}) } };
}

function jsonWithStatus<T>(c: any, body: T, status: number) {
  return c.json(body, status as ContentfulStatusCode);
}

function rejectUnknownKeys(value: Record<string, unknown>, expected: Set<string>): ValidationErrorResult | true {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      return asFailure(400, 'unknown_field', `Unknown field: ${key}`, key);
    }
  }
  return true;
}

function validateSelectRequest(raw: unknown): HandlerResult<SelectRequest> {
  if (!isRecord(raw)) return asFailure(400, 'invalid_request', 'Request body must be an object');
  const knownKeysResult = rejectUnknownKeys(raw, SELECT_REQUEST_KEYS);
  if (knownKeysResult !== true) return knownKeysResult;

  const out: SelectRequest = {};
  if (raw.provider !== undefined && !isNonEmptyString(raw.provider, 'provider')) return asFailure(400, 'invalid_field', 'provider must be a non-empty string', 'provider');

  const engine = raw.engine;
  if (engine !== undefined && (typeof engine !== 'string' || !KNOWN_ENGINES.has(engine as EngineId))) {
    return asFailure(400, 'invalid_field', `Unsupported engine "${String(engine)}"`, 'engine');
  }

  const taskType = raw.taskType;
  if (taskType !== undefined && (typeof taskType !== 'string' || !KNOWN_TASK_TYPES.has(taskType as NonNullable<RunOptions['taskType']>))) {
    return asFailure(400, 'invalid_field', `Invalid taskType "${String(taskType)}"`, 'taskType');
  }

  const contentType = raw.contentType;
  if (contentType !== undefined && (typeof contentType !== 'string' || !KNOWN_CONTENT_TYPES.has(contentType))) {
    return asFailure(400, 'invalid_field', `Invalid contentType "${String(contentType)}"`, 'contentType');
  }

  if (raw.domain !== undefined && !isNonEmptyString(raw.domain, 'domain')) {
    return asFailure(400, 'invalid_field', 'domain must be a non-empty string', 'domain');
  }

  const tier = raw.tier;
  if (tier !== undefined && (typeof tier !== 'string' || !KNOWN_TIERS.has(tier.toLowerCase()))) {
    return asFailure(400, 'invalid_field', `Invalid tier "${String(tier)}" (expected: ${[...KNOWN_TIERS].join(', ')})`, 'tier');
  }

  if (raw.account !== undefined && !isNonEmptyString(raw.account, 'account')) return asFailure(400, 'invalid_field', 'account must be a non-empty string', 'account');
  if (raw.profile !== undefined && !isNonEmptyString(raw.profile, 'profile')) return asFailure(400, 'invalid_field', 'profile must be a non-empty string', 'profile');

  const accountStrategy = raw.accountStrategy;
  if (accountStrategy !== undefined && (typeof accountStrategy !== 'string' || !KNOWN_ACCOUNT_STRATEGIES.has(accountStrategy as AccountRoutingStrategy))) {
    return asFailure(400, 'invalid_field', 'accountStrategy invalid', 'accountStrategy');
  }

  const fallback = raw.fallbackAccounts === undefined
    ? undefined
    : validateStringArray('fallbackAccounts', raw.fallbackAccounts);
  if (fallback !== undefined && !Array.isArray(fallback)) return fallback;

  const KNOWN_CAPABILITIES = new Set(['vision', 'code', 'reasoning', 'mcp', 'hooks', 'sessions', 'cost', 'streamJson']);
  const capabilities = raw.capabilities === undefined
    ? undefined
    : validateStringArray('capabilities', raw.capabilities);
  if (capabilities !== undefined && !Array.isArray(capabilities)) return capabilities;
  if (Array.isArray(capabilities)) {
    for (const cap of capabilities) {
      if (!KNOWN_CAPABILITIES.has(cap)) {
        return asFailure(400, 'invalid_field', `Invalid capability "${cap}" (expected: ${[...KNOWN_CAPABILITIES].join(', ')})`, 'capabilities');
      }
    }
  }

  if (fallback) out.fallbackAccounts = fallback;
  if (raw.provider !== undefined) out.provider = raw.provider as Provider;
  if (engine !== undefined) out.engine = engine as EngineId;
  if (taskType !== undefined) out.taskType = taskType as RunOptions['taskType'];
  if (contentType !== undefined) out.contentType = contentType as ContentType;
  if (raw.domain !== undefined) out.domain = raw.domain as string;
  if (tier !== undefined) out.tier = (tier as string).toLowerCase();
  if (raw.account !== undefined) out.account = raw.account;
  if (raw.profile !== undefined) out.profile = raw.profile;
  if (accountStrategy !== undefined) out.accountStrategy = accountStrategy as AccountRoutingStrategy;
  if (Array.isArray(capabilities)) out.capabilities = capabilities;

  return { ok: true, value: out };
}

function validateRunRequest(raw: unknown): HandlerResult<RunRequest> {
  if (!isRecord(raw)) return asFailure(400, 'invalid_request', 'Request body must be an object');
  const knownKeysResult = rejectUnknownKeys(raw, RUN_REQUEST_KEYS);
  if (knownKeysResult !== true) return knownKeysResult;

  if (!isNonEmptyString(raw.prompt, 'prompt')) return asFailure(400, 'invalid_field', 'prompt is required', 'prompt');
  const prompt = raw.prompt as string;
  if (prompt.length > MAX_PROMPT_CHARS) return asFailure(413, 'request_too_large', `prompt exceeds ${MAX_PROMPT_CHARS} chars`, 'prompt');

  const provider = raw.provider;
  if (provider !== undefined && !isNonEmptyString(provider, 'provider')) return asFailure(400, 'invalid_field', 'provider must be a non-empty string', 'provider');
  const engine = raw.engine;
  if (engine !== undefined && (typeof engine !== 'string' || !KNOWN_ENGINES.has(engine as EngineId))) {
    return asFailure(400, 'invalid_field', `Unsupported engine "${String(engine)}"`, 'engine');
  }
  const account = raw.account;
  if (account !== undefined && !isNonEmptyString(account, 'account')) return asFailure(400, 'invalid_field', 'account must be a non-empty string', 'account');
  const taskType = raw.taskType;
  if (taskType !== undefined && (typeof taskType !== 'string' || !KNOWN_TASK_TYPES.has(taskType as NonNullable<RunOptions['taskType']>))) {
    return asFailure(400, 'invalid_field', `Invalid taskType "${String(taskType)}"`, 'taskType');
  }
  const profile = raw.profile;
  if (profile !== undefined && !isNonEmptyString(profile, 'profile')) return asFailure(400, 'invalid_field', 'profile must be a non-empty string', 'profile');

  const fallback = raw.fallbackAccounts === undefined
    ? undefined
    : validateStringArray('fallbackAccounts', raw.fallbackAccounts);
  if (fallback !== undefined && !Array.isArray(fallback)) return fallback;

  const accountStrategy = raw.accountStrategy;
  if (accountStrategy !== undefined && (typeof accountStrategy !== 'string' || !KNOWN_ACCOUNT_STRATEGIES.has(accountStrategy as AccountRoutingStrategy))) {
    return asFailure(400, 'invalid_field', 'accountStrategy invalid', 'accountStrategy');
  }

  const baseUrl = raw.baseUrl;
  if (baseUrl !== undefined) {
    if (!isNonEmptyString(baseUrl, 'baseUrl')) return asFailure(400, 'invalid_field', 'baseUrl must be a non-empty string', 'baseUrl');
    try {
      new URL(baseUrl);
    } catch {
      return asFailure(400, 'invalid_field', 'baseUrl must be a valid URL', 'baseUrl');
    }
  }

  const maxBudgetUsd = raw.maxBudgetUsd;
  if (maxBudgetUsd !== undefined) {
    if (!isNumberInRange(maxBudgetUsd, 0, MAX_BUDGET_USD)) {
      return asFailure(400, 'invalid_field', `maxBudgetUsd must be a number between 0 and ${MAX_BUDGET_USD}`, 'maxBudgetUsd');
    }
  }

  const effort = raw.effort;
  if (effort !== undefined && (typeof effort !== 'string' || !KNOWN_EFFORT.has(effort as NonNullable<RunOptions['effort']>))) {
    return asFailure(400, 'invalid_field', 'invalid effort', 'effort');
  }

  const resumeSessionId = raw.resumeSessionId;
  if (resumeSessionId !== undefined && !isNonEmptyString(resumeSessionId, 'resumeSessionId')) return asFailure(400, 'invalid_field', 'resumeSessionId must be a non-empty string', 'resumeSessionId');

  const env = raw.env === undefined ? undefined : validateRecordStringMap('env', raw.env);
  if (isValidationErrorResultValue(env)) return env;

  const permissionMode = raw.permissionMode;
  if (permissionMode !== undefined && (typeof permissionMode !== 'string' || !KNOWN_PERMISSION_MODES.has(permissionMode as NonNullable<RunOptions['permissionMode']>))) {
    return asFailure(400, 'invalid_field', 'invalid permissionMode', 'permissionMode');
  }

  const systemPrompt = raw.systemPrompt;
  if (systemPrompt !== undefined && !isNonEmptyString(systemPrompt, 'systemPrompt')) return asFailure(400, 'invalid_field', 'systemPrompt must be a non-empty string', 'systemPrompt');

  const additionalDirectories = raw.additionalDirectories === undefined
    ? undefined
    : validateStringArray('additionalDirectories', raw.additionalDirectories);
  if (additionalDirectories !== undefined && !Array.isArray(additionalDirectories)) return additionalDirectories;

  const allowedTools = raw.allowedTools === undefined ? undefined : validateStringArray('allowedTools', raw.allowedTools, 200);
  if (allowedTools !== undefined && !Array.isArray(allowedTools)) return allowedTools;
  const disallowedTools = raw.disallowedTools === undefined ? undefined : validateStringArray('disallowedTools', raw.disallowedTools, 200);
  if (disallowedTools !== undefined && !Array.isArray(disallowedTools)) return disallowedTools;

  const thinking = raw.thinking;
  if (thinking !== undefined) {
    if (!isRecord(thinking)) return asFailure(400, 'invalid_field', 'thinking must be a string or object', 'thinking');
    const type = thinking.type;
    if (typeof type !== 'string' || !VALID_THINKING_TYPES.has(type)) return asFailure(400, 'invalid_field', 'invalid thinking.type', 'thinking.type');
    if (type === 'enabled') {
      const budgetTokens = thinking.budgetTokens;
      if (budgetTokens !== undefined && !isIntegerInRange(budgetTokens, 0, 2_000_000)) {
        return asFailure(400, 'invalid_field', 'thinking.budgetTokens must be an integer between 0 and 2,000,000', 'thinking.budgetTokens');
      }
    }
    if (thinking.level !== undefined && (typeof thinking.level !== 'string' || !VALID_THINKING_LEVELS.has(thinking.level))) {
      return asFailure(400, 'invalid_field', 'invalid thinking.level', 'thinking.level');
    }
    if (type === 'disabled' && Object.keys(thinking).length > 1) {
      return asFailure(400, 'invalid_field', 'invalid thinking payload', 'thinking');
    }
  }

  const continueSession = raw.continueSession;
  if (continueSession !== undefined && !isBoolean(continueSession)) return asFailure(400, 'invalid_field', 'continueSession must be a boolean', 'continueSession');

  const persistSession = raw.persistSession;
  if (persistSession !== undefined && !isBoolean(persistSession)) return asFailure(400, 'invalid_field', 'persistSession must be a boolean', 'persistSession');

  const omnaiSessionId = raw.omnaiSessionId;
  if (omnaiSessionId !== undefined) {
    if (typeof omnaiSessionId !== 'string' || omnaiSessionId.length === 0 || omnaiSessionId.length > 128) {
      return asFailure(400, 'invalid_field', 'omnaiSessionId must be a non-empty string (max 128 chars)', 'omnaiSessionId');
    }
  }

  const maxTurns = raw.maxTurns;
  if (maxTurns !== undefined) {
    if (!isIntegerInRange(maxTurns, 1, MAX_TURNS)) return asFailure(400, 'invalid_field', `maxTurns must be an integer between 1 and ${MAX_TURNS}`, 'maxTurns');
  }

  const outputFormat = raw.outputFormat;
  if (outputFormat !== undefined) {
    if (!isRecord(outputFormat) || outputFormat.type !== 'json' || !isRecord(outputFormat.schema)) {
      return asFailure(400, 'invalid_field', 'outputFormat must be { type: "json", schema: object }', 'outputFormat');
    }
  }

  const mcpServers = raw.mcpServers;
  if (mcpServers !== undefined) {
    if (!isRecord(mcpServers) || Object.keys(mcpServers).length > MAX_OBJECT_KEYS) {
      return asFailure(400, 'invalid_field', 'mcpServers must be an object map', 'mcpServers');
    }
    for (const [name, config] of Object.entries(mcpServers)) {
      if (!isNonEmptyString(name, 'mcpServers key')) return asFailure(400, 'invalid_field', 'mcpServers keys must be non-empty strings', 'mcpServers');
      if (!isRecord(config) || !isNonEmptyString(config.command, 'mcpServers.command')) return asFailure(400, 'invalid_field', `mcpServers["${name}"] must include command`, 'mcpServers');
      if (config.args !== undefined && !Array.isArray(config.args)) {
        return asFailure(400, 'invalid_field', `mcpServers["${name}"].args must be an array`, 'mcpServers');
      }
      if (config.env !== undefined) {
        const envResult = validateRecordStringMap(`mcpServers.${name}.env`, config.env);
        if (isValidationErrorResultValue(envResult)) return envResult;
      }
    }
  }

  if (raw.hooks !== undefined) {
    if (!isRecord(raw.hooks) || Object.keys(raw.hooks).length > MAX_OBJECT_KEYS) {
      return asFailure(400, 'invalid_field', 'hooks must be an object', 'hooks');
    }
    for (const [hookEvent, hooks] of Object.entries(raw.hooks)) {
      if (!isNonEmptyString(hookEvent, 'hooks')) return asFailure(400, 'invalid_field', 'hooks keys must be non-empty strings', 'hooks');
      if (!Array.isArray(hooks)) return asFailure(400, 'invalid_field', `hooks.${hookEvent} must be an array`, `hooks.${hookEvent}`);
      if (hooks.length > MAX_ARRAY_LENGTH) return asFailure(400, 'invalid_field', `hooks.${hookEvent} too long`, `hooks.${hookEvent}`);
      for (const hook of hooks) {
        if (!isRecord(hook) || !isNonEmptyString(hook.matcher, 'hooks[*].matcher')) {
          return asFailure(400, 'invalid_field', `hooks.${hookEvent} items must include matcher`, `hooks.${hookEvent}`);
        }
        if (hook.block !== undefined && !isBoolean(hook.block)) {
          return asFailure(400, 'invalid_field', `hooks.${hookEvent}.block must be boolean`, `hooks.${hookEvent}`);
        }
        if (hook.command !== undefined && !isNonEmptyString(hook.command, `hooks.${hookEvent}.command`)) {
          return asFailure(400, 'invalid_field', `hooks.${hookEvent}.command must be string`, `hooks.${hookEvent}`);
        }
      }
    }
  }

  const maxTokens = raw.maxTokens;
  if (maxTokens !== undefined) {
    if (!isIntegerInRange(maxTokens, 1, MAX_MAX_TOKENS)) return asFailure(400, 'invalid_field', `maxTokens must be an integer between 1 and ${MAX_MAX_TOKENS}`, 'maxTokens');
  }

  const temperature = raw.temperature;
  if (temperature !== undefined && !isNumberInRange(temperature, 0, 1)) {
    return asFailure(400, 'invalid_field', 'temperature must be a number between 0 and 1', 'temperature');
  }

  const apiKey = raw.apiKey;
  if (apiKey !== undefined && !isNonEmptyString(apiKey, 'apiKey')) return asFailure(400, 'invalid_field', 'apiKey must be a non-empty string', 'apiKey');

  const retryPolicy = raw.retryPolicy;
  if (retryPolicy !== undefined) {
    if (!isRecord(retryPolicy)) return asFailure(400, 'invalid_field', 'retryPolicy must be an object', 'retryPolicy');
    if (typeof retryPolicy.managedBy !== 'string' || !VALID_RETRY_MANAGED_BY.has(retryPolicy.managedBy)) {
      return asFailure(400, 'invalid_field', 'retryPolicy.managedBy invalid', 'retryPolicy.managedBy');
    }
    const retries = retryPolicy.maxRetries;
    if (retries !== undefined && !isIntegerInRange(retries, 0, 10)) {
      return asFailure(400, 'invalid_field', 'retryPolicy.maxRetries must be an integer between 0 and 10', 'retryPolicy.maxRetries');
    }
    if (retryPolicy.delayMs !== undefined && !isIntegerInRange(retryPolicy.delayMs, 0, 30_000)) {
      return asFailure(400, 'invalid_field', 'retryPolicy.delayMs must be an integer between 0 and 30000', 'retryPolicy.delayMs');
    }
    if (retryPolicy.safeToRetryTools !== undefined && typeof retryPolicy.safeToRetryTools !== 'boolean') {
      return asFailure(400, 'invalid_field', 'retryPolicy.safeToRetryTools must be a boolean', 'retryPolicy.safeToRetryTools');
    }
    if (retryPolicy.retryOn !== undefined && !Array.isArray(retryPolicy.retryOn)) {
      return asFailure(400, 'invalid_field', 'retryPolicy.retryOn must be an array', 'retryPolicy.retryOn');
    }
    if (Array.isArray(retryPolicy.retryOn)) {
      for (const event of retryPolicy.retryOn) {
        if (!VALID_RETRY_EVENTS.has(event)) return asFailure(400, 'invalid_field', `retryPolicy.retryOn contains invalid event "${String(event)}"`, 'retryPolicy.retryOn');
      }
    }
    if (retryPolicy.engines !== undefined && !Array.isArray(retryPolicy.engines)) {
      return asFailure(400, 'invalid_field', 'retryPolicy.engines must be an array', 'retryPolicy.engines');
    }
    if (Array.isArray(retryPolicy.engines)) {
      for (const engineId of retryPolicy.engines) {
        if (!KNOWN_ENGINES.has(engineId)) return asFailure(400, 'invalid_field', `retryPolicy.engines contains invalid engine "${String(engineId)}"`, 'retryPolicy.engines');
      }
    }
    if (retryPolicy.retryClasses !== undefined) {
      if (!isRecord(retryPolicy.retryClasses)) return asFailure(400, 'invalid_field', 'retryPolicy.retryClasses must be an object', 'retryPolicy.retryClasses');
      for (const [className, classPolicy] of Object.entries(retryPolicy.retryClasses)) {
        if (!VALID_RETRY_CLASSES.has(className)) return asFailure(400, 'invalid_field', `retryPolicy.retryClasses contains invalid class "${className}"`, 'retryPolicy.retryClasses');
        if (!isRecord(classPolicy)) return asFailure(400, 'invalid_field', `retryPolicy.retryClasses.${className} must be an object`, `retryPolicy.retryClasses.${className}`);
        if (classPolicy.maxAttempts !== undefined && !isIntegerInRange(classPolicy.maxAttempts, 0, 10)) {
          return asFailure(400, 'invalid_field', `retryPolicy.retryClasses.${className}.maxAttempts must be an integer between 0 and 10`, `retryPolicy.retryClasses.${className}.maxAttempts`);
        }
        if (classPolicy.baseDelayMs !== undefined && !isIntegerInRange(classPolicy.baseDelayMs, 0, 30_000)) {
          return asFailure(400, 'invalid_field', `retryPolicy.retryClasses.${className}.baseDelayMs must be an integer between 0 and 30000`, `retryPolicy.retryClasses.${className}.baseDelayMs`);
        }
        if (classPolicy.maxDelayMs !== undefined && !isIntegerInRange(classPolicy.maxDelayMs, 0, 60_000)) {
          return asFailure(400, 'invalid_field', `retryPolicy.retryClasses.${className}.maxDelayMs must be an integer between 0 and 60000`, `retryPolicy.retryClasses.${className}.maxDelayMs`);
        }
        if (classPolicy.jitterMs !== undefined && !isIntegerInRange(classPolicy.jitterMs, 0, 10_000)) {
          return asFailure(400, 'invalid_field', `retryPolicy.retryClasses.${className}.jitterMs must be an integer between 0 and 10000`, `retryPolicy.retryClasses.${className}.jitterMs`);
        }
        if (classPolicy.retriable !== undefined && typeof classPolicy.retriable !== 'boolean') {
          return asFailure(400, 'invalid_field', `retryPolicy.retryClasses.${className}.retriable must be a boolean`, `retryPolicy.retryClasses.${className}.retriable`);
        }
        if (classPolicy.requiresSafeRetry !== undefined && typeof classPolicy.requiresSafeRetry !== 'boolean') {
          return asFailure(400, 'invalid_field', `retryPolicy.retryClasses.${className}.requiresSafeRetry must be a boolean`, `retryPolicy.retryClasses.${className}.requiresSafeRetry`);
        }
      }
    }
  }

  const toolPolicy = raw.toolPolicy;
  if (toolPolicy !== undefined) {
    if (!isRecord(toolPolicy)) return asFailure(400, 'invalid_field', 'toolPolicy must be an object', 'toolPolicy');
    if (toolPolicy.policyId !== undefined && !isNonEmptyString(toolPolicy.policyId, 'toolPolicy.policyId')) {
      return asFailure(400, 'invalid_field', 'toolPolicy.policyId must be a non-empty string', 'toolPolicy.policyId');
    }
    if (toolPolicy.actor !== undefined && !isNonEmptyString(toolPolicy.actor, 'toolPolicy.actor')) {
      return asFailure(400, 'invalid_field', 'toolPolicy.actor must be a non-empty string', 'toolPolicy.actor');
    }
    if (toolPolicy.allowHighRisk !== undefined && typeof toolPolicy.allowHighRisk !== 'boolean') {
      return asFailure(400, 'invalid_field', 'toolPolicy.allowHighRisk must be a boolean', 'toolPolicy.allowHighRisk');
    }
    const allowTools = toolPolicy.allowTools === undefined ? undefined : validateStringArray('toolPolicy.allowTools', toolPolicy.allowTools, 200);
    if (allowTools !== undefined && !Array.isArray(allowTools)) return allowTools;
    const denyTools = toolPolicy.denyTools === undefined ? undefined : validateStringArray('toolPolicy.denyTools', toolPolicy.denyTools, 200);
    if (denyTools !== undefined && !Array.isArray(denyTools)) return denyTools;
    if (toolPolicy.auditSink !== undefined) {
      return asFailure(400, 'invalid_field', 'toolPolicy.auditSink cannot be sent over JSON', 'toolPolicy.auditSink');
    }
  }

  const budgetGuard = raw.budgetGuard;
  if (budgetGuard !== undefined) {
    if (!isRecord(budgetGuard)) return asFailure(400, 'invalid_field', 'budgetGuard must be an object', 'budgetGuard');
    const budget = budgetGuard.maxCostUsd;
    if (!isNumberInRange(budget, 0, MAX_BUDGET_USD)) {
      return asFailure(400, 'invalid_field', `budgetGuard.maxCostUsd must be a number between 0 and ${MAX_BUDGET_USD}`, 'budgetGuard.maxCostUsd');
    }
    if (budgetGuard.action !== 'fallback_tier' && budgetGuard.action !== 'abort') {
      return asFailure(400, 'invalid_field', 'budgetGuard.action must be "fallback_tier" or "abort"', 'budgetGuard.action');
    }
    if (budgetGuard.downgradeTo !== undefined && !isNonEmptyString(budgetGuard.downgradeTo, 'budgetGuard.downgradeTo')) {
      return asFailure(400, 'invalid_field', 'budgetGuard.downgradeTo must be a non-empty string', 'budgetGuard.downgradeTo');
    }
    if (budgetGuard.maxLatencyMs !== undefined && !isIntegerInRange(budgetGuard.maxLatencyMs, 1, 600_000)) {
      return asFailure(400, 'invalid_field', 'budgetGuard.maxLatencyMs must be an integer between 1 and 600000', 'budgetGuard.maxLatencyMs');
    }
    if (budgetGuard.maxErrorRate !== undefined && !isNumberInRange(budgetGuard.maxErrorRate, 0, 1)) {
      return asFailure(400, 'invalid_field', 'budgetGuard.maxErrorRate must be a number between 0 and 1', 'budgetGuard.maxErrorRate');
    }
    if (budgetGuard.rollingWindow !== undefined && !isIntegerInRange(budgetGuard.rollingWindow, 1, 20)) {
      return asFailure(400, 'invalid_field', 'budgetGuard.rollingWindow must be an integer between 1 and 20', 'budgetGuard.rollingWindow');
    }
    if (budgetGuard.minimumSamples !== undefined && !isIntegerInRange(budgetGuard.minimumSamples, 1, 20)) {
      return asFailure(400, 'invalid_field', 'budgetGuard.minimumSamples must be an integer between 1 and 20', 'budgetGuard.minimumSamples');
    }
    if (budgetGuard.hysteresisPct !== undefined && !isNumberInRange(budgetGuard.hysteresisPct, 0, 1)) {
      return asFailure(400, 'invalid_field', 'budgetGuard.hysteresisPct must be a number between 0 and 1', 'budgetGuard.hysteresisPct');
    }
    if (budgetGuard.cooldownAttempts !== undefined && !isIntegerInRange(budgetGuard.cooldownAttempts, 0, 10)) {
      return asFailure(400, 'invalid_field', 'budgetGuard.cooldownAttempts must be an integer between 0 and 10', 'budgetGuard.cooldownAttempts');
    }
  }

  if (raw.model !== undefined && !isNonEmptyString(raw.model, 'model')) return asFailure(400, 'invalid_field', 'model must be a non-empty string', 'model');
  if (raw.budgetTier !== undefined && !isNonEmptyString(raw.budgetTier, 'budgetTier')) return asFailure(400, 'invalid_field', 'budgetTier must be a non-empty string', 'budgetTier');

  const runContentType = raw.contentType;
  if (runContentType !== undefined && (typeof runContentType !== 'string' || !KNOWN_CONTENT_TYPES.has(runContentType))) {
    return asFailure(400, 'invalid_field', `Invalid contentType "${String(runContentType)}"`, 'contentType');
  }
  if (raw.domain !== undefined && !isNonEmptyString(raw.domain, 'domain')) {
    return asFailure(400, 'invalid_field', 'domain must be a non-empty string', 'domain');
  }
  const runTier = raw.tier;
  if (runTier !== undefined && (typeof runTier !== 'string' || !KNOWN_TIERS.has(runTier.toLowerCase()))) {
    return asFailure(400, 'invalid_field', `Invalid tier "${String(runTier)}"`, 'tier');
  }

  if (raw.costAccumulator !== undefined) return asFailure(400, 'invalid_field', 'costAccumulator cannot be sent over JSON', 'costAccumulator');
  if (raw.abortSignal !== undefined) return asFailure(400, 'invalid_field', 'abortSignal cannot be sent over JSON', 'abortSignal');

  const KNOWN_STRATEGIES = new Set(['race', 'cheapest', 'consensus']);
  const strategy = raw.strategy;
  if (strategy !== undefined && (typeof strategy !== 'string' || !KNOWN_STRATEGIES.has(strategy))) {
    return asFailure(400, 'invalid_field', 'strategy must be "race", "cheapest", or "consensus"', 'strategy');
  }
  const parallelAccountsRaw = raw.parallelAccounts;
  let parallelAccounts: string[] | undefined;
  if (parallelAccountsRaw !== undefined) {
    const parsed = validateStringArray('parallelAccounts', parallelAccountsRaw, 8);
    if (!Array.isArray(parsed)) return parsed;
    if (parsed.length < 2) return asFailure(400, 'invalid_field', 'parallelAccounts requires at least 2 entries', 'parallelAccounts');
    parallelAccounts = parsed;
  }
  if (strategy !== undefined && parallelAccounts === undefined) {
    return asFailure(400, 'invalid_field', 'parallelAccounts is required when strategy is set', 'parallelAccounts');
  }
  if (strategy !== undefined && omnaiSessionId !== undefined) {
    return asFailure(400, 'invalid_field', 'omnaiSessionId is not supported with parallel strategy', 'omnaiSessionId');
  }

  const result: RunRequest = {
    prompt,
    ...(provider !== undefined ? { provider: provider as Provider } : {}),
    ...(engine !== undefined ? { engine: engine as EngineId } : {}),
    ...(taskType !== undefined ? { taskType: taskType as RunOptions['taskType'] } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(fallback !== undefined ? { fallbackAccounts: fallback } : {}),
    ...(accountStrategy !== undefined ? { accountStrategy: accountStrategy as AccountRoutingStrategy } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(effort !== undefined ? { effort: effort as RunOptions['effort'] } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(env !== undefined && !isValidationErrorResultValue(env) ? { env } : {}),
    ...(permissionMode !== undefined ? { permissionMode: permissionMode as RunOptions['permissionMode'] } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(thinking !== undefined ? { thinking: thinking as RunOptions['thinking'] } : {}),
    ...(continueSession !== undefined ? { continueSession } : {}),
    ...(persistSession !== undefined ? { persistSession } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(outputFormat !== undefined ? { outputFormat: outputFormat as unknown as RunOptions['outputFormat'] } : {}),
    ...(mcpServers !== undefined ? { mcpServers: mcpServers as RunOptions['mcpServers'] } : {}),
    ...(raw.hooks !== undefined ? { hooks: raw.hooks as RunOptions['hooks'] } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(retryPolicy !== undefined ? { retryPolicy: retryPolicy as unknown as RunOptions['retryPolicy'] } : {}),
    ...(toolPolicy !== undefined ? { toolPolicy: toolPolicy as unknown as RunOptions['toolPolicy'] } : {}),
    ...(budgetGuard !== undefined ? { budgetGuard: budgetGuard as unknown as RunOptions['budgetGuard'] } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.budgetTier !== undefined ? { budgetTier: raw.budgetTier } : {}),
    ...(runContentType !== undefined ? { contentType: runContentType as RunOptions['contentType'] } : {}),
    ...(raw.domain !== undefined ? { domain: raw.domain as string } : {}),
    ...(runTier !== undefined ? { tier: (runTier as string).toLowerCase() } : {}),
    ...(raw.sweechProfile !== undefined ? { sweechProfile: raw.sweechProfile as string } : {}),
    ...(omnaiSessionId !== undefined ? { omnaiSessionId } : {}),
    ...(strategy !== undefined ? { strategy: strategy as ParallelStrategy } : {}),
    ...(parallelAccounts !== undefined ? { parallelAccounts } : {}),
  };

  return { ok: true, value: result };
}

function formatValidationFailure(status: number, code: string, error: string): ValidationErrorResult {
  return { ok: false, status, body: { code, error } };
}

async function parseValidatedBody<T>(
  c: any,
  validator: (raw: unknown) => HandlerResult<T>,
  allowEmpty = false,
): Promise<HandlerResult<T>> {
  const declaredLength = c.req.header('content-length');
  if (declaredLength !== null) {
    const declared = Number.parseInt(declaredLength, 10);
    if (!Number.isNaN(declared) && declared > MAX_REQUEST_BYTES) {
      return formatValidationFailure(413, 'request_too_large', `Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
  }

  const rawText = await c.req.text();
  if (!rawText.trim()) {
    if (allowEmpty) return { ok: true, value: {} as T };
    return formatValidationFailure(400, 'invalid_body', 'Request body is required');
  }
  if (rawText.length > MAX_REQUEST_BYTES) {
    return formatValidationFailure(413, 'request_too_large', `Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return formatValidationFailure(400, 'invalid_json', 'Request body must be valid JSON');
  }

  if (!validateDepth(payload)) return formatValidationFailure(400, 'request_too_deep', `Request body exceeds max depth of ${MAX_JSON_DEPTH}`);

  return validator(payload);
}

type EstateSelection =
  | { ok: true; engine?: string; account?: string; provider?: string; fallbackReason?: string }
  | { ok: false; status: 400 | 404 | 429 | 503; body: Record<string, unknown> };

function isEstateSelectionError(value: unknown): value is Extract<EstateSelection, { ok: false }> {
  return isRecord(value) && value.ok === false && typeof value.status === 'number' && isRecord(value.body);
}

interface SweechRecommendation {
  account?: {
    commandName?: string;
    cliType?: string;
  };
}

async function fetchSweechRecommendedAccount(cliType: 'claude' | 'codex'): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:7854/fed/recommendation?cliType=${cliType}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
    const payload = await res.json() as SweechRecommendation | null;
    return payload?.account?.commandName;
  } catch {
    return undefined;
  }
}

async function getVersion(): Promise<string> {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
  return pkg.version;
}

function getFallbackOrder(fallbackAccounts: unknown, estate: Estate): string[] {
  if (!Array.isArray(fallbackAccounts)) return estate.failoverOrder;
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of fallbackAccounts) {
    if (typeof value !== 'string' || seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

async function getRoutedFallbackOrder(
  fallbackAccounts: unknown,
  estate: Estate,
  strategy?: AccountRoutingStrategy,
): Promise<string[]> {
  const order = getFallbackOrder(fallbackAccounts, estate);
  if (!strategy) return order;
  const telemetry = await loadSweechTelemetry().catch(() => ({}));
  return reorderAccountsByStrategy(order, estate, telemetry, strategy);
}

function publishQuotaExceeded(accountId: string, provider: string, engine: string): void {
  fedClient.publish('omnai.provider.throttled', 'omnai', {
    accountId,
    provider,
    engine,
  }).catch(() => {});
}

function publishFailover(skipped: string[], accountId: string, engine: string, reason: string): void {
  fedClient.publish('omnai.failover', 'omnai', {
    from: skipped,
    to: accountId,
    engine,
    reason,
  }).catch(() => {});
}

function selectFromEstate(params: {
  estate: Estate;
  quotaTracker: QuotaTracker | null;
  provider?: string;
  engine?: string;
  account?: string;
  fallbackOrder: string[];
}): EstateSelection {
  const { estate, quotaTracker, provider, engine, account, fallbackOrder } = params;
  const skipped: string[] = [];

  if (account) {
    const selected = estate.accounts[account];
    if (!selected) {
      return { ok: false, status: 404, body: { error: `Unknown account "${account}"` } };
    }
    if (provider && selected.provider !== provider) {
      return { ok: false, status: 400, body: { error: `Account "${account}" does not match provider "${provider}"` } };
    }
    if (engine && selected.engine !== engine) {
      return { ok: false, status: 400, body: { error: `Account "${account}" does not match engine "${engine}"` } };
    }
    if (!quotaTracker || quotaTracker.canUse(account)) {
      return { ok: true, engine: selected.engine, account, provider: selected.provider };
    }

    publishQuotaExceeded(account, selected.provider, selected.engine);
    skipped.push(account);
    if (fallbackOrder.length === 0) {
      return { ok: false, status: 503, body: { error: `Account "${account}" quota exceeded` } };
    }
  }

  for (const accountId of fallbackOrder) {
    if (accountId === account) continue;
    const candidate = estate.accounts[accountId];
    if (!candidate) continue;
    if (provider && candidate.provider !== provider) continue;
    if (engine && candidate.engine !== engine) continue;

    if (quotaTracker && !quotaTracker.canUse(accountId)) {
      publishQuotaExceeded(accountId, candidate.provider, candidate.engine);
      skipped.push(accountId);
      continue;
    }

    const fallbackReason = skipped.length > 0
      ? `${skipped.join(', ')} quota exceeded, fell back to ${accountId}`
      : undefined;

    if (fallbackReason) {
      publishFailover(skipped, accountId, candidate.engine, fallbackReason);
    }

    return {
      ok: true,
      engine: candidate.engine,
      account: accountId,
      provider: candidate.provider,
      ...(fallbackReason ? { fallbackReason } : {}),
    };
  }

  const fallbackReason = `${skipped.length > 0 ? skipped.join(', ') + ' quota exceeded' : 'no matching accounts'}`;
  return {
    ok: false,
    status: skipped.length > 0 ? 503 : 404,
    body: {
      error: skipped.length > 0 ? 'All accounts in failoverOrder exhausted' : 'No matching accounts found',
      fallbackReason,
    },
  };
}

async function resolveRunTarget(options: {
  provider?: string;
  engine?: string;
  account?: string;
  profile?: string;
  taskType?: RunOptions['taskType'];
  contentType?: ContentType;
  domain?: string;
  tier?: string;
  fallbackAccounts?: unknown;
  accountStrategy?: AccountRoutingStrategy;
  capabilities?: import('../capabilities.js').Capability[];
}): Promise<Awaited<ReturnType<typeof resolveSelectionTarget>>> {
  const { provider, engine, account, profile, taskType, contentType, domain, tier, fallbackAccounts, accountStrategy, capabilities } = options;

  // Tier routing: prefer accounts whose type matches the requested subscription tier.
  if (tier && !provider && !engine && !account && !domain) {
    const providers = cachedProviders ?? await loadProvidersWithCache().catch(() => null);
    if (providers) {
      const targetType = TIER_TO_ACCOUNT_TYPE[tier];
      if (targetType) {
        const tierAccount = Object.entries(providers.accounts).find(([, acc]) =>
          acc.enabled && acc.type === targetType
        );
        if (tierAccount) {
          const [accountId] = tierAccount;
          // Check quota before routing to tier account
          if (cachedQuotaTracker && !cachedQuotaTracker.canUse(accountId)) {
            // Fall through to normal estate selection
          } else {
            return resolveSelectionTarget({
              account: accountId,
              profile,
              taskType,
              contentType,
              fallbackAccounts: Array.isArray(fallbackAccounts) ? fallbackAccounts as string[] : undefined,
            });
          }
        }
      }
    }
  }

  // Domain-tag routing takes priority over estate selection when no explicit routing is given.
  if (domain && !provider && !engine && !account) {
    const providers = cachedProviders ?? await loadProvidersWithCache().catch(() => null);
    if (providers) {
      const domainLower = domain.toLowerCase();
      const tagged = Object.entries(providers.accounts).find(([, acc]) =>
        acc.enabled && acc.tags?.some(t => t.toLowerCase() === domainLower)
      );
      if (tagged) {
        const [accountId] = tagged;
        return resolveSelectionTarget({
          account: accountId,
          profile,
          taskType,
          contentType,
          fallbackAccounts: Array.isArray(fallbackAccounts) ? fallbackAccounts as string[] : undefined,
        });
      }
    }
  }

  let selected: EstateSelection = { ok: true, engine, account, provider };
  const hasCachedEstate = !!cachedEstate;

  if (cachedEstate) {
    const fallbackOrder = await getRoutedFallbackOrder(
      fallbackAccounts,
      cachedEstate,
      typeof accountStrategy === 'string' ? accountStrategy : undefined,
    );
    selected = selectFromEstate({
      estate: cachedEstate,
      quotaTracker: cachedQuotaTracker,
      provider,
      engine,
      account,
      fallbackOrder,
    });
    if (!selected.ok) {
      throw selected;
    }
  }

  return resolveSelectionTarget({
    provider: hasCachedEstate ? selected.provider as Provider | undefined : provider as Provider | undefined,
    engine: hasCachedEstate ? undefined : engine as EngineId | undefined,
    account: hasCachedEstate ? undefined : selected.account,
    profile,
    taskType,
    contentType,
    domain,
    fallbackAccounts: Array.isArray(fallbackAccounts) ? fallbackAccounts as string[] : undefined,
    accountStrategy: typeof accountStrategy === 'string' ? accountStrategy : undefined,
    selection: selected.ok && selected.engine
      ? {
          engine: selected.engine as EngineId,
          account: selected.account,
          provider: selected.provider as Provider | undefined,
          fallbackReason: selected.fallbackReason,
        }
      : undefined,
    capabilities,
  });
}

export function createApp(opts?: { estate?: Estate; quotaTracker?: QuotaTracker; providers?: ProvidersConfig }) {
  if (opts?.estate) cachedEstate = opts.estate;
  if (opts?.quotaTracker) cachedQuotaTracker = opts.quotaTracker;
  if (opts?.providers) cachedProviders = opts.providers;
  const app = new Hono();

  // Mount config API routes
  registerConfigRoutes(app);

  app.get('/health', async (c) => {
    const version = await getVersion();
    return c.json({ ok: true, uptime: process.uptime(), version });
  });

  app.get('/healthz', async (c) => {
    const lifecycle = getDaemonLifecycleState();
    const version = await getVersion();
    return c.json(
      {
        ok: lifecycle.ready,
        state: lifecycle.state,
        reason: lifecycle.reason,
        startedAt: lifecycle.startedAt,
        activeSessions: lifecycle.activeSessions,
        uptime: process.uptime(),
        version,
      },
      lifecycle.ready ? 200 : 503,
    );
  });

  app.get('/engines', async (c) => {
    const engines = await detectEngines();
    return c.json(engines);
  });

  app.get('/estate', async (c) => {
    if (!cachedEstate) {
      try {
        cachedEstate = await loadEstate();
      } catch (err) {
        return c.json({ error: (err as Error).message }, 500);
      }
    }
    return c.json(cachedEstate);
  });

  app.get('/quota', (c) => {
    if (!cachedQuotaTracker) {
      return c.json({ accounts: {} });
    }
    return c.json(cachedQuotaTracker.getState());
  });

  app.get('/api/engines', async (c) => {
    if (cachedProviders) {
      const accounts = Object.entries(cachedProviders.accounts)
        .filter(([, acc]) => acc.enabled)
        .map(([id, acc]) => ({
          id,
          provider: acc.provider,
          models: acc.models,
          type: acc.type,
          rateLimit: acc.rateLimit,
        }));
      return c.json({ accounts, failoverOrder: cachedProviders.failoverOrder });
    }
    try {
      const providers = await loadProvidersWithCache();
      cachedProviders = providers;
      const accounts = Object.entries(providers.accounts)
        .filter(([, acc]) => acc.enabled)
        .map(([id, acc]) => ({
          id,
          provider: acc.provider,
          models: acc.models,
          type: acc.type,
          rateLimit: acc.rateLimit,
        }));
      return c.json({ accounts, failoverOrder: providers.failoverOrder });
    } catch {
      const engines = await detectEngines();
      return c.json({ engines });
    }
  });

  app.get('/api/usage', (c) => {
    if (!cachedQuotaTracker) {
      return c.json({ accounts: {}, totalCostUsd: 0 });
    }
    const state = cachedQuotaTracker.getState();
    let totalCostUsd = 0;
    const accountUsage: Record<string, unknown> = {};
    for (const [id, usage] of Object.entries(state.accounts)) {
      totalCostUsd += usage.costUsd;
      const status = cachedQuotaTracker.getAccountStatus(id);
      accountUsage[id] = {
        ...usage,
        canUse: status.canUse,
        utilizationPct: status.utilizationPct,
        quota: status.quota,
      };
    }
    return c.json({ accounts: accountUsage, totalCostUsd, lastFlushed: state.lastFlushed });
  });

  app.get('/providers', async (c) => {
    if (cachedProviders) return c.json(cachedProviders);
    try {
      cachedProviders = await loadProvidersWithCache();
      return c.json(cachedProviders);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/select', async (c) => {
    const lifecycle = getDaemonLifecycleState();
    if (!lifecycle.ready) {
      return c.json({
        ok: false,
        error: 'daemon not ready',
        state: lifecycle.state,
        reason: lifecycle.reason,
      }, 503);
    }

    const bodyValidation = await parseValidatedBody(c, validateSelectRequest, true);
    if (isValidationFailure(bodyValidation)) {
      return jsonWithStatus(c, toValidationErrorBody(bodyValidation), bodyValidation.status);
    }

    const {
      provider,
      engine,
      taskType,
      contentType,
      domain,
      tier,
      account,
      profile,
      fallbackAccounts,
      accountStrategy,
      capabilities,
    } = bodyValidation.value;

    const wantsClaudeFamily = provider === 'claude' || engine === 'claude-code';
    const wantsCodexFamily = provider === 'codex' || engine === 'codex';

    if (!account && (wantsClaudeFamily || wantsCodexFamily)) {
      const suggested = await fetchSweechRecommendedAccount(wantsCodexFamily ? 'codex' : 'claude');
      if (suggested) {
        return c.json({
          engine: wantsCodexFamily ? 'codex' : 'claude-code',
          account: suggested,
          fallbackReason: `recommended by sweech for ${wantsCodexFamily ? 'codex' : 'claude'} quota state`,
        });
      }
    }

    try {
      const target = await resolveRunTarget({
        provider,
        engine,
        account,
        profile,
        taskType,
        contentType,
        domain,
        tier,
        fallbackAccounts,
        accountStrategy,
        capabilities: Array.isArray(capabilities) ? capabilities as import('../capabilities.js').Capability[] : undefined,
      });
      return c.json({
        engine: target.engine,
        ...(target.account ? { account: target.account } : {}),
        ...(target.fallbackReason ? { fallbackReason: target.fallbackReason } : {}),
      });
    } catch (err) {
      const body = isEstateSelectionError(err) ? err.body : { error: (err as Error).message };
      const status = err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : 400;
      return jsonWithStatus(c, body, status);
    }
  });

  app.post('/run', async (c) => {
    const lifecycle = getDaemonLifecycleState();
    if (!lifecycle.ready) {
      return c.json({
        ok: false,
        error: 'daemon not ready',
        state: lifecycle.state,
        reason: lifecycle.reason,
      }, 503);
    }

    const bodyValidation = await parseValidatedBody(c, validateRunRequest);
    if (isValidationFailure(bodyValidation)) {
      return jsonWithStatus(c, toValidationErrorBody(bodyValidation), bodyValidation.status);
    }

    const { prompt, omnaiSessionId: reqOmnaiSessionId, strategy, parallelAccounts, ...opts } = bodyValidation.value;

    // sweechProfile resolves to account — Sweech profiles are auto-merged
    // into the estate with their commandName as the account ID.
    // If Sweech is not installed or the profile doesn't exist in the estate,
    // fall through to default engine selection.
    if (opts.sweechProfile && !opts.account) {
      if (!cachedEstate) {
        try {
          cachedEstate = await loadEstate();
        } catch { /* estate.yaml optional */ }
      }
      if (cachedEstate?.accounts?.[opts.sweechProfile]) {
        opts.account = opts.sweechProfile;
      }
    }

    // Session continuity: derive the omnai session ID for this request.
    // - If the client supplies omnaiSessionId, resume that session.
    // - If persistSession is true and no ID supplied, start a new session.
    const omnaiSessionId: string | undefined =
      reqOmnaiSessionId ?? (opts.persistSession ? randomUUID() : undefined);

    // sweechProfile resolves to account — Sweech profiles are auto-merged
    // into the estate with their commandName as the account ID.
    // If Sweech is not installed or the profile doesn't exist in the estate,
    // fall through to default engine selection.
    if (opts.sweechProfile && !opts.account) {
      if (cachedEstate?.accounts?.[opts.sweechProfile]) {
        opts.account = opts.sweechProfile;
      }
    }

    let target: Awaited<ReturnType<typeof resolveSelectionTarget>>;
    try {
      target = await resolveRunTarget({
        provider: opts.provider,
        engine: opts.engine,
        account: opts.account,
        profile: opts.profile,
        taskType: opts.taskType,
        contentType: opts.contentType,
        domain: opts.domain,
        tier: opts.tier,
        fallbackAccounts: opts.fallbackAccounts,
        accountStrategy: opts.accountStrategy,
        capabilities: Array.isArray(opts.capabilities) ? opts.capabilities as import('../capabilities.js').Capability[] : undefined,
      });
    } catch (err) {
      const body = isEstateSelectionError(err) ? err.body : { error: (err as Error).message };
      const status = err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : 400;
      return jsonWithStatus(c, body, status);
    }

    const resolvedOpts: RunOptions = {
      ...opts,
      ...target.resolvedOptions,
      provider: target.provider ?? opts.provider,
      account: target.account ?? opts.account,
      profile: target.profile ?? opts.profile,
      env: {
        ...(target.resolvedOptions?.env ?? {}),
        ...(opts.env ?? {}),
      },
    };

    // Parallel execution: resolve one runner per account when strategy is set.
    let parallelRunners: ReturnType<typeof makeRunner>[] | undefined;
    if (strategy && parallelAccounts && parallelAccounts.length >= 2) {
      const parallelTargets = await Promise.allSettled(
        parallelAccounts.map((acct) =>
          resolveRunTarget({
            provider: opts.provider,
            engine: opts.engine,
            account: acct,
            profile: opts.profile,
            taskType: opts.taskType,
            contentType: opts.contentType,
            domain: opts.domain,
            tier: opts.tier,
          }),
        ),
      );
      const resolved = parallelTargets
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof resolveRunTarget>>> => r.status === 'fulfilled')
        .map((r) => r.value);
      if (resolved.length < 2) {
        return jsonWithStatus(c, { ok: false, code: 'routing_failed', error: 'Could not resolve at least 2 parallel runners' }, 400);
      }
      parallelRunners = resolved.map((t) => makeRunner(t.engine, t.binaryPath));
    }

    let runner;
    try {
      runner = makeRunner(target.engine, target.binaryPath);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    // Wrap with conversation middleware when an omnai session is active.
    // This prepends stored history to the prompt, ensuring context survives
    // engine switches (quota exhaustion, failover). Applied before fallback
    // middleware so history is injected regardless of which engine is ultimately used.
    if (omnaiSessionId) {
      runner = conversationMiddleware(daemonSessionStore, omnaiSessionId)(runner);
    }

    const middlewares = [costMiddleware, toolTimingMiddleware, mcpMiddleware];
    if (resolvedOpts.budgetGuard) {
      middlewares.unshift(budgetMiddleware(resolvedOpts.budgetGuard));
    }
    if (resolvedOpts.retryPolicy || resolvedOpts.budgetGuard?.action === 'fallback_tier') {
      middlewares.unshift(fallbackMiddleware(resolvedOpts.retryPolicy));
    }
    const wrappedRunner = wrapRunner(runner, ...middlewares);

    const runId = randomUUID();
    const requestId = c.req.header('x-request-id')?.trim() || randomUUID();
    const traceId = c.req.header('x-trace-id')?.trim() || requestId;
    const runSession = startRunSession();
    const streamId = runId;
    const correlationId = runId;
    let sequence = 0;

    const serializeEvent = (event: AgentEvent) => {
      sequence += 1;
      return createDaemonStreamEnvelope(event, streamId, requestId, traceId, correlationId, sequence);
    };

    fedClient.publish('omnai.run.started', 'omnai', {
      runId,
      requestId,
      traceId,
      engine: runner.engine,
      provider: resolvedOpts.provider,
      account: resolvedOpts.account,
      prompt: prompt.slice(0, 100),
    }).catch(() => {});

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          let lastResult: {
            usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
            costUsd: number;
            durationMs: number;
            sessionId?: string;
          } | null = null;
          try {
            const eventSource = parallelRunners && strategy
              ? runParallel(parallelRunners, prompt, { ...resolvedOpts, abortSignal: runSession.signal }, strategy)
              : wrappedRunner.run(prompt, { ...resolvedOpts, abortSignal: runSession.signal });
            for await (const event of eventSource) {
              if (event.type === 'result') {
                lastResult = {
                  usage: event.usage,
                  costUsd: event.costUsd,
                  durationMs: event.durationMs,
                  ...(event.sessionId ? { sessionId: event.sessionId } : {}),
                };
                const enriched = {
                  ...event,
                  ...(resolvedOpts.account ? { account: resolvedOpts.account } : {}),
                  ...(resolvedOpts.provider ? { provider: resolvedOpts.provider } : {}),
                  ...(omnaiSessionId ? { omnaiSessionId } : {}),
                } as AgentEvent;
                const frame = serializeEvent(enriched);
                controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
              } else {
                const frame = serializeEvent(event);
                controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
              }
            }
            fedClient.publish('omnai.run.completed', 'omnai', {
              runId,
              requestId,
              traceId,
              engine: runner.engine,
              status: 'success',
              ...(lastResult ? { usage: lastResult.usage, costUsd: lastResult.costUsd, durationMs: lastResult.durationMs } : {}),
              ...(lastResult?.sessionId ? { sessionId: lastResult.sessionId } : {}),
            }).catch(() => {});
          } catch (err) {
            fedClient.publish('omnai.run.completed', 'omnai', {
              runId, requestId, traceId, engine: runner.engine, status: 'error', error: (err as Error).message,
            }).catch(() => {});
            const message = (err as Error).name === 'AbortError' ? 'daemon shutdown' : (err as Error).message;
            const frame = serializeEvent({ type: 'error', message });
            controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
          } finally {
            endRunSession(runSession);
            controller.close();
          }
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Omnai-Request-Id': requestId,
          'X-Omnai-Trace-Id': traceId,
          'X-Omnai-Stream-Id': streamId,
        },
      }
    );
  });

  app.all('/mcp', async (c) => {
    const response = await handleMcpRequest(c.req.raw);
    return response;
  });

  return app;
}

export function getCachedQuotaTracker(): QuotaTracker | null {
  return cachedQuotaTracker;
}

export function preloadEstate(estate: Estate) {
  cachedEstate = estate;
}

export function clearEstateCache() {
  cachedEstate = null;
  cachedQuotaTracker = null;
  cachedProviders = null;
  clearProvidersCache();
}

export function getDaemonSessionStore() {
  return daemonSessionStore;
}

export function preloadProviders(providers: ProvidersConfig) {
  cachedProviders = providers;
}
