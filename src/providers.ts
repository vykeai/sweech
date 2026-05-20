/**
 * Provider templates with pre-configured settings
 */

export type CLIType = 'claude' | 'codex' | 'kimi';
export type APIFormat = 'anthropic' | 'openai';
export type PricingModel = 'paid' | 'free' | 'metered';

export const CLI_TYPES: readonly CLIType[] = ['claude', 'codex', 'kimi'] as const;

/**
 * Narrow a free-form string from a CLI flag into a CLIType, or `null`
 * if it's invalid. Returns `undefined` when the input is undefined
 * (flag not passed). Callers use the null vs undefined distinction
 * to decide between "unspecified — fall through to default" and
 * "specified but invalid — abort with a clear error".
 */
export function parseCliType(value: string | undefined): CLIType | null | undefined {
  if (value === undefined) return undefined;
  if (CLI_TYPES.includes(value as CLIType)) return value as CLIType;
  return null;
}

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
  pricingModel: PricingModel;
  compatibility: CLIType[]; // Which CLIs support this provider
  apiFormat: APIFormat; // API format (for validation and custom providers)
  isCustom?: boolean; // True for user-defined custom providers
  authOptional?: boolean; // True for local/self-hosted providers that don't require auth
  availableModels?: ModelInfo[]; // Catalog of models this provider supports
}

const PRICING_MODEL_BY_PROVIDER: Record<string, PricingModel> = {
  anthropic: 'paid',
  openai: 'paid',
  minimax: 'paid',
  kimi: 'paid',
  'kimi-coding': 'paid',
  glm: 'paid',
  dashscope: 'paid',
  'dashscope-openai': 'paid',
  openrouter: 'paid',
  'ollama-cloud': 'paid',

  qwen: 'metered',
  'qwen-openai': 'metered',
  deepseek: 'metered',
  'deepseek-openai': 'metered',
  grok: 'metered',
  groq: 'metered',
  gemini: 'metered',
  nvidia: 'metered',

  ollama: 'free',
  'local-ollama': 'free',
  'local-proxy': 'free',
  xortron: 'free',
};

export function isLocalProviderBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl || !baseUrl.trim()) return false;
  let hostname = '';
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    hostname = baseUrl.trim().toLowerCase();
  }
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  );
}

