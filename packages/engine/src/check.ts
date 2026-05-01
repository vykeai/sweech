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

function providerBaseUrl(provider: string, profile: CredentialProfile): string {
  if (profile.baseUrl) return profile.baseUrl.replace(/\/+$/, '');
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
    for (const val of Object.values(profile.env)) {
      if (val.startsWith('sk-') || val.startsWith('sk-ant-')) return val;
    }
  }
  return null;
}

function isSubscriptionProvider(provider: string): boolean {
  return provider === 'claude' || provider === 'codex' || provider === 'gemini' || provider === 'amazon-q' || provider === 'github' || provider === 'copilot';
}

async function checkSubscriptionProvider(profileName: string, profile: CredentialProfile): Promise<CheckResult> {
  const start = Date.now();
  // Subscription providers (Claude Code, Codex CLI) don't have REST APIs to check.
  // We check if the CLI binary is installed and if the config directory exists.
  const { execFileSync } = await import('node:child_process');
  const provider = profile.provider;
  let command = provider;
  if (provider === 'claude') command = 'claude';
  else if (provider === 'codex') command = 'codex';
  else if (provider === 'gemini') command = 'gemini';

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

  // Anthropic uses x-api-key, others use Bearer auth
  const isAnthropic = provider === 'anthropic';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(isAnthropic
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
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
    checkUrl = `${baseUrl}/v1beta/models/${model ?? 'gemini-2.5-pro'}?key=${apiKey}`;
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
      // Rate limit means the key works but tier may be exhausted
      const body = responseText.toLowerCase();
      if (body.includes('exceeded') || body.includes('quota') || body.includes('limit')) {
        reason = 'subscription_tier';
      } else {
        reason = 'ok';
      }
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
      reachable: reason === 'ok',
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

  if (isSubscriptionProvider(provider)) {
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
  const results: CheckResult[] = [];
  for (const name of Object.keys(profiles)) {
    results.push(await checkProfile(name));
  }
  return results;
}
