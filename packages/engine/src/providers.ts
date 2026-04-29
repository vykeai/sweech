import { readFile, writeFile, mkdir, stat, watch } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parse, stringify } from 'yaml';
import type { Provider } from './types.js';

export interface RateLimitDef {
  rpm?: number;
  rpd?: number;
  concurrent?: number;
}

export interface QuotaDef {
  period: 'daily' | 'weekly' | 'monthly';
  limit?: number;
  softLimit?: number;
}

export interface ProviderAccount {
  provider: Provider;
  type: 'subscription' | 'api-key' | 'free-tier';
  apiKeyEnv?: string;
  baseUrl?: string;
  models: string[];
  rateLimit?: RateLimitDef;
  quota?: QuotaDef;
  tags?: string[];
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface ProvidersConfig {
  version: number;
  failoverOrder: string[];
  accounts: Record<string, ProviderAccount>;
}

const VALID_TYPES = ['subscription', 'api-key', 'free-tier'] as const;
const VALID_PERIODS = ['daily', 'weekly', 'monthly'] as const;

export function getProvidersPath(): string {
  return join(homedir(), '.omnai', 'providers.yaml');
}

export function parseAndValidateProviders(content: string): ProvidersConfig {
  const raw = parse(content);

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('providers.yaml must be a YAML object');
  }

  if (typeof raw.version !== 'number') {
    throw new Error('providers.yaml: "version" must be a number');
  }

  if (!Array.isArray(raw.failoverOrder)) {
    throw new Error('providers.yaml: "failoverOrder" must be an array');
  }

  if (typeof raw.accounts !== 'object' || raw.accounts === null || Array.isArray(raw.accounts)) {
    throw new Error('providers.yaml: "accounts" must be an object');
  }

  const accounts: Record<string, ProviderAccount> = {};

  for (const [id, acc] of Object.entries(raw.accounts)) {
    const a = acc as Record<string, unknown>;

    if (typeof a.provider !== 'string') {
      throw new Error(`providers.yaml: account "${id}" missing "provider" string`);
    }

    if (!VALID_TYPES.includes(a.type as typeof VALID_TYPES[number])) {
      throw new Error(`providers.yaml: account "${id}" has invalid type "${a.type}" (expected ${VALID_TYPES.join(', ')})`);
    }

    if (!Array.isArray(a.models)) {
      throw new Error(`providers.yaml: account "${id}" missing "models" array`);
    }

    const account: ProviderAccount = {
      provider: a.provider as Provider,
      type: a.type as ProviderAccount['type'],
      models: a.models as string[],
      enabled: a.enabled !== false,
    };

    if (a.apiKeyEnv !== undefined) {
      if (typeof a.apiKeyEnv !== 'string') {
        throw new Error(`providers.yaml: account "${id}" apiKeyEnv must be a string`);
      }
      account.apiKeyEnv = a.apiKeyEnv;
    }

    if (a.baseUrl !== undefined) {
      if (typeof a.baseUrl !== 'string') {
        throw new Error(`providers.yaml: account "${id}" baseUrl must be a string`);
      }
      account.baseUrl = a.baseUrl;
    }

    if (a.rateLimit !== undefined) {
      const rl = a.rateLimit as Record<string, unknown>;
      if (typeof rl !== 'object' || rl === null) {
        throw new Error(`providers.yaml: account "${id}" rateLimit must be an object`);
      }
      account.rateLimit = {};
      if (rl.rpm !== undefined) {
        if (typeof rl.rpm !== 'number') throw new Error(`providers.yaml: account "${id}" rateLimit.rpm must be a number`);
        account.rateLimit.rpm = rl.rpm;
      }
      if (rl.rpd !== undefined) {
        if (typeof rl.rpd !== 'number') throw new Error(`providers.yaml: account "${id}" rateLimit.rpd must be a number`);
        account.rateLimit.rpd = rl.rpd;
      }
      if (rl.concurrent !== undefined) {
        if (typeof rl.concurrent !== 'number') throw new Error(`providers.yaml: account "${id}" rateLimit.concurrent must be a number`);
        account.rateLimit.concurrent = rl.concurrent;
      }
    }

    if (a.tags !== undefined) {
      if (!Array.isArray(a.tags) || !a.tags.every(t => typeof t === 'string')) {
        throw new Error(`providers.yaml: account "${id}" tags must be an array of strings`);
      }
      account.tags = a.tags as string[];
    }

    if (a.quota !== undefined) {
      const q = a.quota as Record<string, unknown>;
      if (typeof q !== 'object' || q === null) {
        throw new Error(`providers.yaml: account "${id}" quota must be an object`);
      }
      if (!VALID_PERIODS.includes(q.period as typeof VALID_PERIODS[number])) {
        throw new Error(`providers.yaml: account "${id}" quota has invalid period "${q.period}"`);
      }
      const quota: QuotaDef = { period: q.period as QuotaDef['period'] };
      if (q.limit !== undefined) {
        if (typeof q.limit !== 'number') throw new Error(`providers.yaml: account "${id}" quota.limit must be a number`);
        quota.limit = q.limit;
      }
      if (q.softLimit !== undefined) {
        if (typeof q.softLimit !== 'number') throw new Error(`providers.yaml: account "${id}" quota.softLimit must be a number`);
        quota.softLimit = q.softLimit;
      }
      account.quota = quota;
    }

    if (a.headers !== undefined) {
      if (typeof a.headers !== 'object' || a.headers === null || Array.isArray(a.headers)) {
        throw new Error(`providers.yaml: account "${id}" headers must be an object`);
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(a.headers as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw new Error(`providers.yaml: account "${id}" headers values must be strings (key "${key}")`);
        }
        headers[key] = value;
      }
      account.headers = headers;
    }

    accounts[id] = account;
  }