export function classifyPricingModel(provider: {
  name?: string;
  baseUrl?: string;
  pricingModel?: PricingModel;
  isCustom?: boolean;
  authOptional?: boolean;
}): PricingModel {
  if (provider.pricingModel) return provider.pricingModel;
  if (provider.authOptional) return 'free';
  if (provider.isCustom && isLocalProviderBaseUrl(provider.baseUrl)) return 'free';
  if (provider.name && PRICING_MODEL_BY_PROVIDER[provider.name]) return PRICING_MODEL_BY_PROVIDER[provider.name];
  return 'paid';
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
    pricingModel: 'paid',
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
    pricingModel: 'paid',
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
    pricingModel: 'metered',
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
    pricingModel: 'paid',
    compatibility: ['claude'],
    apiFormat: 'anthropic',
    availableModels: [
      { id: 'MiniMax-M2.7',           name: 'MiniMax M2.7',           type: 'reasoning', context: '205k', note: 'Latest, SWE-Pro 56.22' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', type: 'reasoning', context: '205k', note: 'Faster variant' },
      { id: 'MiniMax-M2.5',           name: 'MiniMax M2.5',           type: 'reasoning', context: '205k' },
      { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed', type: 'reasoning', context: '205k' },
      { id: 'MiniMax-M2.1',           name: 'MiniMax M2.1',           type: 'reasoning', context: '205k' },
    ]
  },
  kimi: {
    name: 'kimi',
    displayName: 'Kimi (Moonshot AI)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    defaultModel: 'kimi-k2.6',
    description: 'Moonshot Kimi K2.6 — long-horizon coding, 256K context',
    pricing: '$0.14-$2.49 per million tokens',
    pricingModel: 'paid',
    compatibility: ['claude', 'kimi'],
    apiFormat: 'anthropic',
    availableModels: [
      { id: 'kimi-k2.6',              name: 'Kimi K2.6',              type: 'reasoning', context: '256k', note: 'Latest flagship — long-horizon coding' },
      { id: 'kimi-k2.6-thinking',     name: 'Kimi K2.6 Thinking',     type: 'reasoning', context: '256k', note: 'Deep reasoning variant' },
      { id: 'kimi-k2-turbo-preview',  name: 'Kimi K2 Turbo',          type: 'reasoning', context: '256k', note: 'Fast tier' },
      { id: 'kimi-k2-thinking',       name: 'Kimi K2 Thinking',       type: 'reasoning', context: '256k' },
      { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', type: 'reasoning', context: '256k' },
      { id: 'kimi-k2-0905-preview',   name: 'Kimi K2 (0905)',         type: 'reasoning', context: '256k' },
    ]
  },
  'kimi-coding': {
    name: 'kimi-coding',
    displayName: 'Kimi for Coding (Moonshot AI)',
    baseUrl: 'https://api.kimi.com/coding',
    defaultModel: 'kimi-k2.6',
    description: 'Kimi for Coding subscription — K2.6, 256K context',
    pricing: 'Subscription plan',
    pricingModel: 'paid',
    compatibility: ['claude', 'kimi'],
    apiFormat: 'anthropic',
    availableModels: [
      { id: 'kimi-k2.6',              name: 'Kimi K2.6',              type: 'reasoning', context: '256k', note: 'Latest flagship — best for coding' },
      { id: 'kimi-k2.6-thinking',     name: 'Kimi K2.6 Thinking',     type: 'reasoning', context: '256k', note: 'Deep reasoning variant' },
      { id: 'kimi-k2-turbo-preview',  name: 'Kimi K2 Turbo',          type: 'reasoning', context: '256k', note: 'Fast tier' },
      { id: 'kimi-k2-thinking',       name: 'Kimi K2 Thinking',       type: 'reasoning', context: '256k' },
      { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', type: 'reasoning', context: '256k' },
    ]
  },
  deepseek: {
    name: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-chat',
    smallFastModel: 'deepseek-chat',
    description: 'DeepSeek V3.2 via Anthropic-compatible API',
    pricing: '$0.28-$0.42 per million tokens (lowest cost)',
    pricingModel: 'metered',
    compatibility: ['claude'],
    apiFormat: 'anthropic',
    availableModels: [
      { id: 'deepseek-chat',     name: 'DeepSeek V3.2 (chat)',     type: 'text',      context: '128k', note: 'V3.2 non-thinking — best for coding' },
      { id: 'deepseek-reasoner', name: 'DeepSeek V3.2 (reasoner)', type: 'reasoning', context: '128k', note: 'V3.2 thinking, 64K max output' },
    ]
  },
  glm: {
    name: 'glm',
    displayName: 'GLM (Zhipu/ZAI)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    defaultModel: 'glm-5.1',
    description: 'Zhipu GLM models via z.ai direct API',
    pricing: '$3/month coding plan',
    pricingModel: 'paid',
    compatibility: ['claude'],
    apiFormat: 'anthropic',
    availableModels: [
      // ── Verified on docs.z.ai (2026-04-21) — glm-5-air returns 400 on
      // this endpoint and was removed. ──
      { id: 'glm-5.1',      name: 'GLM-5.1',      type: 'reasoning', context: '200k', note: 'Latest — SOTA SWE-Bench Pro / Terminal-Bench 2.0' },
      { id: 'glm-5',        name: 'GLM-5',        type: 'reasoning', context: '200k', note: 'SWE-bench Verified 77.8, 128K max output' },
      { id: 'glm-4.6',      name: 'GLM-4.6',      type: 'reasoning', context: '200k', note: 'Prior flagship' },
      { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', type: 'vision',    context: '200k', note: 'Vision-capable' },
    ]
  },
  dashscope: {
    name: 'dashscope',
    displayName: 'Alibaba Cloud Coding Plan (Anthropic)',
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: 'qwen3-coder-plus',
    smallFastModel: 'qwen3-coder-flash',
    description: 'Alibaba Coding Plan — Qwen3/Zhipu/Kimi/MiniMax via Anthropic-compat API (sk-sp-... key)',
    pricing: 'Subscription plan',
    pricingModel: 'paid',
    compatibility: ['claude'],
    apiFormat: 'anthropic',
    availableModels: [
      // ── Qwen native — verified on alibabacloud.com/help/en/model-studio/qwen-coder (2026-04-21) ──
      { id: 'qwen3-coder-plus',  name: 'Qwen3 Coder Plus',  type: 'text', context: '1M',   note: 'Max quality — best for complex coding' },
      { id: 'qwen3-coder-next',  name: 'Qwen3 Coder Next',  type: 'text', context: '131k', note: 'Recommended default (quality/speed/cost)' },
      { id: 'qwen3-coder-flash', name: 'Qwen3 Coder Flash', type: 'text', context: '131k', note: 'Cheapest tier' },
      { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max',      type: 'reasoning', context: '131k' },
      // ── Zhipu GLM (bundled) ──
      { id: 'glm-5.1',  name: 'GLM-5.1 (Zhipu)',  type: 'reasoning', context: '200k', note: 'Best GLM on this plan' },
      { id: 'glm-5',    name: 'GLM-5 (Zhipu)',    type: 'reasoning', context: '200k' },
      { id: 'glm-4.6',  name: 'GLM-4.6 (Zhipu)',  type: 'reasoning', context: '200k' },
      // ── Kimi (bundled) ──
      { id: 'kimi-k2.6',             name: 'Kimi K2.6 (Moonshot)',   type: 'reasoning', context: '256k', note: 'Long-horizon coding' },
      { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo (Moonshot)', type: 'reasoning', context: '256k' },
      // ── MiniMax (bundled) ──
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', type: 'reasoning', context: '205k', note: 'Latest MiniMax' },
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
    pricingModel: 'metered',
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
    pricingModel: 'metered',
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
    pricingModel: 'paid',
    compatibility: ['codex'],
    apiFormat: 'openai'
  },
  openrouter: {
    name: 'openrouter',
    displayName: 'OpenRouter (Universal)',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    smallFastModel: 'anthropic/claude-3.5-haiku',
    description: '300+ models: Claude, Gemini, GPT, Grok, Llama, etc.',
    pricing: 'Varies by model',
    pricingModel: 'paid',
    compatibility: ['codex'],
    apiFormat: 'openai',
    availableModels: [
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5',  type: 'reasoning', context: '200k' },
      { id: 'anthropic/claude-opus-4.7',   name: 'Claude Opus 4.7',    type: 'reasoning', context: '1M' },
      { id: 'x-ai/grok-4.20',              name: 'Grok 4.20',          type: 'reasoning', context: '2M',  note: 'xAI flagship' },
      { id: 'x-ai/grok-4-1-fast',          name: 'Grok 4.1 Fast',      type: 'reasoning', context: '2M',  note: 'Fast tier' },
      { id: 'x-ai/grok-code-fast-1',       name: 'Grok Code Fast 1',   type: 'text',      context: '256k', note: 'Coding-tuned' },
      { id: 'openai/gpt-5.4',              name: 'GPT-5.4',            type: 'reasoning', context: '400k' },
      { id: 'google/gemini-3.0-pro',       name: 'Gemini 3.0 Pro',     type: 'reasoning', context: '2M' },
    ]
  },
  grok: {
    name: 'grok',
    displayName: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.20-0309-reasoning',
    smallFastModel: 'grok-4-1-fast-reasoning',
    description: 'xAI Grok — native OpenAI-compatible API (NOT Anthropic-compat; pair with Codex CLI)',
    pricing: 'Pay-per-token; subscription does NOT include API',
    pricingModel: 'metered',
    compatibility: ['codex'],
    apiFormat: 'openai',
    availableModels: [
      { id: 'grok-4.20-0309-reasoning',     name: 'Grok 4.20 (reasoning)',     type: 'reasoning', context: '2M',   note: 'Flagship' },
      { id: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20 (non-reasoning)', type: 'text',      context: '2M' },
      { id: 'grok-4.20-multi-agent-0309',   name: 'Grok 4.20 Multi-Agent',     type: 'reasoning', context: '2M' },
      { id: 'grok-4-1-fast-reasoning',      name: 'Grok 4.1 Fast (reasoning)', type: 'reasoning', context: '2M',   note: 'Fast tier' },
      { id: 'grok-4-1-fast-non-reasoning',  name: 'Grok 4.1 Fast (non-reasoning)', type: 'text',  context: '2M' },
      { id: 'grok-code-fast-1',             name: 'Grok Code Fast 1',          type: 'text',      context: '256k', note: 'Coding-tuned (legacy)' },
    ]
  },

  // ═══════════════════════════════════════════════════════════
  // LOCAL/SELF-HOSTED PROVIDERS
  // ═══════════════════════════════════════════════════════════

  ollama: {
    name: 'ollama',
    displayName: 'Ollama (Local)',
    baseUrl: 'http://localhost:11434',
    defaultModel: '',
    description: 'Local Ollama — no auth required',
    pricing: 'Free (local)',
    pricingModel: 'free',
    compatibility: ['claude', 'codex'],
    apiFormat: 'anthropic',
    authOptional: true,
  },

  // ═══════════════════════════════════════════════════════════
  // CUSTOM PROVIDERS (for localhost, LAN, self-hosted)
  // ═══════════════════════════════════════════════════════════

  custom: {
    name: 'custom',
    displayName: 'Custom Provider',
    baseUrl: '', // User will provide
    defaultModel: '', // User will provide
    description: 'Custom/local LLM (localhost, LAN, or self-hosted)',
    pricing: 'Varies',
    pricingModel: 'paid',
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
 * Display group for UI grouping/labeling.
 *
 * Official providers map to their CLI name ('claude', 'codex').
 * Third-party providers get their display name (e.g. 'Alibaba Cloud', 'MiniMax').
 */
export function displayGroup(providerKey?: string): string {
  if (!providerKey || providerKey === 'anthropic') return 'claude';
  if (providerKey === 'openai') return 'codex';
  if (providerKey === 'kimi' || providerKey === 'kimi-coding') return 'kimi';
  if (providerKey === 'local-proxy') return 'Local Proxy';
  if (providerKey === 'local-ollama') return 'Ollama (Local)';
  const p = PROVIDERS[providerKey];
  return p?.displayName || providerKey;
}

/**
 * Whether a provider key is a third-party (non-official) provider
 */
export function isExternalProvider(providerKey?: string): boolean {
  return !!providerKey && providerKey !== 'anthropic' && providerKey !== 'openai';
}

/**
 * Resolve the *real* upstream provider for a workspace, even when the
 * sweech config's `provider` field stores the API format ('anthropic' /
 * 'openai') rather than the actual vendor.
 *
 * Anthropic/OpenAI with a non-empty baseUrl is by definition a proxy —
 * the real endpoints have hardcoded hosts and reject custom baseUrls,
 * so a baseUrl override means somebody is routing through litellm,
 * z.ai's anthropic-compat endpoint, openrouter, etc. Derive the actual
 * vendor from the host.
 */
export function effectiveProvider(provider?: string, baseUrl?: string): string {
  if (!baseUrl || !baseUrl.trim()) return provider ?? '';

  let host = '';
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { host = baseUrl.toLowerCase(); }

  // Local addresses split into two buckets:
  //   - `local-ollama`: the canonical Ollama daemon (port 11434) or any
  //     local URL the user has tagged as provider=ollama. These are
  //     real Ollama instances, not gateways, and deserve their own
  //     identity in the UI so users can tell at a glance whether the
  //     workspace runs through actual local models vs a litellm-style
  //     compatibility shim sitting on 4000/8000/etc.
  //   - `local-proxy`: anything else on localhost (litellm, openrouter
  //     bridges, vLLM, etc).
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host.endsWith('.local');
  if (isLocal) {
    let port = '';
    try { port = new URL(baseUrl).port; } catch {}
    if (port === '11434' || provider === 'ollama') return 'local-ollama';
    return 'local-proxy';
  }
  if (host.endsWith('z.ai'))                                                    return 'glm';
  if (host.endsWith('kimi.com') || host.endsWith('moonshot.ai'))                return 'kimi-coding';
  if (host.endsWith('minimax.io'))                                              return 'minimax';
  if (host.endsWith('dashscope.aliyuncs.com'))                                  return 'dashscope';
  if (host.endsWith('openrouter.ai'))                                           return 'openrouter';
  if (host.endsWith('googleapis.com'))                                          return 'gemini';
  if (host.endsWith('groq.com'))                                                return 'groq';
  if (host.endsWith('nvidia.com'))                                              return 'nvidia';
  if (host.endsWith('ollama.com'))                                              return 'ollama-cloud';
  if (host.endsWith('deepseek.com'))                                            return 'deepseek';

  // Falls back to whatever the config stored — the host is unknown to us.
  return provider ?? '';
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
