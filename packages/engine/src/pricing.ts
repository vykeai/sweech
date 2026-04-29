import type { TokenUsage } from './types.js';

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Cache read cost per 1M tokens */
  cachePer1M?: number;
  /** Cache write (creation) cost per 1M tokens */
  cacheWritePer1M?: number;
}

export const PRICING: Record<string, ModelPricing> = {
  // Anthropic (cache read = 10% of input, cache write = 125% of input)
  'claude-opus-4-6':         { inputPer1M: 15,   outputPer1M: 75,   cachePer1M: 1.5,    cacheWritePer1M: 18.75 },
  'claude-sonnet-4-6':       { inputPer1M: 3,    outputPer1M: 15,   cachePer1M: 0.3,    cacheWritePer1M: 3.75 },
  'claude-haiku-4-5':        { inputPer1M: 0.80, outputPer1M: 4,    cachePer1M: 0.08,   cacheWritePer1M: 1.0 },
  // Aliases
  'opus':   { inputPer1M: 15,   outputPer1M: 75,   cachePer1M: 1.5,    cacheWritePer1M: 18.75 },
  'sonnet': { inputPer1M: 3,    outputPer1M: 15,   cachePer1M: 0.3,    cacheWritePer1M: 3.75 },
  'haiku':  { inputPer1M: 0.80, outputPer1M: 4,    cachePer1M: 0.08,   cacheWritePer1M: 1.0 },
  // OpenAI
  'gpt-4o':                  { inputPer1M: 2.50, outputPer1M: 10 },
  'gpt-4o-mini':             { inputPer1M: 0.15, outputPer1M: 0.60 },
  'gpt-4.1':                 { inputPer1M: 2,    outputPer1M: 8 },
  'gpt-4.1-mini':            { inputPer1M: 0.40, outputPer1M: 1.60 },
  'gpt-4.1-nano':            { inputPer1M: 0.10, outputPer1M: 0.40 },
  'o3':                      { inputPer1M: 10,   outputPer1M: 40 },
  'o3-mini':                 { inputPer1M: 1.10, outputPer1M: 4.40 },
  'o4-mini':                 { inputPer1M: 1.10, outputPer1M: 4.40 },
  'codex-mini':              { inputPer1M: 1.50, outputPer1M: 6 },
  // Google
  'gemini-2.5-pro':          { inputPer1M: 1.25, outputPer1M: 10 },
  'gemini-2.5-flash':        { inputPer1M: 0.15, outputPer1M: 0.60 },
  'gemini-2.0-flash':        { inputPer1M: 0.10, outputPer1M: 0.40 },
  // DeepSeek
  'deepseek-chat':           { inputPer1M: 0.27, outputPer1M: 1.10 },
  'deepseek-reasoner':       { inputPer1M: 0.55, outputPer1M: 2.19 },
  // Mistral
  'mistral-large':           { inputPer1M: 2,    outputPer1M: 6 },
  'codestral':               { inputPer1M: 0.30, outputPer1M: 0.90 },
  // xAI
  'grok-3':                  { inputPer1M: 3,    outputPer1M: 15 },
  'grok-3-mini':             { inputPer1M: 0.30, outputPer1M: 0.50 },
  // Alibaba / DashScope — https://www.alibabacloud.com/en/solutions/generative-ai/qwen (USD pricing)
  'qwen3.5-plus':              { inputPer1M: 0.50,  outputPer1M: 2.0 },
  'qwen3-max-2026-01-23':      { inputPer1M: 1.10,  outputPer1M: 4.40 },
  'qwen3-coder-next':          { inputPer1M: 0.50,  outputPer1M: 2.0 },
  'qwen3-coder-plus':          { inputPer1M: 0.25,  outputPer1M: 1.0 },
  // Zhipu (via ZAI API or DashScope)
  'glm-5':                     { inputPer1M: 1.0,   outputPer1M: 4.0 },
  'glm-4.7':                   { inputPer1M: 0.50,  outputPer1M: 2.0 },
  'glm-4.7-flash':             { inputPer1M: 0,     outputPer1M: 0 },  // free tier
  // Kimi / Moonshot (Anthropic Messages API)
  'kimi-k2.5':                 { inputPer1M: 0.15,  outputPer1M: 2.50 },
  'kimi-for-coding':           { inputPer1M: 0.15,  outputPer1M: 2.50 },
  // MiniMax (Anthropic Messages API)
  'MiniMax-M2.5':              { inputPer1M: 0.80,  outputPer1M: 3.0 },
  // OpenAI (via Copilot)
  'gpt-5.4':                 { inputPer1M: 2.50, outputPer1M: 10 },
  'gpt-5.3-codex':           { inputPer1M: 2,    outputPer1M: 8 },
  'gpt-5.2-codex':           { inputPer1M: 2,    outputPer1M: 8 },
  'gpt-5.2':                 { inputPer1M: 2,    outputPer1M: 8 },
  'gpt-5.1-codex':           { inputPer1M: 1.50, outputPer1M: 6 },
  'gpt-5.1-codex-max':       { inputPer1M: 3,    outputPer1M: 12 },
  'gpt-5.1':                 { inputPer1M: 1.50, outputPer1M: 6 },
  'gpt-5.1-codex-mini':      { inputPer1M: 0.40, outputPer1M: 1.60 },
  'gpt-5-mini':              { inputPer1M: 0.40, outputPer1M: 1.60 },
  // Copilot model name aliases (dot-separated)
  'claude-opus-4.6':         { inputPer1M: 15,   outputPer1M: 75,   cachePer1M: 1.5,    cacheWritePer1M: 18.75 },
  'claude-sonnet-4.6':       { inputPer1M: 3,    outputPer1M: 15,   cachePer1M: 0.3,    cacheWritePer1M: 3.75 },
  'claude-haiku-4.5':        { inputPer1M: 0.80, outputPer1M: 4,    cachePer1M: 0.08,   cacheWritePer1M: 1.0 },
  'gemini-3-pro-preview':    { inputPer1M: 1.25, outputPer1M: 10 },
};

export function estimateCost(usage: TokenUsage, model: string): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;

  let cost = (usage.inputTokens / 1_000_000) * pricing.inputPer1M
           + (usage.outputTokens / 1_000_000) * pricing.outputPer1M;

  if (pricing.cachePer1M && usage.cacheReadTokens) {
    cost += (usage.cacheReadTokens / 1_000_000) * pricing.cachePer1M;
  }
  if (pricing.cacheWritePer1M && usage.cacheWriteTokens) {
    cost += (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWritePer1M;
  }

  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal precision
}
