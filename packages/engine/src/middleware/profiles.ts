import { readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { EngineId, RunOptions } from '../types.js';
import type { CredentialProfile } from './types.js';
import {
  createEmptyRuntimeDocument,
  toLegacyRuntimeConfig,
  type SweechLegacyRuntimeConfig,
} from '../persistence-contract.js';
import { getKey, migrateFromConfig } from '../keychain.js';

/// Single source of truth: the sweech CLI's config.json. The engine
/// previously kept its own `~/.sweech/profiles.json` but that created
/// two parallel stores users had to keep in sync. With one store, every
/// profile the user adds via `sweech profile` is immediately visible
/// to the engine daemon (`sweech check`, `/recommend`, etc.).
const PROFILES_PATH = join(homedir(), '.sweech', 'config.json');
const SWEECH_FED_PORT = 7854;

function isSafeProfileName(name: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes('..');
}

export type ProfilesConfig = SweechLegacyRuntimeConfig;

let cached: ProfilesConfig | null = null;
let loadPromise: Promise<ProfilesConfig> | null = null;

export function getProfilesPath(): string {
  return PROFILES_PATH;
}

/**
 * Read `~/.sweech/config.json` — the CLI's profile array — and shape it
 * into the engine's keyed-by-commandName map. Single source of truth:
 * every profile the user adds via `sweech profile` is immediately
 * visible to engine daemon endpoints (/check, /recommend, …).
 */
export async function loadProfilesConfig(): Promise<ProfilesConfig> {
  if (cached) return cached;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const raw = await readFile(PROFILES_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(`Expected an array of profiles at ${PROFILES_PATH}`);
      }
      const document = createEmptyRuntimeDocument();
      const result = toLegacyRuntimeConfig(document) as Record<string, unknown>;
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        const profile = entry as Record<string, unknown>;
        const commandName = typeof profile.commandName === 'string' ? profile.commandName : undefined;
        if (!commandName || !isSafeProfileName(commandName)) continue;
        result[commandName] = {
          name: profile.name ?? commandName,
          commandName,
          cliType: profile.cliType,
          provider: profile.provider,
          apiKey: profile.apiKey,
          keyInKeychain: profile.keyInKeychain === true,
          oauth: profile.oauth,
          baseUrl: profile.baseUrl,
          model: profile.model,
          smallFastModel: profile.smallFastModel,
          sharedWith: profile.sharedWith,
          createdAt: profile.createdAt,
        };
      }
      cached = result as ProfilesConfig;
      return cached;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        cached = toLegacyRuntimeConfig(createEmptyRuntimeDocument());
        return cached;
      }
      throw error;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

export async function loadProfiles(): Promise<Record<string, CredentialProfile>> {
  const config = await loadProfilesConfig();
  const result: Record<string, CredentialProfile> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === '_config' || !value || typeof value !== 'object' || !('name' in value)) continue;
    result[key] = value as CredentialProfile;
  }
  return result;
}

export async function saveProfilesConfig(config: ProfilesConfig): Promise<void> {
  // Serialise as the CLI's array shape (matches what `sweech profile`
  // writes). `_config` (defaults / failover) is intentionally not
  // persisted by the engine — the CLI doesn't have that concept yet, so
  // round-tripping it would silently drop on the next CLI write. When
  // the engine genuinely needs to persist defaults, store them in a
  // sidecar file under ~/.sweech/.
  const array: unknown[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (key === '_config' || !value || typeof value !== 'object' || !('name' in value)) continue;
    array.push(value);
  }
  await mkdir(dirname(PROFILES_PATH), { recursive: true });
  await writeFile(PROFILES_PATH, JSON.stringify(array, null, 2), 'utf-8');
  cached = config;
}

export async function saveProfiles(profiles: Record<string, CredentialProfile>): Promise<void> {
  const existing = await loadProfilesConfig();
  const config: ProfilesConfig = {
    ...(existing._config ? { _config: existing._config } : {}),
    ...profiles,
  };
  await saveProfilesConfig(config);
}

export function clearProfileCache(): void {
  cached = null;
}

export async function getDefaultProfile(engine: EngineId): Promise<string | undefined> {
  const config = await loadProfilesConfig();
  return config._config?.defaults?.[engine];
}

export async function setDefaultProfile(engine: EngineId, profileName: string): Promise<void> {
  const config = await loadProfilesConfig();
  if (!config._config) config._config = {};
  if (!config._config.defaults) config._config.defaults = {};
  config._config.defaults[engine] = profileName;
  await saveProfilesConfig(config);
}

