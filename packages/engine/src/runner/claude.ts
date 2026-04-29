import type { ModelRunner, AgentEvent, RunOptions, TokenUsage, ThinkingConfig } from '../types.js';
import { query, type Options, type SDKMessage, type SDKAssistantMessage, type SDKResultMessage, type SDKResultSuccess, type SDKResultError } from '@anthropic-ai/claude-agent-sdk';
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';

const MODEL_MAP: Record<string, string> = {
  opus:   'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku:  'claude-haiku-4-5-20251001',
};

function resolveModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return MODEL_MAP[model] ?? model;
}

function resolvePermissionMode(mode: RunOptions['permissionMode']): Options['permissionMode'] | undefined {
  if (!mode || mode === 'ask') return 'default';
  if (mode === 'bypass') return 'bypassPermissions';
  if (mode === 'acceptEdits') return 'acceptEdits';
  if (mode === 'plan') return 'plan';
  if (mode === 'dontAsk') return 'dontAsk';
  if (mode === 'auto') return 'auto';
  return 'default';
}

function resolveThinking(thinking: RunOptions['thinking']): Options['thinking'] | undefined {
  if (!thinking) return undefined;
  if (typeof thinking === 'string') {
    if (thinking === 'off') return { type: 'disabled' };
    return { type: 'adaptive' };
  }
  return thinking as ThinkingConfig;
}

function isResultSuccess(msg: SDKResultMessage): msg is SDKResultSuccess {
  return msg.subtype === 'success';
}

function isResultError(msg: SDKResultMessage): msg is SDKResultError {
  return msg.subtype !== 'success';
}

export class ClaudeRunner implements ModelRunner {
  readonly engine = 'claude-code' as const;

  constructor(private readonly _binaryPath: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      const { access } = await import('node:fs/promises');
      await access(this._binaryPath);
      return true;
    } catch {
      return false;
    }
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
    const startMs = Date.now();

    // Build SDK options from RunOptions
    const abortController = new AbortController();

    // Forward external abort signal to our controller
    const onExternalAbort = () => abortController.abort();
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const sdkOptions: Options = {
      abortController,
      cwd: opts.cwd,
      model: resolveModel(opts.model),
      permissionMode: resolvePermissionMode(opts.permissionMode),
      allowDangerouslySkipPermissions: opts.permissionMode === 'bypass',
      thinking: resolveThinking(opts.thinking),
      effort: opts.effort,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      resume: opts.resumeSessionId,
      continue: opts.continueSession,
      persistSession: opts.persistSession,
      additionalDirectories: opts.additionalDirectories,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      mcpServers: opts.mcpServers,
      pathToClaudeCodeExecutable: this._binaryPath,
    };

    // System prompt via extraArgs (SDK doesn't have a direct option for this)
    if (opts.systemPrompt) {
      sdkOptions.extraArgs = { 'system-prompt': opts.systemPrompt };
    }

    // Environment: strip nesting-prevention vars, merge caller env
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT' || k === 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS') continue;
      env[k] = v;
    }
    if (opts.env) Object.assign(env, opts.env);
    sdkOptions.env = env;

    // Hooks
    if (opts.hooks) {
      sdkOptions.hooks = opts.hooks as Options['hooks'];
    }

    const q = query({ prompt, options: sdkOptions });

    let sessionId: string | undefined;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let finalOutput = '';

    try {
      for await (const msg of q) {
        // Track session/cost from result messages
        if (msg.type === 'result') {
          sessionId = msg.session_id;
          costUsd = msg.total_cost_usd;
          if (msg.usage) {
            usage = {
              inputTokens: msg.usage.input_tokens ?? 0,
              outputTokens: msg.usage.output_tokens ?? 0,
              cacheReadTokens: msg.usage.cache_read_input_tokens,
              cacheWriteTokens: msg.usage.cache_creation_input_tokens,
            };
          }
          if (isResultSuccess(msg)) {
            finalOutput = msg.result ?? '';
          } else if (isResultError(msg)) {
            const errMsg = 'errors' in msg ? (msg as SDKResultError).errors.join('; ') : 'Agent execution failed';
            yield { type: 'error', message: errMsg };
          }
          continue;
        }

        // Track session from assistant messages
        if (msg.type === 'assistant') {
          sessionId = msg.session_id;
        }

        // Map SDK message to zero or more AgentEvents
        for (const event of mapEvents(msg)) {
          yield event;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        // expected abort — fall through to yield result
      } else {
        throw error;
      }
    } finally {
      if (opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', onExternalAbort);
      }
    }

    yield {
      type: 'result',
      output: finalOutput,
      sessionId,
      usage,
      costUsd,
      durationMs: Date.now() - startMs,
    };
  }
}

function* mapEvents(msg: SDKMessage): Generator<AgentEvent> {
  if (msg.type === 'assistant') {
    const content = (msg as SDKAssistantMessage).message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'thinking' && 'thinking' in block && block.thinking) {
        yield { type: 'thinking', content: block.thinking as string };
      } else if (block.type === 'text' && 'text' in block && block.text) {
        yield { type: 'text', content: block.text as string };
      } else if (block.type === 'tool_use') {
        const toolBlock = block as BetaToolUseBlock;
        yield {
          type: 'tool_use',
          name: toolBlock.name,
          input: toolBlock.input,
          id: toolBlock.id,
        };
      }
    }
  }
}