  for (const ref of raw.failoverOrder) {
    if (typeof ref !== 'string') {
      throw new Error('providers.yaml: failoverOrder entries must be strings');
    }
    if (!(ref in accounts)) {
      throw new Error(`providers.yaml: failoverOrder references unknown account "${ref}"`);
    }
  }

  return {
    version: raw.version,
    failoverOrder: raw.failoverOrder,
    accounts,
  };
}

export async function loadProviders(path?: string): Promise<ProvidersConfig> {
  const filePath = path ?? getProvidersPath();
  const content = await readFile(filePath, 'utf-8');
  return parseAndValidateProviders(content);
}

export async function saveProviders(config: ProvidersConfig, path?: string): Promise<void> {
  const filePath = path ?? getProvidersPath();
  await mkdir(dirname(filePath), { recursive: true });
  const content = stringify(config, { lineWidth: 120 });
  await writeFile(filePath, content, 'utf-8');
}

export async function providersExists(path?: string): Promise<boolean> {
  try {
    await stat(path ?? getProvidersPath());
    return true;
  } catch {
    return false;
  }
}

let cachedProviders: ProvidersConfig | null = null;
let watchController: AbortController | null = null;

export async function loadProvidersWithCache(path?: string): Promise<ProvidersConfig> {
  if (cachedProviders) return cachedProviders;
  cachedProviders = await loadProviders(path);
  return cachedProviders;
}

export function clearProvidersCache(): void {
  cachedProviders = null;
}

export async function watchProviders(path?: string, onChange?: (config: ProvidersConfig) => void): Promise<() => void> {
  const filePath = path ?? getProvidersPath();
  watchController = new AbortController();

  (async () => {
    try {
      const watcher = watch(filePath, { signal: watchController!.signal });
      for await (const event of watcher) {
        if (event.eventType === 'change') {
          try {
            cachedProviders = await loadProviders(filePath);
            onChange?.(cachedProviders);
          } catch {
            // invalid YAML during edit, ignore
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    }
  })();

  return () => {
    watchController?.abort();
    watchController = null;
  };
}

export function getEnabledAccounts(config: ProvidersConfig): [string, ProviderAccount][] {
  return Object.entries(config.accounts).filter(([, acc]) => acc.enabled);
}

export function getAccountsForProvider(config: ProvidersConfig, provider: Provider): [string, ProviderAccount][] {
  return Object.entries(config.accounts).filter(([, acc]) => acc.enabled && acc.provider === provider);
}

export function resolveApiKey(account: ProviderAccount): string | undefined {
  if (!account.apiKeyEnv) return undefined;
  const envName = account.apiKeyEnv.startsWith('$') ? account.apiKeyEnv.slice(1) : account.apiKeyEnv;
  return process.env[envName];
}