export async function getFailoverOrder(): Promise<string[]> {
  const config = await loadProfilesConfig();
  return config._config?.failoverOrder ?? [];
}

export async function setFailoverOrder(order: string[]): Promise<void> {
  const config = await loadProfilesConfig();
  if (!config._config) config._config = {};
  config._config.failoverOrder = order;
  await saveProfilesConfig(config);
}

/**
 * Check if multiple profiles exist for an engine, and whether a default is set.
 * Returns the default profile name, or throws with an actionable error.
 */
export async function resolveDefaultForEngine(engine: EngineId): Promise<string | null> {
  const profiles = await loadProfiles();
  const matching = Object.values(profiles).filter(p => {
    if (engine === 'claude-code') return p.provider === 'claude';
    return false;
  });

  if (matching.length <= 1) return null; // No ambiguity

  const defaultName = await getDefaultProfile(engine);
  if (defaultName && profiles[defaultName]) return defaultName;

  const names = matching.map(p => p.name).join(', ');
  throw new Error(
    `Multiple profiles found for ${engine}: ${names}\n` +
    `Set a default: sweech profiles set-default ${engine} <profile-name>\n` +
    `Or specify explicitly: sweech run "prompt" --profile <name>`
  );
}

export async function resolveProfile(profileName: string, opts: RunOptions): Promise<RunOptions> {
  if (!isSafeProfileName(profileName)) {
    throw new Error(`Unsafe profile name: "${profileName}". Only alphanumeric, underscore, hyphen, and dot are allowed.`);
  }

  const profiles = await loadProfiles();
  const profile = profiles[profileName];
  if (!profile) throw new Error(`Profile "${profileName}" not found in ${PROFILES_PATH}`);

  const env = { ...opts.env, ...profile.env };

  if (profile.claudeConfigDir) {
    env['CLAUDE_CONFIG_DIR'] = profile.claudeConfigDir;
  }

  // For codex profiles, derive CODEX_HOME from the Sweech convention ~/.<profileName>/
  // (mirrors how claudeConfigDir works for claude profiles)
  if (profile.provider === 'codex' && !env['CODEX_HOME']) {
    const { homedir } = await import('node:os');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const codexHome = join(homedir(), `.${profileName}`);
    if (existsSync(codexHome)) {
      env['CODEX_HOME'] = codexHome;
    }
  }

  // Resolve API key from keychain first, fall back to plaintext (pre-migration)
  await migrateFromConfig();
  const apiKey = getKey(profileName) ?? profile.apiKey ?? opts.apiKey;

  return {
    ...opts,
    provider: profile.provider ?? opts.provider,
    apiKey,
    baseUrl: profile.baseUrl ?? opts.baseUrl,
    env,
  };
}

interface SweechProfile {
  name: string;
  commandName: string;
  cliType: string;
  provider: string;
  baseUrl?: string;
  model?: string;
  sharedWith?: string;
}

async function querySweechProfiles(port: number): Promise<SweechProfile[]> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/fed/runs`, { timeout: 1000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer | string) => {
        data += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          resolve(Array.isArray(raw) ? raw as SweechProfile[] : []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

export async function importSweechProfiles(port = SWEECH_FED_PORT): Promise<{ imported: string[]; skipped: string[] }> {
  const imported: string[] = [];
  const skipped: string[] = [];

  const sweechProfiles = await querySweechProfiles(port);
  if (sweechProfiles.length === 0) return { imported, skipped };

  const config = await loadProfilesConfig();

  if (!config['claude']) {
    config['claude'] = { name: 'claude', provider: 'claude' };
    imported.push('claude');
  } else {
    skipped.push('claude');
  }

  for (const sp of sweechProfiles) {
    const name = sp.commandName;
    if (!isSafeProfileName(name)) {
      skipped.push(name);
      continue;
    }
    if (config[name]) {
      skipped.push(name);
      continue;
    }

    const claudeConfigDir = join(homedir(), `.claude-${name.replace(/^claude-/, '')}`);
    config[name] = {
      name,
      provider: sp.cliType === 'claude' ? 'claude' : sp.provider,
      baseUrl: sp.baseUrl || undefined,
      claudeConfigDir,
    };
    imported.push(name);
  }

  await saveProfilesConfig(config);
  return { imported, skipped };
}
