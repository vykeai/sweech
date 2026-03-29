/**
 * Provider templates with pre-configured settings
 */

export type CLIType = 'claude' | 'codex';
export type APIFormat = 'anthropic' | 'openai';

export interface ModelInfo {
  id: string;
  name: string;
  type?: string;       // e.g. 'reasoning', 'text', 'vision'
  context?: string;    // e.g. '128k', '200k'
  note?: string;       // e.g. 'Free tier', 'Best quality'
}

export interface ProviderConfig {
  name: string;
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  smallFastModel?: string;
  description: string;
  pricing?: string;
  compatibility: CLIType[]; // Which CLIs support this provider
  apiFormat: APIFormat; // API format (for validation and custom providers)
  isCustom?: boolean; // True for user-defined custom providers
  availableModels?: ModelInfo[]; // Catalog of models this provider supports
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  // ═══════════════════════════════════════════════════════════
  // ANTHROPIC-COMPATIBLE PROVIDERS (for Claude CLI)
  // ═══════════════════════════════════════════════════════════

  anthropic: {
    name: 'anthropic',
    displayName: 'Claude (Anthropic)',
    baseUrl: '', // Uses default
    defaultModel: 'claude-sonnet-4-6',
    smallFastModel: 'claude-haiku-4-5-20251001',
    description: 'Official Anthropic Claude models',
    pricing: 'Varies by model',
    compatibility: ['claude'],
    apiFormat: 'anthropic'
  },

  // ═══════════════════════════════════════════════════════════
  // OPENAI PROVIDER (for Codex CLI)
  // ═══════════════════════════════════════════════════════════

