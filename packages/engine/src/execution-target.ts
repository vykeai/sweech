import type { EngineId, Provider, RunOptions, OmnaiConfig } from './types.js';
import { detectEngines } from './detect.js';
import type { EngineStatus } from './types.js';
import { resolveAccount } from './middleware/accounts.js';
import { resolveProfile, resolveDefaultForEngine } from './middleware/profiles.js';
import type { AccountRoutingStrategy } from './subscription-routing.js';
import { CAPABILITIES, type Capability } from './capabilities.js';
import { loadProvidersWithCache } from './providers.js';

export type ContentType = 'text' | 'image' | 'mixed';

export interface ExecutionSelection {
  account?: string;
  provider?: Provider;
  engine?: EngineId;
  fallbackReason?: string;
}

export interface ExecutionTargetInput {
  provider?: Provider;
  engine?: EngineId;
  account?: string;
  profile?: string;
  taskType?: RunOptions['taskType'];
  contentType?: ContentType;
  domain?: string;
  config?: OmnaiConfig;
  fallbackAccounts?: string[];
  accountStrategy?: AccountRoutingStrategy;
  env?: Record<string, string>;
  baseUrl?: string;
  selection?: ExecutionSelection;
  capabilities?: Capability[];
}

export interface ExecutionTarget {
  engine: EngineId;
  provider?: Provider;
  account?: string;
  profile?: string;
  binaryPath: string;
  fallbackReason?: string;
  source: 'explicit-engine' | 'account' | 'profile' | 'selection' | 'detect';
  resolvedOptions?: RunOptions;
}

export interface ExecutionResolutionErrorBody {
  code: string;
  error: string;
}

export class ExecutionResolutionError extends Error {
  readonly status: number;
  readonly body: ExecutionResolutionErrorBody;

  constructor(message: string, code = 'execution_resolution_error', status = 400) {
    super(message);
    this.name = 'ExecutionResolutionError';
    this.status = status;
    this.body = { code, error: message };
  }
}

type EngineById = Record<EngineId, EngineStatus | undefined>;

function toRunOptions(input: ExecutionTargetInput): RunOptions {
  return {
    provider: input.provider,
    account: input.account,
    profile: input.profile,
    taskType: input.taskType,
    env: input.env,
    baseUrl: input.baseUrl,
    fallbackAccounts: input.fallbackAccounts,
    accountStrategy: input.accountStrategy,
  };
}

function indexEngines(engines: EngineStatus[]): EngineById {
  const byId: EngineById = Object.create(null);
  for (const engine of engines) {
    byId[engine.engine] = engine;
  }
  return byId;
}

function assertAvailable(engineId: EngineId, byId: EngineById): EngineStatus {
  const status = byId[engineId];
  if (!status?.available || !status.binaryPath) {
    const providerPath = engineId === 'copilot' ? 'copilot' : engineId;
    throw new ExecutionResolutionError(
      `Engine "${engineId}" not found. Install ${providerPath} or check your PATH.`,
      'ENGINE_NOT_FOUND',
    );
  }
  return status;
}

