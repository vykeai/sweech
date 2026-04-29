import { detectEngines } from './detect.js';
import { ClaudeRunner } from './runner/claude.js';
import { QwenRunner } from './runner/qwen.js';
import { GeminiRunner } from './runner/gemini.js';
import { AmazonQRunner } from './runner/amazonq.js';
import { PiMonoRunner } from './runner/pi.js';
import { OpenCodeRunner } from './runner/opencode.js';
import { GooseRunner } from './runner/goose.js';
import { CodexRunner } from './runner/codex.js';
import { CopilotRunner } from './runner/copilot.js';
import { OpenAICompatRunner } from './runner/openai-compat.js';
import type { ModelRunner, OmnaiConfig, Provider, EngineId, RunOptions } from './types.js';
import type { ModelOption } from './models.js';
import { resolveExecutionTarget, type ExecutionSelection, type ExecutionTarget, type ContentType } from './execution-target.js';
import type { Capability } from './capabilities.js';

export const TASK_REQUIREMENTS: Record<string, Partial<Record<keyof ModelOption, unknown>>> = {
  coding:   { supportsToolUse: true },
  analysis: { supportsThinking: true },
  planning: { supportsThinking: true },
  review:   { supportsToolUse: true },
  chat:     {},
  research: { supportsToolUse: true },
};

export interface SelectOptions {
  provider?: Provider;
  engine?: EngineId;
  account?: string;
  fallbackAccounts?: string[];
  accountStrategy?: import('./subscription-routing.js').AccountRoutingStrategy;
  config?: OmnaiConfig;
  profile?: string;
  taskType?: RunOptions['taskType'];
  contentType?: ContentType;
  capabilities?: Capability[];
  domain?: string;
  selection?: ExecutionSelection;
  env?: Record<string, string>;
  baseUrl?: string;
}

export type { ContentType };

export function makeRunner(engine: EngineId, binaryPath: string): ModelRunner {
  switch (engine) {
    case 'claude-code': return new ClaudeRunner(binaryPath);
    case 'qwen-code':   return new QwenRunner(binaryPath);
    case 'gemini-cli':  return new GeminiRunner(binaryPath);
    case 'amazon-q':    return new AmazonQRunner(binaryPath);
    case 'pi-mono':     return new PiMonoRunner(binaryPath);
    case 'opencode':    return new OpenCodeRunner(binaryPath);
    case 'goose':       return new GooseRunner(binaryPath);
    case 'codex':       return new CodexRunner(binaryPath);
    case 'copilot':     return new CopilotRunner(binaryPath);
    case 'http':        return new OpenAICompatRunner();
  }
}

export async function resolveSelectionTarget(opts: SelectOptions = {}): Promise<ExecutionTarget> {
  return resolveExecutionTarget({
    provider: opts.provider,
    engine: opts.engine,
    account: opts.account,
    profile: opts.profile,
    taskType: opts.taskType,
    contentType: opts.contentType,
    domain: opts.domain,
    config: opts.config,
    fallbackAccounts: opts.fallbackAccounts,
    accountStrategy: opts.accountStrategy,
    env: opts.env,
    baseUrl: opts.baseUrl,
    selection: opts.selection,
    capabilities: opts.capabilities,
  });
}

export async function select(opts: SelectOptions = {}): Promise<ModelRunner> {
  const target = await resolveSelectionTarget(opts);
  return makeRunner(target.engine, target.binaryPath);
}

export async function selectViaDaemon(opts: SelectOptions = {}): Promise<ModelRunner> {
  try {
    const { OmnaiClient } = await import('./client.js');
    const client = new OmnaiClient();
    const isUp = await client.ping();
    if (isUp) {
      const result = await client.select({
        provider: opts.provider,
        engine: opts.engine,
        account: opts.account,
        fallbackAccounts: opts.fallbackAccounts,
        accountStrategy: opts.accountStrategy,
        taskType: opts.taskType,
      });
      const engines = await detectEngines(opts.config);
      const status = engines.find(e => e.engine === result.engine);
      if (status?.available && status.binaryPath) {
        return makeRunner(result.engine as EngineId, status.binaryPath);
      }
    }
  } catch {
    // Daemon not available, fall through to local select
  }

  return select(opts);
}
