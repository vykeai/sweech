import { execa } from 'execa';
import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';

// goose --output-format stream-json emits claude-code compatible stream-json
interface GooseEvent {
  type: 'system' | 'assistant' | 'tool_result' | 'result';
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
  content?: Array<{ type: string; text?: string }> | string;
  result?: string;
  is_error?: boolean;
}

export class GooseRunner implements ModelRunner {
  readonly engine = 'goose' as const;

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

    const args = ['run', '--output-format', 'stream-json', '--text', prompt];

    if (opts.systemPrompt) args.push('--system', opts.systemPrompt);

    const proc = execa(this.binaryPath, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      lines: true,
      cancelSignal: opts.abortSignal,
    });

    let finalOutput = '';

    for await (const line of proc) {
      if (!line?.trim()) continue;
      let ev: GooseEvent;
      try { ev = JSON.parse(line); } catch { continue; }

      if (ev.type === 'assistant') {
        const blocks = ev.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            yield { type: 'text', content: block.text };
            finalOutput += block.text;
          } else if (block.type === 'tool_use') {
            yield { type: 'tool_use', name: block.name ?? '', input: block.input };
          }
        }
      } else if (ev.type === 'tool_result') {
        const raw = ev.content;
        const content = typeof raw === 'string' ? raw : Array.isArray(raw)
          ? raw.map(b => b.text ?? '').join('') : '';
        yield { type: 'tool_result', name: '', content, isError: !!ev.is_error };
      } else if (ev.type === 'result' && ev.result) {
        finalOutput = ev.result;
      }
    }

    yield {
      type: 'result',
      output: finalOutput,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      durationMs: Date.now() - startMs,
    };
  }
}
