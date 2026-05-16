import { loadProfiles } from './middleware/profiles.js';
import { getKey } from './keychain.js';
import type { CredentialProfile } from './middleware/types.js';

export type CheckReason = 'ok' | 'subscription_tier' | 'account_expiry' | 'base_url_down' | 'auth_failed' | 'no_api_key' | 'no_profile';

export interface CheckResult {
  profile: string;
  model: string | null;
  reachable: boolean;
  reason: CheckReason;
  suggestedFallback: string | null;
  checkedAt: string;
  latencyMs: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const checkCache = new Map<string, { result: CheckResult; expiresAt: number }>();

/// Hosts whose base URLs are safe to call from /check probes. Anything
/// outside this list with provider!=local is rejected so a typo in
/// config.json can't redirect a probe to an attacker host. Local
/// proxies (litellm running on 127.0.0.1) are allowed regardless of
/// host because they're explicitly user-administered.
const ALLOWED_PROVIDER_HOSTS = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'api.deepseek.com',
  'api.groq.com',
  'openrouter.ai',
  'api.x.ai',
  'api.mistral.ai',
  'api.cerebras.ai',
  'api.minimax.chat',
  'api.minimax.io',
  'generativelanguage.googleapis.com',
  // Third-party Anthropic-compat + OpenAI-compat endpoints actually in
  // use across our profile zoo. Add more here when new vendors land.
  'api.z.ai',
  'api.kimi.com',
  'platform.moonshot.cn',
  'coding-intl.dashscope.aliyuncs.com',
  'integrate.api.nvidia.com',
  'ollama.com',
]);

function isAllowedBaseUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (ALLOWED_PROVIDER_HOSTS.has(host)) return true;
    // Always allow loopback / link-local for local proxy workspaces.
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return true;
    return false;
  } catch {
    return false;
  }
}

function providerBaseUrl(provider: string, profile: CredentialProfile): string {
  if (profile.baseUrl) {
    const sanitized = profile.baseUrl.replace(/\/+$/, '');
    if (!isAllowedBaseUrl(sanitized)) return '';
    return sanitized;
  }
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com';
    case 'openai': return 'https://api.openai.com';
    case 'deepseek': return 'https://api.deepseek.com';
    case 'groq': return 'https://api.groq.com/openai';
    case 'openrouter': return 'https://openrouter.ai/api';
    case 'xai': return 'https://api.x.ai';
    case 'mistral': return 'https://api.mistral.ai';
    case 'cerebras': return 'https://api.cerebras.ai';
    case 'minimax': return 'https://api.minimax.chat';
    case 'google': return 'https://generativelanguage.googleapis.com';
    default: return '';
  }
}

function providerDefaultModel(provider: string, profile: CredentialProfile): string | null {
  if (profile.model) return profile.model;
  switch (provider) {
    case 'claude': return 'claude-sonnet-4-6-20250514';
    case 'anthropic': return 'claude-sonnet-4-6-20250514';
    case 'openai': return 'gpt-4o';
    case 'codex': return 'gpt-5.5';
    case 'deepseek': return 'deepseek-chat';
    case 'groq': return 'llama-3.3-70b-versatile';
    case 'openrouter': return 'anthropic/claude-sonnet-4-6-20250514';
    case 'xai': return 'grok-3';
    case 'mistral': return 'mistral-large-latest';
    case 'google': return 'gemini-2.5-pro';
    default: return null;
  }
}

async function resolveApiKey(profile: CredentialProfile): Promise<string | null> {
  if (profile.apiKey) return profile.apiKey;
  if (profile.keyInKeychain && profile.commandName) {
    return getKey(profile.commandName);
  }
  if (profile.env) {
    const envKeyNames = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'CEREBRAS_API_KEY', 'MINIMAX_API_KEY', 'GOOGLE_API_KEY'];
    for (const keyName of envKeyNames) {
      if (profile.env[keyName]) return profile.env[keyName];
    }
    // Fallback: any value that looks like an API key (20+ chars, no spaces)
    for (const val of Object.values(profile.env)) {
      if (typeof val === 'string' && val.length >= 20 && !val.includes(' ') && !val.includes('=')) return val;
    }
  }
  return null;
}

function isSubscriptionProvider(provider: string, profile?: { baseUrl?: string }): boolean {
  // Legacy engine names + the CLI's terminology. A workspace with
  // provider=anthropic/openai but a custom baseUrl is a proxy (litellm,
  // openrouter, …), not a subscription — those route through the
  // API-key path so we can still hit /v1/models or /v1/messages.
  if (provider === 'claude' || provider === 'codex') return true;
  if (provider === 'gemini' || provider === 'amazon-q' || provider === 'github' || provider === 'copilot') return true;
  if ((provider === 'anthropic' || provider === 'openai') && !profile?.baseUrl) return true;
  return false;
}