function pickByProvider(provider: Provider, byId: EngineById, taskType?: string): { engine: EngineId; binaryPath: string } {
  if (provider === 'claude') {
    if (!toMatchTaskType('claude-code', taskType, byId['claude-code'])) {
      return {
        engine: 'claude-code',
        binaryPath: assertAvailable('claude-code', byId).binaryPath!,
      };
    }
    const picked = byId['claude-code'];
    if (picked?.available && picked.binaryPath) {
      return { engine: 'claude-code', binaryPath: picked.binaryPath };
    }
    throw new Error(
      'claude-code not found. The "claude" provider uses your local Claude Code subscription — ' +
      'no API key required. Install claude-code or set claudeBinaryPath in config.'
    );
  }

  if (provider === 'codex') {
    if (!toMatchTaskType('codex', taskType, byId['codex'])) {
      return { engine: 'codex', binaryPath: assertAvailable('codex', byId).binaryPath! };
    }
    const picked = byId['codex'];
    if (picked?.available && picked.binaryPath) {
      return { engine: 'codex', binaryPath: picked.binaryPath };
    }
    throw new Error(
      'codex not found. The "codex" provider uses your local Codex CLI login/subscription — no API key required.'
    );
  }

  if (provider === 'qwen') {
    const picked = byId['qwen-code'];
    if (picked?.available && picked.binaryPath) return { engine: 'qwen-code', binaryPath: picked.binaryPath };
    throw new Error(
      'qwen-code not found. The "qwen" provider uses your local Qwen Code subscription — no API key required. ' +
      'Install qwen-code or add it to your PATH.'
    );
  }

  if (provider === 'gemini' || provider === 'google') {
    const picked = byId['gemini-cli'];
    if (picked?.available && picked.binaryPath) return { engine: 'gemini-cli', binaryPath: picked.binaryPath };
    throw new Error(
      'gemini-cli not found. The "gemini" provider uses your local Gemini CLI Google account — no API key required. ' +
      'Install via: npm i -g @google/gemini-cli'
    );
  }

  if (provider === 'amazon-q') {
    const picked = byId['amazon-q'];
    if (picked?.available && picked.binaryPath) return { engine: 'amazon-q', binaryPath: picked.binaryPath };
    throw new Error(
      'amazon-q not found. The "amazon-q" provider uses AWS Builder ID auth. ' +
      'Install via: https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/q-in-IDE-setup.html'
    );
  }

  if (provider === 'github' || provider === 'copilot') {
    const picked = byId['copilot'];
    if (picked?.available && picked.binaryPath) return { engine: 'copilot', binaryPath: picked.binaryPath };
    throw new Error(
      'copilot not found. The "github"/"copilot" provider uses your GitHub Copilot subscription. ' +
      'Install via: npm i -g @anthropic-ai/copilot-cli or gh copilot'
    );
  }

  if (provider === 'openai') {
    const httpEntry = byId['http'];
    if (httpEntry?.available) return { engine: 'http', binaryPath: '' };
    const order: EngineId[] = ['pi-mono', 'opencode', 'goose'];
    for (const engineId of order) {
      const entry = byId[engineId];
      if (entry?.available && entry.binaryPath) return { engine: engineId, binaryPath: entry.binaryPath };
    }
    throw new Error(
      'No engine available for provider "openai". Install pi-mono, opencode, or goose for API-key based OpenAI routing.'
    );
  }

  const fallbackOrder: EngineId[] = ['pi-mono', 'copilot', 'opencode', 'goose', 'http'];
  for (const engineId of fallbackOrder) {
    const entry = byId[engineId];
    if (entry?.available && entry.binaryPath) return { engine: engineId, binaryPath: entry.binaryPath };
  }

  throw new Error(
    `No engine available for provider "${provider}". Install pi-mono, copilot, opencode, goose, or codex.`
  );
}

function toMatchTaskType(_engine: EngineId, taskType: string | undefined, status: EngineStatus | undefined): boolean {
  if (!taskType) return true;
  if (!status?.available || !status.binaryPath) return false;
  return true;
}

function requiresVision(contentType: ContentType | undefined): boolean {
  return contentType === 'image' || contentType === 'mixed';
}

function isVisionCapable(engineId: EngineId): boolean {
  return CAPABILITIES[engineId]?.vision ?? false;
}

const VISION_FALLBACK_ORDER: EngineId[] = ['claude-code', 'gemini-cli', 'goose', 'pi-mono', 'opencode', 'copilot'];

function pickVisionEngine(byId: EngineById): { engine: EngineId; binaryPath: string } | null {
  for (const engineId of VISION_FALLBACK_ORDER) {
    const entry = byId[engineId];
    if (entry?.available && entry.binaryPath) {
      return { engine: engineId, binaryPath: entry.binaryPath };
    }
  }
  return null;
}

