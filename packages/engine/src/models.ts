/**
 * Curated model options with UI-relevant capabilities.
 * Drives ModelSelect in @omnai/ui — products can filter or extend this list.
 */

export type CostTier = 'free' | 'cheap' | 'mid' | 'premium';

export interface ModelOption {
  id: string;
  label: string;
  /** Provider family — for grouping in selectors */
  provider: 'anthropic' | 'openai' | 'google' | 'deepseek' | 'mistral' | 'xai' | 'qwen' | 'zhipu' | 'kimi' | 'minimax' | 'other';
  supportsEffort: boolean;
  supportsThinking: boolean;
  /** Context window size in tokens */
  contextWindow: number;
  /** Maximum output tokens */
  maxOutput: number;
  supportsToolUse: boolean;
  supportsVision: boolean;
  costTier: CostTier;
}

export const MODEL_OPTIONS: ModelOption[] = [
  // Anthropic
  { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',     provider: 'anthropic', supportsEffort: true,  supportsThinking: true,  contextWindow: 200000,  maxOutput: 32000,  supportsToolUse: true,  supportsVision: true,  costTier: 'premium' },
  { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6',   provider: 'anthropic', supportsEffort: true,  supportsThinking: true,  contextWindow: 200000,  maxOutput: 16000,  supportsToolUse: true,  supportsVision: true,  costTier: 'mid' },
  { id: 'claude-haiku-4-5',          label: 'Claude Haiku 4.5',    provider: 'anthropic', supportsEffort: true,  supportsThinking: false, contextWindow: 200000,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: true,  costTier: 'cheap' },
  // OpenAI
  { id: 'gpt-4o',                    label: 'GPT-4o',              provider: 'openai',    supportsEffort: false, supportsThinking: false, contextWindow: 128000,  maxOutput: 16384,  supportsToolUse: true,  supportsVision: true,  costTier: 'mid' },
  { id: 'gpt-4o-mini',               label: 'GPT-4o mini',         provider: 'openai',    supportsEffort: false, supportsThinking: false, contextWindow: 128000,  maxOutput: 16384,  supportsToolUse: true,  supportsVision: true,  costTier: 'cheap' },
  { id: 'gpt-4.1',                   label: 'GPT-4.1',             provider: 'openai',    supportsEffort: false, supportsThinking: false, contextWindow: 1047576, maxOutput: 32768,  supportsToolUse: true,  supportsVision: true,  costTier: 'mid' },
  { id: 'gpt-4.1-mini',              label: 'GPT-4.1 Mini',        provider: 'openai',    supportsEffort: false, supportsThinking: false, contextWindow: 1047576, maxOutput: 32768,  supportsToolUse: true,  supportsVision: true,  costTier: 'cheap' },
  { id: 'gpt-4.1-nano',              label: 'GPT-4.1 Nano',        provider: 'openai',    supportsEffort: false, supportsThinking: false, contextWindow: 1047576, maxOutput: 32768,  supportsToolUse: true,  supportsVision: true,  costTier: 'cheap' },
  { id: 'o3',                        label: 'o3',                  provider: 'openai',    supportsEffort: false, supportsThinking: true,  contextWindow: 200000,  maxOutput: 100000, supportsToolUse: true,  supportsVision: true,  costTier: 'premium' },
  { id: 'o4-mini',                   label: 'o4-mini',             provider: 'openai',    supportsEffort: false, supportsThinking: true,  contextWindow: 200000,  maxOutput: 100000, supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  { id: 'codex-mini',                label: 'Codex Mini',          provider: 'openai',    supportsEffort: false, supportsThinking: false, contextWindow: 200000,  maxOutput: 16384,  supportsToolUse: true,  supportsVision: false, costTier: 'mid' },
  // Google
  { id: 'gemini-2.5-pro',            label: 'Gemini 2.5 Pro',      provider: 'google',    supportsEffort: false, supportsThinking: true,  contextWindow: 1048576, maxOutput: 65536,  supportsToolUse: true,  supportsVision: true,  costTier: 'mid' },
  { id: 'gemini-2.5-flash',          label: 'Gemini 2.5 Flash',    provider: 'google',    supportsEffort: false, supportsThinking: false, contextWindow: 1048576, maxOutput: 65536,  supportsToolUse: true,  supportsVision: true,  costTier: 'cheap' },
  { id: 'gemini-2.0-flash',          label: 'Gemini 2.0 Flash',    provider: 'google',    supportsEffort: false, supportsThinking: false, contextWindow: 1048576, maxOutput: 8192,   supportsToolUse: true,  supportsVision: true,  costTier: 'cheap' },
  // DeepSeek
  { id: 'deepseek-chat',             label: 'DeepSeek Chat',       provider: 'deepseek',  supportsEffort: false, supportsThinking: false, contextWindow: 128000,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  { id: 'deepseek-reasoner',         label: 'DeepSeek Reasoner',   provider: 'deepseek',  supportsEffort: false, supportsThinking: true,  contextWindow: 128000,  maxOutput: 8192,   supportsToolUse: false, supportsVision: false, costTier: 'cheap' },
  // Mistral
  { id: 'mistral-large',             label: 'Mistral Large',       provider: 'mistral',   supportsEffort: false, supportsThinking: false, contextWindow: 128000,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'mid' },
  { id: 'codestral',                 label: 'Codestral',           provider: 'mistral',   supportsEffort: false, supportsThinking: false, contextWindow: 256000,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  // xAI
  { id: 'grok-3',                    label: 'Grok 3',              provider: 'xai',       supportsEffort: false, supportsThinking: false, contextWindow: 131072,  maxOutput: 16384,  supportsToolUse: true,  supportsVision: true,  costTier: 'mid' },
  { id: 'grok-3-mini',               label: 'Grok 3 Mini',         provider: 'xai',       supportsEffort: false, supportsThinking: true,  contextWindow: 131072,  maxOutput: 16384,  supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  // Alibaba / DashScope (via https://coding-intl.dashscope.aliyuncs.com/v1 — OpenAI-compat)
  { id: 'qwen3.5-plus',              label: 'Qwen 3.5 Plus',       provider: 'qwen',      supportsEffort: false, supportsThinking: true,  contextWindow: 131072,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  { id: 'qwen3-max-2026-01-23',      label: 'Qwen 3 Max',          provider: 'qwen',      supportsEffort: false, supportsThinking: true,  contextWindow: 131072,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  { id: 'qwen3-coder-next',          label: 'Qwen 3 Coder Next',   provider: 'qwen',      supportsEffort: false, supportsThinking: false, contextWindow: 131072,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  { id: 'qwen3-coder-plus',          label: 'Qwen 3 Coder Plus',   provider: 'qwen',      supportsEffort: false, supportsThinking: false, contextWindow: 131072,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  // Zhipu (via ZAI API or DashScope)
  { id: 'glm-5',                     label: 'GLM-5',               provider: 'zhipu',     supportsEffort: false, supportsThinking: true,  contextWindow: 131072,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  { id: 'glm-4.7',                   label: 'GLM-4.7',             provider: 'zhipu',     supportsEffort: false, supportsThinking: true,  contextWindow: 131072,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  { id: 'glm-4.7-flash',            label: 'GLM-4.7 Flash',       provider: 'zhipu',     supportsEffort: false, supportsThinking: false, contextWindow: 131072,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'free' },
  // Kimi / Moonshot (Anthropic Messages API)
  { id: 'kimi-k2.5',                 label: 'Kimi K2.5',           provider: 'kimi',      supportsEffort: false, supportsThinking: true,  contextWindow: 131072,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  { id: 'kimi-for-coding',           label: 'Kimi for Coding',     provider: 'kimi',      supportsEffort: false, supportsThinking: true,  contextWindow: 262144,  maxOutput: 32768,  supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
  // MiniMax (Anthropic Messages API)
  { id: 'MiniMax-M2.5',              label: 'MiniMax M2.5',        provider: 'minimax',   supportsEffort: false, supportsThinking: true,  contextWindow: 200000,  maxOutput: 8192,   supportsToolUse: true,  supportsVision: false, costTier: 'cheap' },
];

export function getModelOption(id: string): ModelOption | undefined {
  return MODEL_OPTIONS.find(m => m.id === id);
}

/** Returns capabilities for a model ID, defaulting to safe fallbacks if unknown */
export function getModelCapabilities(id: string): Pick<ModelOption, 'supportsEffort' | 'supportsThinking' | 'contextWindow' | 'maxOutput' | 'supportsToolUse' | 'supportsVision' | 'costTier'> {
  const m = getModelOption(id);
  return {
    supportsEffort: m?.supportsEffort ?? false,
    supportsThinking: m?.supportsThinking ?? false,
    contextWindow: m?.contextWindow ?? 128000,
    maxOutput: m?.maxOutput ?? 4096,
    supportsToolUse: m?.supportsToolUse ?? false,
    supportsVision: m?.supportsVision ?? false,
    costTier: m?.costTier ?? 'mid',
  };
}
