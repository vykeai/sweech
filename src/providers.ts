/**
 * Provider templates with pre-configured settings
 */

export type CLIType = 'claude' | 'codex' | 'cursor' | 'windsurf' | 'aider' | 'gemini' | 'amazonq';
export type APIFormat = 'anthropic' | 'openai';

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
    compatibility: ['claude', 'cursor', 'windsurf', 'aider'],
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
    compatibility: ['codex', 'aider'],
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
    compatibility: ['claude', 'cursor', 'windsurf', 'aider'],
    apiFormat: 'anthropic'
  },
  minimax: {
    name: 'minimax',
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    defaultModel: 'MiniMax-M2',
    description: 'MiniMax M2 coding model',
    pricing: '$10/month coding plan',
    compatibility: ['claude', 'cursor', 'windsurf', 'aider'],
    apiFormat: 'anthropic'
  },
  kimi: {
    name: 'kimi',
    displayName: 'Kimi K2 (Moonshot AI)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    defaultModel: 'kimi-k2-turbo-preview',
    description: 'Moonshot AI Kimi K2 with 256K context',
    pricing: '$0.14-$2.49 per million tokens',
    compatibility: ['claude', 'cursor', 'windsurf', 'aider'],
    apiFormat: 'anthropic'
  },
  deepseek: {
    name: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-chat',
    description: 'DeepSeek via Anthropic-compatible API',
    pricing: '$0.28-$0.42 per million tokens (lowest cost)',
    compatibility: ['claude', 'cursor', 'windsurf', 'aider'],
    apiFormat: 'anthropic'
  },
  glm: {
    name: 'glm',
    displayName: 'GLM 4.6 (Zhipu/ZAI)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    defaultModel: 'glm-4-plus',
    description: 'Zhipu GLM 4.6 models',
    pricing: '$3/month coding plan',
    compatibility: ['claude', 'cursor', 'windsurf', 'aider'],
    apiFormat: 'anthropic'
  },
  dashscope: {
    name: 'dashscope',
    displayName: 'Alibaba Cloud Coding Plan (Anthropic)',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen3-coder-next',
    smallFastModel: 'qwen3-coder-plus',
    description: 'Alibaba Coding Plan — Qwen3/Zhipu/Kimi/MiniMax via Anthropic-compat API (sk-sp-... key)',
    pricing: 'Subscription plan',
    compatibility: ['claude', 'cursor', 'windsurf', 'aider'],
    apiFormat: 'anthropic'
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
    compatibility: ['codex', 'aider'],
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
    compatibility: ['codex', 'aider'],
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
    compatibility: ['codex', 'aider'],
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
    compatibility: ['codex', 'aider'],
    apiFormat: 'openai'
  },

  // ═══════════════════════════════════════════════════════════
  // GOOGLE / GEMINI PROVIDERS
  // ═══════════════════════════════════════════════════════════

  google: {
    name: 'google',
    displayName: 'Google (Gemini)',
    baseUrl: '', // Uses default
    defaultModel: 'gemini-2.5-pro',
    description: 'Official Google Gemini models',
    pricing: 'Varies by model',
    compatibility: ['gemini'],
    apiFormat: 'openai'
  },

  // ═══════════════════════════════════════════════════════════
  // AWS / AMAZON PROVIDERS
  // ═══════════════════════════════════════════════════════════

  bedrock: {
    name: 'bedrock',
    displayName: 'Amazon Bedrock',
    baseUrl: '', // Uses default
    defaultModel: 'anthropic.claude-sonnet-4-6-v1:0',
    description: 'AWS Bedrock managed AI models',
    pricing: 'AWS pay-per-use',
    compatibility: ['amazonq'],
    apiFormat: 'anthropic'
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
    compatibility: ['claude', 'codex', 'cursor', 'windsurf', 'aider', 'gemini', 'amazonq'], // User chooses API format
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