function engineMatchesCapabilities(engineId: EngineId, capabilities: Capability[]): boolean {
  const caps = CAPABILITIES[engineId];
  return capabilities.every(cap => caps[cap] === true);
}

const CAPABILITY_FALLBACK_ORDER: EngineId[] = ['claude-code', 'gemini-cli', 'copilot', 'pi-mono', 'opencode', 'goose', 'codex', 'qwen-code', 'amazon-q'];

function pickCapabilityEngine(byId: EngineById, capabilities: Capability[]): { engine: EngineId; binaryPath: string } | null {
  for (const engineId of CAPABILITY_FALLBACK_ORDER) {
    const entry = byId[engineId];
    if (entry?.available && entry.binaryPath && engineMatchesCapabilities(engineId, capabilities)) {
      return { engine: engineId, binaryPath: entry.binaryPath };
    }
  }
  return null;
}

export async function resolveExecutionTarget(
  input: ExecutionTargetInput,
): Promise<ExecutionTarget> {
  const engines = await detectEngines(input.config);
  const byId = indexEngines(engines);

  // Explicit engine override — highest precedence.
  if (input.engine) {
    const status = assertAvailable(input.engine, byId);
    return {
      source: 'explicit-engine',
      engine: input.engine,
      provider: input.provider,
      account: input.account,
      profile: input.profile,
      binaryPath: status.binaryPath!,
      fallbackReason: input.selection?.fallbackReason,
    };
  }

  // Resolve named account; account takes precedence over profile.
  if (input.account) {
    let resolved;
    try {
      resolved = await resolveAccount(input.account, toRunOptions(input));
    } catch (err) {
      if (err instanceof Error) {
        throw new ExecutionResolutionError(err.message, 'INVALID_ACCOUNT', 400);
      }
      throw err;
    }
    const provider = resolved.provider ?? input.provider;
    const directEngine = (resolved.engine as EngineId | undefined);
    const selected = directEngine
      ? directEngine
      : pickByProvider(provider as Provider, byId, input.taskType).engine;
    const chosen = directEngine
      ? assertAvailable(directEngine, byId)
      : byId[selected];
    return {
      source: 'account',
      engine: selected,
      provider: provider as Provider | undefined,
      account: resolved.account,
      profile: input.profile,
      binaryPath: chosen?.binaryPath!,
      resolvedOptions: resolved.options,
      fallbackReason: input.selection?.fallbackReason,
    };
  }

  // Profile resolution — explicit user choice.
  if (input.profile) {
    let resolved;
    try {
      resolved = await resolveProfile(input.profile, toRunOptions(input));
    } catch (err) {
      if (err instanceof Error) {
        throw new ExecutionResolutionError(err.message, 'INVALID_PROFILE', 400);
      }
      throw err;
    }
    const provider = resolved.provider ?? input.provider ?? 'claude';
    const { engine, binaryPath } = pickByProvider(provider as Provider, byId, input.taskType);
    return {
      source: 'profile',
      engine,
      provider,
      account: input.account,
      profile: input.profile,
      binaryPath,
      resolvedOptions: resolved,
      fallbackReason: input.selection?.fallbackReason,
    };
  }

  // Selection from estate/failover chain — resolved engine/account from estate quota routing.
  if (input.selection && (input.selection.engine || input.selection.provider)) {
    if (input.selection.engine) {
      const status = assertAvailable(input.selection.engine as EngineId, byId);
      return {
        source: 'selection',
        engine: input.selection.engine as EngineId,
        provider: input.selection.provider ?? input.provider,
        account: input.selection.account,
        profile: input.profile,
        binaryPath: status.binaryPath!,
        fallbackReason: input.selection.fallbackReason,
      };
    }

    const provider = (input.selection.provider as Provider | undefined) ?? input.provider ?? 'claude';
    const { engine, binaryPath } = pickByProvider(provider, byId, input.taskType);
    return {
      source: 'selection',
      engine,
      provider,
      account: input.selection.account,
      profile: input.profile,
      binaryPath,
      fallbackReason: input.selection.fallbackReason,
    };
  }

  // Domain-tag routing: prefer accounts tagged with matching domain when no explicit routing given.
  if (!input.provider && !input.engine && !input.account && !input.profile && !input.selection && input.domain) {
    try {
      const providers = await loadProvidersWithCache();
      const domainLower = input.domain.toLowerCase();
      const tagged = Object.entries(providers.accounts).find(([, acc]) =>
        acc.enabled && acc.tags?.some(t => t.toLowerCase() === domainLower)
      );
      if (tagged) {
        const [accountId, acc] = tagged;
        const engineByProvider = engines.find(e => acc.provider === e.providers?.[0] || e.engine === acc.provider);
        if (engineByProvider) {
          const engineId = engineByProvider.engine;
          const engineStatus = byId[engineId];
          if (engineStatus?.available && engineStatus.binaryPath) {
            return {
              source: 'account',
              engine: engineId,
              account: accountId,
              provider: acc.provider as Provider | undefined,
              binaryPath: engineStatus.binaryPath,
              fallbackReason: `domain-tagged account for "${input.domain}"`,
            };
          }
        }
        // If engineByProvider is null or engine unavailable, fall through to standard routing.
      }
    } catch {
      // providers.yaml not found — fall through to standard routing
    }
  }

  // Content-type based routing: prefer vision-capable engine when no explicit engine/provider given.
  if (!input.provider && !input.engine && !input.account && !input.profile && !input.selection) {
    if (requiresVision(input.contentType)) {
      const vision = pickVisionEngine(byId);
      if (vision) {
        return {
          source: 'detect',
          engine: vision.engine,
          fallbackReason: `auto-routed to vision-capable engine for contentType=${input.contentType}`,
          binaryPath: vision.binaryPath,
        };
      }
    }
  }

  // Capability-based routing: filter engines matching ALL requested capabilities.
  if (!input.provider && !input.engine && !input.account && !input.profile && !input.selection) {
    if (input.capabilities && input.capabilities.length > 0) {
      const match = pickCapabilityEngine(byId, input.capabilities);
      if (match) {
        return {
          source: 'detect',
          engine: match.engine,
          fallbackReason: `auto-routed by capabilities: ${input.capabilities.join(', ')}`,
          binaryPath: match.binaryPath,
        };
      }
    }
  }

  // Provider/taskType based fallback.
  const provider = input.provider ?? 'claude';
  if (provider === 'claude') {
    let selected;
    try {
      selected = await resolveDefaultForEngine('claude-code');
    } catch (err) {
      if (err instanceof Error) {
        throw new ExecutionResolutionError(err.message, 'DEFAULT_PROFILE_ERROR', 409);
      }
      throw err;
    }
    if (!selected && (!input.profile)) {
      const { engine, binaryPath } = pickByProvider('claude', byId, input.taskType);
      return {
        source: 'detect',
        engine,
        provider,
        profile: input.profile,
        binaryPath,
      };
    }

    if (selected) {
      let resolved;
      try {
        resolved = await resolveProfile(selected, toRunOptions(input));
      } catch (err) {
        if (err instanceof Error) {
          throw new ExecutionResolutionError(err.message, 'INVALID_DEFAULT_PROFILE', 409);
        }
        throw err;
      }
      const resolvedProvider = (resolved.provider as Provider) ?? provider;
      const { engine, binaryPath } = pickByProvider(resolvedProvider, byId, input.taskType);
      return {
        source: 'detect',
        engine,
        provider: resolvedProvider,
        profile: resolvedProvider === 'claude' ? resolvedProvider : input.profile,
        binaryPath,
        resolvedOptions: resolved,
      };
    }
  }

  const { engine, binaryPath } = pickByProvider(provider, byId, input.taskType);
  return {
    source: 'detect',
    engine,
    provider,
    profile: input.profile,
    binaryPath,
  };
}