async function checkSubscriptionProvider(profileName: string, profile: CredentialProfile): Promise<CheckResult> {
  const start = Date.now();
  const { execFileSync } = await import('node:child_process');
  const provider = profile.provider;
  const KNOWN_COMMANDS: Record<string, string> = {
    claude: 'claude', anthropic: 'claude',
    codex: 'codex',   openai: 'codex',
    gemini: 'gemini', 'amazon-q': 'q', github: 'gh', copilot: 'copilot',
  };
  const command = KNOWN_COMMANDS[provider];
  if (!command) {
    return {
      profile: profileName,
      model: providerDefaultModel(provider, profile),
      reachable: false,
      reason: 'base_url_down',
      suggestedFallback: null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };
  }

  try {
    execFileSync('which', [command], { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
  } catch {
    return {
      profile: profileName,
      model: providerDefaultModel(provider, profile),
      reachable: false,
      reason: 'base_url_down',
      suggestedFallback: null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };
  }

  return {
    profile: profileName,
    model: providerDefaultModel(provider, profile),
    reachable: true,
    reason: 'ok',
    suggestedFallback: null,
    checkedAt: new Date().toISOString(),
    latencyMs: Date.now() - start,
  };
}

async function checkApiProvider(profileName: string, profile: CredentialProfile): Promise<CheckResult> {
  const start = Date.now();
  const provider = profile.provider;
  const baseUrl = providerBaseUrl(provider, profile);
  const model = providerDefaultModel(provider, profile);

  if (!baseUrl) {
    return {
      profile: profileName,
      model,
      reachable: false,
      reason: 'base_url_down',
      suggestedFallback: null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };
  }

  const apiKey = await resolveApiKey(profile);
  if (!apiKey) {
    return {
      profile: profileName,
      model,
      reachable: false,
      reason: 'no_api_key',
      suggestedFallback: null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };
  }

  // Anthropic uses x-api-key, Google uses x-goog-api-key, others use Bearer auth.
  // Anthropic-format proxies (glm, kimi-coding, dashscope) speak the same
  // /v1/messages contract — detect them so we use the right header + body.
  const ANTHROPIC_FORMAT = new Set(['anthropic', 'glm', 'kimi-coding', 'dashscope']);
  const isAnthropic = ANTHROPIC_FORMAT.has(provider);
  const isGoogle = provider === 'google' || provider === 'gemini';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(isAnthropic
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : isGoogle
        ? { 'x-goog-api-key': apiKey }
        : { 'Authorization': `Bearer ${apiKey}` }),
  };

  // For Anthropic: POST /v1/messages with max_tokens=1
  // For OpenAI-compat: GET /v1/models or GET /v1/models/{model}
  let checkUrl: string;
  let method: string;
  let body: string | undefined;

  if (isAnthropic) {
    checkUrl = `${baseUrl}/v1/messages`;
    method = 'POST';
    body = JSON.stringify({
      model: model ?? 'claude-sonnet-4-6-20250514',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  } else if (provider === 'google') {
    checkUrl = `${baseUrl}/v1beta/models/${model ?? 'gemini-2.5-pro'}`;
    method = 'GET';
  } else {
    // OpenAI-compatible
    checkUrl = model ? `${baseUrl}/v1/models/${model}` : `${baseUrl}/v1/models`;
    method = 'GET';
  }

  try {
    const response = await fetch(checkUrl, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.ok) {
      return {
        profile: profileName,
        model,
        reachable: true,
        reason: 'ok',
        suggestedFallback: null,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
    }

    const responseText = await response.text().catch(() => '');
    let reason: CheckReason = 'base_url_down';

    if (response.status === 401 || response.status === 403) {
      reason = 'auth_failed';
    } else if (response.status === 404) {
      reason = 'subscription_tier';
    } else if (response.status === 429) {
      // Rate limit means the auth works but quota is exhausted
      reason = 'subscription_tier';
    } else if (response.status >= 500) {
      reason = 'base_url_down';
    } else if (response.status === 400) {
      const body = responseText.toLowerCase();
      if (body.includes('invalid') && body.includes('api')) {
        reason = 'auth_failed';
      } else if (body.includes('expired')) {
        reason = 'account_expiry';
      }
    }

    return {
      profile: profileName,
      model,
      reachable: false,
      reason,
      suggestedFallback: null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      profile: profileName,
      model,
      reachable: false,
      reason: 'base_url_down',
      suggestedFallback: null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };
  }
}

export function clearCheckCache(): void {
  checkCache.clear();
}

export async function checkProfile(profileName: string): Promise<CheckResult> {
  // Check cache
  const cached = checkCache.get(profileName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const profiles = await loadProfiles();
  const profile = profiles[profileName];

  if (!profile) {
    const result: CheckResult = {
      profile: profileName,
      model: null,
      reachable: false,
      reason: 'no_profile',
      suggestedFallback: null,
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
    };
    return result;
  }

  const provider = profile.provider;
  let result: CheckResult;

  if (isSubscriptionProvider(provider, profile)) {
    result = await checkSubscriptionProvider(profileName, profile);
  } else {
    result = await checkApiProvider(profileName, profile);
  }

  // Find suggested fallback from same provider family
  if (!result.reachable) {
    const allProfiles = Object.entries(profiles);
    const sameProvider = allProfiles.find(([name, p]) =>
      name !== profileName && p.provider === provider
    );
    if (sameProvider) {
      result = { ...result, suggestedFallback: sameProvider[0] };
    }
  }

  // Cache result
  checkCache.set(profileName, { result, expiresAt: Date.now() + CACHE_TTL_MS });

  return result;
}

export async function checkAllProfiles(): Promise<CheckResult[]> {
  const profiles = await loadProfiles();
  const names = Object.keys(profiles);
  // Check in batches of 10 to avoid flooding external APIs
  const BATCH_SIZE = 10;
  const results: CheckResult[] = [];
  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(name => checkProfile(name)));
    results.push(...batchResults);
  }
  return results;
}
