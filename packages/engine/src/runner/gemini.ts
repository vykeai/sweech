import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';

// Gemini CLI — open source, uses Google account OAuth (no API key)
// Uses identical stream-json protocol to claude-code
// Free tier: 1000 req/day, 60 req/min, full Gemini 2.5 Pro access

export class GeminiRunner implements ModelRunner {
  readonly engine = 'gemini-cli' as const;

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
    const { execa } = await import('execa');
    const startMs = Date.now();

    const args = ['--output-format', 'stream-json'];

    if (opts.model) args.push('--model', opts.model);

    // Permission mode → yolo flag
    if (opts.permissionMode === 'bypass' || opts.permissionMode === 'dontAsk') {
      args.push('--yolo');
    }

    if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));

    // Prompt via -p flag (non-interactive)
    args.push('-p', prompt);

    const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...opts.env };
    // Strip claude-code env vars to avoid conflicts
    delete childEnv['CLAUDECODE'];
    delete childEnv['CLAUDE_CODE_ENTRYPOINT'];

    const proc = execa(this.binaryPath, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: childEnv,
      lines: true,
      cancelSignal: opts.abortSignal,
    });

    let sessionId: string | undefined;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let finalOutput = '';

    for await (const line of proc) {
      if (!line?.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }

      // Gemini CLI uses same stream-json protocol as claude-code
      if (msg.type === 'system' && msg.session_id) {
        sessionId = msg.session_id;
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            yield { type: 'text', content: block.text };
          } else if (block.type === 'tool_use') {
            yield { type: 'tool_use', name: block.name, input: block.input };
          }
        }
      } else if (msg.type === 'tool_result') {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
        yield { type: 'tool_result', name: msg.tool_name ?? '', content, isError: !!msg.is_error };
      } else if (msg.type === 'result') {
        finalOutput = msg.result ?? '';
        costUsd = msg.total_cost_usd ?? msg.cost_usd ?? 0;
        if (msg.usage) {
          usage = {
            inputTokens: msg.usage.input_tokens ?? 0,
            outputTokens: msg.usage.output_tokens ?? 0,
            cacheReadTokens: msg.usage.cache_read_input_tokens,
            cacheWriteTokens: msg.usage.cache_creation_input_tokens,
          };
        }
        if (msg.is_error) {
          yield { type: 'error', message: finalOutput || 'Gemini CLI execution failed' };
        }
      }
    }

    yield { type: 'result', output: finalOutput, sessionId, usage, costUsd, durationMs: Date.now() - startMs };
  }
}
