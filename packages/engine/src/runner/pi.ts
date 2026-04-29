import { execa } from 'execa';
import type { ModelRunner, AgentEvent, RunOptions, TokenUsage, ThinkingLevel } from '../types.js';

interface PiEvent {
  type: 'text' | 'assistant' | 'tool_use' | 'tool_result' | 'result' | 'error';
  content?: string;
  text?: string;
  name?: string;
  input?: unknown;
  is_error?: boolean;
  output?: string;
  session_id?: string;
  cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
}

const EFFORT_TO_THINKING: Record<string, ThinkingLevel> = {
  low:    'minimal',
  medium: 'low',
  high:   'high',
  max:    'xhigh',
};

export class PiMonoRunner implements ModelRunner {
  readonly engine = 'pi-mono' as const;

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

    const args: string[] = ['--output-format', 'json'];

    if (opts.model)    args.push('--model', opts.model);
    if (opts.provider && opts.provider !== 'claude') args.push('--provider', opts.provider);
    if (opts.baseUrl)  args.push('--base-url', opts.baseUrl);
    if (opts.apiKey)   args.push('--api-key', opts.apiKey);

    if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
    if (opts.maxTokens)    args.push('--max-tokens', String(opts.maxTokens));
    if (opts.temperature !== undefined) args.push('--temperature', String(opts.temperature));

    // Thinking: explicit config takes precedence, then effort mapping
    const thinkingOpt = opts.thinking ?? (opts.effort ? EFFORT_TO_THINKING[opts.effort] : undefined);
    if (thinkingOpt) {
      const level: string = typeof thinkingOpt === 'string'
        ? thinkingOpt
        : thinkingOpt.type === 'disabled' ? 'off' : 'high';
      args.push('--thinking', level);
    }

    // Tools
    if (opts.allowedTools !== undefined) {
      if (opts.allowedTools.length === 0) {
        args.push('--no-tools');
      } else {
        args.push('--tools', opts.allowedTools.join(','));
      }
    }

    // Session
    if (opts.resumeSessionId)        args.push('--resume', opts.resumeSessionId);
    if (opts.continueSession)        args.push('--continue');
    if (opts.persistSession === false) args.push('--no-session');

    const proc = execa(this.binaryPath, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      input: prompt,
      lines: true,
      cancelSignal: opts.abortSignal,
    });

    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let finalOutput = '';
    let sessionId: string | undefined;

    for await (const line of proc) {
      if (!line?.trim()) continue;
      let event: PiEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      switch (event.type) {
        case 'text':
        case 'assistant':
          if (event.content || event.text) {
            yield { type: 'text', content: (event.content ?? event.text)! };
          }
          break;
        case 'tool_use':
          yield { type: 'tool_use', name: event.name ?? '', input: event.input };
          break;
        case 'tool_result':
          yield {
            type: 'tool_result',
            name: event.name ?? '',
            content: event.content ?? '',
            isError: !!event.is_error,
          };
          break;
        case 'result':
          finalOutput = event.output ?? event.content ?? '';
          sessionId = event.session_id;
          costUsd = event.cost_usd ?? 0;
          if (event.usage) {
            usage = {
              inputTokens: event.usage.input_tokens ?? 0,
              outputTokens: event.usage.output_tokens ?? 0,
            };
          }
          break;
        case 'error':
          yield { type: 'error', message: event.message ?? event.content ?? 'Unknown pi-mono error' };
          break;
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
