import { execa } from 'execa';
import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';

// codex exec --json emits newline-delimited JSON
interface CodexRawEvent {
  type: string;
  thread_id?: string;
  item?: {
    id: string;
    type: 'agent_message' | 'reasoning' | 'command_execution' | 'function_call' | 'function_call_output' | string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    name?: string;
    arguments?: unknown;
    output?: unknown;
  };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: string;
  message?: string;
}

export class CodexRunner implements ModelRunner {
  readonly engine = 'codex' as const;

  constructor(private readonly binaryPath: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      const { access } = await import('node:fs/promises');
      await access(this.binaryPath);
      return true;
    } catch {
      return false;
    }
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
    const startMs = Date.now();

    // Build args for `codex exec`
    const isResume = !!opts.resumeSessionId;
    const args: string[] = ['exec', '--json', '--full-auto'];

    if (opts.model) args.push('--model', opts.model);
    if (opts.cwd) args.push('--cd', opts.cwd);

    // Named codex config profile (maps to [-p/--profile] in codex).
    // sweechProfile is resolved to CODEX_HOME env var at the server layer —
    // when CODEX_HOME is set, that directory IS the isolation, so don't pass
    // --profile (which looks for [profiles.<name>] inside config.toml).
    const codexHomeIsolated = !!(opts.env?.CODEX_HOME || process.env.CODEX_HOME);
    if (!codexHomeIsolated && opts.profile) {
      args.push('--profile', opts.profile);
    }

    if (isResume) {
      args.push('resume', opts.resumeSessionId!);
    } else {
      args.push(prompt);
    }

    const proc = execa(this.binaryPath, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      // Close stdin immediately. Codex exec otherwise prints
      // "Reading additional input from stdin..." and blocks forever waiting
      // on EOF, even when the prompt was already passed as the final argv.
      stdin: 'ignore',
      lines: true,
      cancelSignal: opts.abortSignal,
    });

    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let finalOutput = '';
    let sessionId: string | undefined;

    for await (const line of proc) {
      if (!line?.trim()) continue;
      let ev: CodexRawEvent;
      try { ev = JSON.parse(line); } catch { continue; }

      switch (ev.type) {
        case 'thread.started':
          sessionId = ev.thread_id;
          break;

        case 'item.completed': {
          const item = ev.item;
          if (!item) break;

          if (item.type === 'agent_message' && item.text) {
            yield { type: 'text', content: item.text };
            finalOutput += item.text;
          } else if (item.type === 'reasoning' && item.text) {
            yield { type: 'thinking', content: item.text };
          } else if (item.type === 'command_execution') {
            // Map shell executions to tool events
            yield {
              type: 'tool_use',
              name: 'shell',
              input: { command: item.command },
            };
            yield {
              type: 'tool_result',
              name: 'shell',
              content: item.aggregated_output ?? '',
              isError: (item.exit_code ?? 0) !== 0,
            };
          } else if (item.type === 'function_call') {
            yield { type: 'tool_use', name: item.name ?? '', input: item.arguments };
          } else if (item.type === 'function_call_output') {
            yield {
              type: 'tool_result',
              name: item.name ?? '',
              content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
              isError: false,
            };
          }
          break;
        }

        case 'turn.completed':
          if (ev.usage) {
            usage = {
              inputTokens: ev.usage.input_tokens ?? 0,
              outputTokens: ev.usage.output_tokens ?? 0,
              cacheReadTokens: ev.usage.cached_input_tokens,
            };
          }
          break;

        case 'error':
          yield { type: 'error', message: ev.error ?? ev.message ?? 'Codex error' };
          break;
      }
    }

    yield { type: 'result', output: finalOutput, sessionId, usage, costUsd: 0, durationMs: Date.now() - startMs };
  }
}
