import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';
import { validateBaseUrl } from './validate-url.js';
import { validateHeaders } from './validate-headers.js';

const BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions';

const MODEL_ALIASES: Record<string, string> = {
  'qwen-coder': 'qwen3-coder-next',
  'qwen-coder-plus': 'qwen3-coder-plus',
  'qwen-max': 'qwen3-max',
  'qwen-plus': 'qwen3.5-plus',
};

function resolveModel(model: string | undefined): string {
  if (!model) return 'qwen3-coder-plus';
  return MODEL_ALIASES[model] ?? model;
}

interface OpenAIChoice {
  delta?: { content?: string; reasoning_content?: string; role?: string };
  message?: { content?: string; reasoning_content?: string };
  finish_reason?: string;
}

interface OpenAIChunk {
  id: string;
  choices: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class DashScopeRunner implements ModelRunner {
  readonly engine = 'pi-mono' as const;

  constructor(private readonly apiKey: string, baseUrl: string = BASE_URL) {
    this.baseUrl = validateBaseUrl(baseUrl);
  }
  private readonly baseUrl: string;

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
    const startMs = Date.now();
    const model = resolveModel(opts.model);

    const body = {
      model,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
        { role: 'user' as const, content: prompt },
      ],
      max_tokens: opts.maxTokens ?? 8192,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...(opts.headers ? validateHeaders(opts.headers) : {}),
      },
      body: JSON.stringify(body),
      signal: opts.abortSignal,
    });

    if (!res.ok) {
      const errText = await res.text();
      yield { type: 'error', message: `DashScope API error ${res.status}: ${errText}` };
      return;
    }

    if (!res.body) {
      yield { type: 'error', message: 'No response body from DashScope API' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalOutput = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        const json = trimmed.slice(6);
        let chunk: OpenAIChunk;
        try {
          chunk = JSON.parse(json);
        } catch {
          continue;
        }

        for (const choice of chunk.choices) {
          if (choice.delta?.reasoning_content) {
            yield { type: 'thinking', content: choice.delta.reasoning_content };
          }
          if (choice.delta?.content) {
            yield { type: 'text', content: choice.delta.content };
            finalOutput += choice.delta.content;
          }
        }

        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }
    }

    yield {
      type: 'result',
      output: finalOutput,
      usage,
      costUsd: 0,
      durationMs: Date.now() - startMs,
    };
  }
}