  openai: {
    name: 'openai',
    displayName: 'OpenAI',
    baseUrl: '', // Uses default
    defaultModel: 'gpt-5.4',
    description: 'Official OpenAI models via Codex CLI',
    pricing: 'ChatGPT Plus/Pro subscription',
    compatibility: ['codex'],
    apiFormat: 'openai'
  },
  qwen: {
    name: 'qwen',
    displayName: 'Qwen (Alibaba)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen-plus',
    smallFastModel: 'qwen-flash',
    description: 'Alibaba Qwen models via DashScope Anthropic API',
    pricing: '$0.14-$2.49 per million tokens',
    compatibility: ['claude'],
    apiFormat: 'anthropic'
  },
  minimax: {
    name: 'minimax',
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    defaultModel: 'MiniMax-M2.7',
    description: 'MiniMax coding models',
    pricing: '$10/month coding plan',
    compatibility: ['claude'],
    apiFormat: 'anthropic',
    availableModels: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', type: 'reasoning', context: '200k', note: 'Latest, best quality' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', type: 'reasoning', context: '200k' },
    ]
  },
  kimi: {
    name: 'kimi',
    displayName: 'Kimi K2 (Moonshot AI)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    defaultModel: 'kimi-k2-turbo-preview',
    description: 'Moonshot AI Kimi K2 with 256K context',
    pricing: '$0.14-$2.49 per million tokens',
    compatibility: ['claude'],
    apiFormat: 'anthropic'
  },
  'kimi-coding': {
    name: 'kimi-coding',
    displayName: 'Kimi for Coding (Moonshot AI)',
    baseUrl: 'https://api.kimi.com/coding',
    defaultModel: 'kimi-for-coding',
    description: 'Kimi for Coding plan — 262K context, 32K output',
    pricing: 'Subscription plan',
    compatibility: ['claude'],
    apiFormat: 'anthropic',
    availableModels: [
      { id: 'kimi-for-coding', name: 'Kimi for Coding (k2p5)', type: 'reasoning', context: '262k', note: '32K output, vision support' },
    ]
  },
  deepseek: {
    name: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-chat',
    description: 'DeepSeek via Anthropic-compatible API',
    pricing: '$0.28-$0.42 per million tokens (lowest cost)',
    compatibility: ['claude'],
    apiFormat: 'anthropic'
  },
  glm: {
    name: 'glm',
    displayName: 'GLM (Zhipu/ZAI)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    defaultModel: 'glm-5.1',
    description: 'Zhipu GLM models via z.ai direct API',
    pricing: '$3/month coding plan',
    compatibility: ['claude'],
    apiFormat: 'anthropic',
    availableModels: [
      // ── Reasoning / Language ──
      { id: 'glm-5.1', name: 'GLM-5.1', type: 'reasoning', context: '128k', note: 'Latest, best quality' },
      { id: 'glm-5', name: 'GLM-5', type: 'reasoning', context: '128k', note: 'Deep thinking' },
      { id: 'glm-4.7', name: 'GLM-4.7', type: 'reasoning', context: '128k', note: 'Strong general' },
      { id: 'glm-4.7-flash', name: 'GLM-4.7 Flash', type: 'reasoning', context: '128k', note: 'Free tier' },
      { id: 'glm-4.7-flashx', name: 'GLM-4.7 FlashX', type: 'text', context: '128k' },
      { id: 'glm-4.5', name: 'GLM-4.5', type: 'text', context: '128k' },
      { id: 'glm-4.5-air', name: 'GLM-4.5 Air', type: 'text', context: '128k' },
      { id: 'glm-4.5-airx', name: 'GLM-4.5 AirX', type: 'text', context: '128k' },
      { id: 'glm-4.5-flash', name: 'GLM-4.5 Flash', type: 'text', context: '128k' },
      { id: 'glm-4-plus', name: 'GLM-4 Plus', type: 'text', context: '128k' },
      // ── Vision ──
      { id: 'glm-4v-plus', name: 'GLM-4V Plus', type: 'vision', context: '128k' },
      { id: 'glm-4v', name: 'GLM-4V', type: 'vision', context: '128k' },
      { id: 'glm-4v-flash', name: 'GLM-4V Flash', type: 'vision', context: '128k' },
      // ── OCR ──
      { id: 'glm-ocr', name: 'GLM OCR', type: 'ocr', context: '128k' },
    ]
  },
  dashscope: {
    name: 'dashscope',
    displayName: 'Alibaba Cloud Coding Plan (Anthropic)',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen3-coder-next',
    smallFastModel: 'qwen3-coder-plus',
    description: 'Alibaba Coding Plan — Qwen3/Zhipu/Kimi/MiniMax via Anthropic-compat API (sk-sp-... key)',
    pricing: 'Subscription plan',
    compatibility: ['claude'],
    apiFormat: 'anthropic',
    availableModels: [
      // ── Qwen (native) ──
      { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next', type: 'text', context: '131k', note: 'Latest Qwen coder' },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', type: 'text', context: '131k' },
      { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max', type: 'reasoning', context: '131k' },
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', type: 'reasoning+vision', context: '131k', note: 'Vision support' },
      // ── Zhipu GLM (bundled) ──
      { id: 'glm-5.1', name: 'GLM-5.1 (Zhipu)', type: 'reasoning', context: '131k', note: 'Latest GLM' },
      { id: 'glm-5', name: 'GLM-5 (Zhipu)', type: 'reasoning', context: '131k' },
      { id: 'glm-4.7', name: 'GLM-4.7 (Zhipu)', type: 'reasoning', context: '131k' },
      // ── Kimi (bundled) ──
      { id: 'kimi-k2.5', name: 'Kimi K2.5 (Moonshot)', type: 'reasoning+vision', context: '131k', note: 'Vision support' },
      // ── MiniMax (bundled) ──
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', type: 'reasoning', context: '200k', note: 'Long context' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', type: 'reasoning', context: '200k' },
    ]
  },

  // ═══════════════════════════════════════════════════════════
  // OPENAI-COMPATIBLE PROVIDERS (for Codex CLI)
  // ═══════════════════════════════════════════════════════════

  'deepseek-openai': {
    name: 'deepseek-openai',
    displayName: 'DeepSeek (OpenAI)',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    smallFastModel: 'deepseek-reasoner',
    description: 'DeepSeek via native OpenAI-compatible API',
    pricing: '$0.28-$0.42 per million tokens (lowest cost)',
    compatibility: ['codex'],
    apiFormat: 'openai'
  },
  'qwen-openai': {
    name: 'qwen-openai',
    displayName: 'Qwen (OpenAI)',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    smallFastModel: 'qwen-turbo',
    description: 'Alibaba Qwen via OpenAI-compatible DashScope API',
    pricing: '$0.14-$2.49 per million tokens',
    compatibility: ['codex'],
    apiFormat: 'openai'
  },
  'dashscope-openai': {
    name: 'dashscope-openai',
    displayName: 'Alibaba Cloud Coding Plan (OpenAI)',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    defaultModel: 'qwen3-coder-next',
    smallFastModel: 'qwen3-coder-plus',
    description: 'Alibaba Coding Plan — Qwen3/Zhipu/Kimi/MiniMax via OpenAI-compat API (sk-sp-... key)',
    pricing: 'Subscription plan',
    compatibility: ['codex'],
    apiFormat: 'openai'
  },
  openrouter: {
    name: 'openrouter',
    displayName: 'OpenRouter (Universal)',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    smallFastModel: 'anthropic/claude-3.5-haiku',
    description: '300+ models: Claude, Gemini, GPT, Llama, etc.',
    pricing: 'Varies by model',
    compatibility: ['codex'],
    apiFormat: 'openai'
  },

  // ═══════════════════════════════════════════════════════════
  // CUSTOM/LOCAL PROVIDERS (for localhost, LAN, self-hosted)
  // ═══════════════════════════════════════════════════════════

  custom: {
    name: 'custom',
    displayName: 'Custom Provider',
    baseUrl: '', // User will provide
    defaultModel: '', // User will provide
    description: 'Custom/local LLM (localhost, LAN, or self-hosted)',
    pricing: 'Varies',
    compatibility: ['claude', 'codex'], // User chooses API format
    apiFormat: 'openai', // Default, user can change
    isCustom: true
  }
};

/**
 * Get all providers, optionally filtered by CLI type
 */
export function getProviderList(cliType?: CLIType): Array<{ name: string; value: string }> {
  const providers = Object.values(PROVIDERS);
  const filtered = cliType
    ? providers.filter(p => p.compatibility.includes(cliType))
    : providers;

  return filtered.map(p => ({
    name: `${p.displayName} - ${p.description}`,
    value: p.name
  }));
}

/**
 * Get providers compatible with a specific CLI
 */
export function getProvidersForCLI(cliType: CLIType): ProviderConfig[] {
  return Object.values(PROVIDERS).filter(p => p.compatibility.includes(cliType));
}

/**
 * Get a specific provider by name
 */
export function getProvider(name: string): ProviderConfig | undefined {
  return PROVIDERS[name];
}

/**
 * Check if a provider is compatible with a CLI
 */
export function isProviderCompatible(providerName: string, cliType: CLIType): boolean {
  const provider = PROVIDERS[providerName];
  return provider ? provider.compatibility.includes(cliType) : false;
}

/**
 * Get providers grouped by API format
 */
export function getProvidersByFormat(): Record<APIFormat, ProviderConfig[]> {
  const grouped: Record<APIFormat, ProviderConfig[]> = {
    anthropic: [],
    openai: []
  };

  Object.values(PROVIDERS).forEach(p => {
    grouped[p.apiFormat].push(p);
  });

  return grouped;
}
