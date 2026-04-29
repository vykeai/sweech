import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';
import { validateBaseUrl } from './validate-url.js';
import { validateHeaders } from './validate-headers.js';

const BASE_URL = 'https://api.z.ai/api/paas/v4/chat/completions';

const MODEL_ALIASES: Record<string, string> = {
  'glm5':  'glm-5',
  'glm47': 'glm-4.7',
  'glm47flash': 'glm-4.7-flash',
};

function resolveModel(model: string | undefined): string {
  if (!model) return 'glm-4.7';
  return MODEL_ALIASES[model] ?? model;
}

interface ZhipuChoice {
  delta?: { content?: string; reasoning_content?: string };
  message?: { content?: string; reasoning_content?: string };
  finish_reason?: string;
}

interface ZhipuChunk {
  id: string;
  choices: ZhipuChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class ZhipuRunner implements ModelRunner {
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

    const maxTokens = Math.max(opts.maxTokens ?? 4096, 200);

    const body = {
      model,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
        { role: 'user' as const, content: prompt },
      ],
      max_tokens: maxTokens,
      stream: true,
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
      yield { type: 'error', message: `Zhipu API error ${res.status}: ${errText}` };
      return;
    }

    if (!res.body) {
      yield { type: 'error', message: 'No response body from Zhipu API' };
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
        let chunk: ZhipuChunk;
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

    const costUsd = 0; // cost tracked by pricing module

    yield {
      type: 'result',
      output: finalOutput,
      usage,
      costUsd,
      durationMs: Date.now() - startMs,
    };
  }
}
