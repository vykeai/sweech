import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';
import { validateBaseUrl } from './validate-url.js';
import { validateHeaders } from './validate-headers.js';

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

/**
 * Generic OpenAI-compatible runner that makes direct HTTP calls.
 * Reads baseUrl, apiKey, and headers from RunOptions — no CLI binary needed.
 */
export class OpenAICompatRunner implements ModelRunner {
  readonly engine = 'http' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
    const startMs = Date.now();

    if (!opts.baseUrl) {
      yield { type: 'error', message: 'OpenAICompatRunner requires opts.baseUrl' };
      return;
    }

    let url: string;
    try {
      url = validateBaseUrl(opts.baseUrl).replace(/\/$/, '');
    } catch (err) {
      yield { type: 'error', message: (err as Error).message };
      return;
    }
    const body = {
      model: opts.model ?? 'default',
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
        { role: 'user' as const, content: prompt },
      ],
      max_tokens: opts.maxTokens ?? 8192,
      stream: true,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.apiKey ? { 'Authorization': `Bearer ${opts.apiKey}` } : {}),
      ...(opts.headers ? validateHeaders(opts.headers) : {}),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts.abortSignal,
    });

    if (!res.ok) {
      const errText = await res.text();
      yield { type: 'error', message: `API error ${res.status}: ${errText}` };
      return;
    }

    if (!res.body) {
      yield { type: 'error', message: 'No response body' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalOutput = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    try {
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
    } finally {
      reader.releaseLock();
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
