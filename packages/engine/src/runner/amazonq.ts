import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';

// Amazon Q Developer CLI — uses AWS Builder ID (free, 50 agentic req/mo)
// or IAM Identity Center (Pro, $19/user/mo)
// Auth via `q login` — no API key required

export class AmazonQRunner implements ModelRunner {
  readonly engine = 'amazon-q' as const;

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

    // q dev --no-interactive --trust-all-tools (non-interactive agentic mode)
    const args = ['dev', '--no-interactive'];

    if (opts.permissionMode === 'bypass' || opts.permissionMode === 'dontAsk') {
      args.push('--trust-all-tools');
    }

    args.push(prompt);

    const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...opts.env };

    const proc = execa(this.binaryPath, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: childEnv,
      cancelSignal: opts.abortSignal,
    });

    let finalOutput = '';
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    // Amazon Q outputs plain text (no structured JSON stream) — emit as text
    for await (const chunk of proc) {
      const text = String(chunk);
      if (text.trim()) {
        finalOutput += text;
        yield { type: 'text', content: text };
      }
    }

    yield { type: 'result', output: finalOutput, usage, costUsd: 0, durationMs: Date.now() - startMs };
  }
}
