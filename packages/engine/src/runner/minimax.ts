import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';
import { validateBaseUrl } from './validate-url.js';
import { validateHeaders } from './validate-headers.js';

const BASE_URL = 'https://api.minimax.io/anthropic/v1/messages';

const MODEL_ALIASES: Record<string, string> = {
  'minimax': 'MiniMax-M2.5',
  'm2.5': 'MiniMax-M2.5',
};

function resolveModel(model: string | undefined): string {
  if (!model) return 'MiniMax-M2.5';
  return MODEL_ALIASES[model] ?? model;
}

interface AnthropicContentBlock {
  type: 'text' | 'thinking';
  text?: string;
  thinking?: string;
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
  content_block?: AnthropicContentBlock;
  message?: {
    id: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class MiniMaxRunner implements ModelRunner {
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
      max_tokens: opts.maxTokens ?? 8192,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
        { role: 'user' as const, content: prompt },
      ],
      stream: true,
    };

    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        ...(opts.headers ? validateHeaders(opts.headers) : {}),
      },
      body: JSON.stringify(body),
      signal: opts.abortSignal,
    });

    if (!res.ok) {
      const errText = await res.text();
      yield { type: 'error', message: `MiniMax API error ${res.status}: ${errText}` };
      return;
    }

    if (!res.body) {
      yield { type: 'error', message: 'No response body from MiniMax API' };
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
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const json = trimmed.slice(6);
        if (json === '[DONE]') continue;

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(json);
        } catch {
          continue;
        }

        if (event.type === 'content_block_start' && event.content_block) {
          if (event.content_block.type === 'thinking' && event.content_block.thinking) {
            yield { type: 'thinking', content: event.content_block.thinking };
          }
          if (event.content_block.type === 'text' && event.content_block.text) {
            yield { type: 'text', content: event.content_block.text };
            finalOutput += event.content_block.text;
          }
        }

        if (event.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
            yield { type: 'thinking', content: event.delta.thinking };
          }
          if (event.delta.type === 'text_delta' && event.delta.text) {
            yield { type: 'text', content: event.delta.text };
            finalOutput += event.delta.text;
          }
        }

        if (event.type === 'message_start' && event.message?.usage) {
          usage.inputTokens = event.message.usage.input_tokens ?? 0;
        }

        if (event.type === 'message_delta' && event.usage) {
          usage.outputTokens = event.usage.output_tokens ?? 0;
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
