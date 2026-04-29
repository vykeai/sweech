import type { EngineId, Provider, RunOptions } from '../types.js';
import { loadProfiles, resolveProfile } from './profiles.js';
import { loadProvidersWithCache, resolveApiKey } from '../providers.js';
import { loadEstate } from '../estate.js';
import { isOmnaiMigrationError } from '../persistence-contract.js';

export interface NamedAccountResolution {
  account: string;
  source: 'profile' | 'providers' | 'estate';
  options: RunOptions;
  engine?: EngineId;
  provider?: Provider;
}

/**
 * Resolve a named runtime account into concrete run options.
 *
 * Resolution order:
 * 1. ~/.omnai/profiles.json for Sweech-style local CLI accounts
 * 2. ~/.omnai/providers.yaml for named API/openai-compatible accounts
 * 3. ~/.omnai/estate.yaml for quota-aware account metadata
 */
export async function resolveAccount(accountName: string, opts: RunOptions): Promise<NamedAccountResolution> {
  let profilesLoadError: Error | null = null;
  try {
    const profiles = await loadProfiles();
    if (profiles[accountName]) {
      const resolved = await resolveProfile(accountName, opts);
      return {
        account: accountName,
        source: 'profile',
        options: { ...resolved, account: accountName },
        provider: resolved.provider,
      };
    }
  } catch (error) {
    if (isOmnaiMigrationError(error)) {
      profilesLoadError = error;
    } else {
      throw error;
    }
  }

  try {
    const providers = await loadProvidersWithCache();
    const providerAccount = providers.accounts[accountName];
    if (providerAccount && providerAccount.enabled !== false) {
      const env = { ...opts.env };
      const apiKey = resolveApiKey(providerAccount) ?? opts.apiKey;
      return {
        account: accountName,
        source: 'providers',
        provider: providerAccount.provider,
        options: {
          ...opts,
          account: accountName,
          provider: providerAccount.provider,
          baseUrl: providerAccount.baseUrl ?? opts.baseUrl,
          apiKey,
          headers: providerAccount.headers ?? opts.headers,
          env,
        },
      };
    }
  } catch {
    // providers.yaml is optional
  }

  try {
    const estate = await loadEstate();
    const estateAccount = estate.accounts[accountName];
    if (estateAccount) {
      const env = { ...opts.env };
      if (estateAccount.configDir && (estateAccount.provider === 'claude' || estateAccount.provider === 'codex')) {
        if (estateAccount.provider === 'claude') env['CLAUDE_CONFIG_DIR'] = estateAccount.configDir;
        if (estateAccount.provider === 'codex') env['CODEX_HOME'] = estateAccount.configDir;
      }
      if (estateAccount.apiKeyEnv && process.env[estateAccount.apiKeyEnv]) {
        opts = { ...opts, apiKey: process.env[estateAccount.apiKeyEnv] };
      }
      return {
        account: accountName,
        source: 'estate',
        engine: estateAccount.engine as EngineId,
        provider: estateAccount.provider as Provider,
        options: {
          ...opts,
          account: accountName,
          provider: estateAccount.provider as Provider,
          env,
        },
      };
    }
  } catch {
    // estate.yaml is optional
  }

  if (profilesLoadError) {
    throw profilesLoadError;
  }

  throw new Error(
    `Account "${accountName}" not found.\n` +
    `Expected a Sweech-imported profile in ~/.omnai/profiles.json or a named account in ~/.omnai/providers.yaml / estate.yaml.`
  );
}
