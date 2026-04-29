import { execa } from 'execa';
import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';

// opencode --format json event shapes
interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  part?: {
    type: string;
    text?: string;
    tool?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
    tokens?: { total?: number; input?: number; output?: number; cache?: { read?: number; write?: number } };
    cost?: number;
    reason?: string;
  };
}

export class OpenCodeRunner implements ModelRunner {
  readonly engine = 'opencode' as const;

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

    const args = ['run', '--format', 'json'];

    if (opts.model)           args.push('--model', opts.model);
    if (opts.resumeSessionId) args.push('--session', opts.resumeSessionId);
    if (opts.continueSession) args.push('--continue');

    // prompt as positional
    args.push(prompt);

    const proc = execa(this.binaryPath, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      lines: true,
      cancelSignal: opts.abortSignal,
    });

    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let finalOutput = '';
    let sessionId: string | undefined;

    for await (const line of proc) {
      if (!line?.trim()) continue;
      let ev: OpenCodeEvent;
      try { ev = JSON.parse(line); } catch { continue; }

      sessionId = ev.sessionID ?? sessionId;

      if (ev.type === 'text' && ev.part?.text) {
        yield { type: 'text', content: ev.part.text };
        finalOutput += ev.part.text;
      } else if (ev.type === 'tool_start' && ev.part?.tool) {
        yield { type: 'tool_use', name: ev.part.tool, input: ev.part.input };
      } else if (ev.type === 'tool_end' && ev.part) {
        const content = typeof ev.part.output === 'string' ? ev.part.output : JSON.stringify(ev.part.output ?? '');
        yield { type: 'tool_result', name: ev.part.tool ?? '', content, isError: !!ev.part.error };
      } else if (ev.type === 'step_finish' && ev.part?.tokens) {
        usage = {
          inputTokens: ev.part.tokens.input ?? 0,
          outputTokens: ev.part.tokens.output ?? 0,
          cacheReadTokens: ev.part.tokens.cache?.read,
          cacheWriteTokens: ev.part.tokens.cache?.write,
        };
        costUsd += ev.part.cost ?? 0;
      }
    }

    yield { type: 'result', output: finalOutput, sessionId, usage, costUsd, durationMs: Date.now() - startMs };
  }
}
