import type { Hono } from 'hono';
import type { EngineId } from '../types.js';
import {
  loadProfiles,
  loadProfilesConfig,
  saveProfilesConfig,
  getDefaultProfile,
  setDefaultProfile,
  getFailoverOrder,
  setFailoverOrder,
  clearProfileCache,
} from '../middleware/profiles.js';
import { getKey, setKey, deleteKey, keyExists } from '../keychain.js';
import { detectEngines } from '../detect.js';
import { MODEL_OPTIONS } from '../models.js';
import { PRICING } from '../pricing.js';

const RESERVED_KEYS = new Set(['_config', '__proto__', 'constructor', 'prototype']);
const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const VALID_ENGINES = new Set(['claude-code', 'codex', 'qwen-code', 'gemini-cli', 'pi-mono', 'opencode', 'goose', 'copilot', 'amazon-q']);

// Env vars that are safe to set via the config API — prevent LD_PRELOAD, NODE_OPTIONS, etc.
const ALLOWED_ENV_PREFIXES = ['CLAUDE_', 'CODEX_', 'OPENAI_', 'ANTHROPIC_', 'GOOGLE_', 'OMNAI_', 'PATH'];

function isSafeName(name: string): boolean {
  return SAFE_NAME_RE.test(name) && !RESERVED_KEYS.has(name);
}

function isSafeEnv(env: Record<string, unknown>): boolean {
  for (const key of Object.keys(env)) {
    if (!ALLOWED_ENV_PREFIXES.some(p => key.startsWith(p))) return false;
    if (typeof env[key] !== 'string') return false;
  }
  return true;
}

function isSafePath(p: string): boolean {
  // Must be absolute, no traversal
  if (!p.startsWith('/')) return false;
  if (p.includes('..')) return false;
  return true;
}

export function registerConfigRoutes(app: Hono): void {
  // GET /api/config — profiles, defaults, failover (keys redacted)
  app.get('/api/config', async (c) => {
    const config = await loadProfilesConfig();
    const defaults = config._config?.defaults ?? {};
    const failoverOrder = config._config?.failoverOrder ?? [];

    const profiles: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (key === '_config' || !value || typeof value !== 'object' || !('name' in value)) continue;
      const profile = { ...(value as unknown as Record<string, unknown>) };
      delete profile.apiKey;
      (profile as Record<string, unknown>).keyInKeychain = keyExists(key);
      profiles[key] = profile;
    }

    return c.json({ profiles, defaults, failoverOrder });
  });

  // POST /api/config/profile — add/update profile
  app.post('/api/config/profile', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);

    const { name, provider, apiKey, baseUrl, claudeConfigDir, env } = body as Record<string, unknown>;
    if (typeof name !== 'string' || !name) return c.json({ error: 'name is required' }, 400);
    if (!isSafeName(name)) return c.json({ error: 'invalid profile name' }, 400);
    if (typeof provider !== 'string' || !provider) return c.json({ error: 'provider is required' }, 400);

    // Validate env vars — only allowlisted prefixes (no LD_PRELOAD, NODE_OPTIONS, etc.)
    if (env && typeof env === 'object') {
      if (!isSafeEnv(env as Record<string, unknown>)) {
        return c.json({ error: 'env contains disallowed keys — allowed prefixes: ' + ALLOWED_ENV_PREFIXES.join(', ') }, 400);
      }
    }

    // Validate claudeConfigDir — must be absolute path without traversal
    if (typeof claudeConfigDir === 'string' && !isSafePath(claudeConfigDir)) {
      return c.json({ error: 'claudeConfigDir must be an absolute path without ..' }, 400);
    }

    // Validate baseUrl — must be a valid URL
    if (typeof baseUrl === 'string') {
      try { new URL(baseUrl); } catch { return c.json({ error: 'baseUrl must be a valid URL' }, 400); }
    }

    const config = await loadProfilesConfig();
    const profile: Record<string, unknown> = { name, provider };
    if (typeof baseUrl === 'string') profile.baseUrl = baseUrl;
    if (typeof claudeConfigDir === 'string') profile.claudeConfigDir = claudeConfigDir;
    if (env && typeof env === 'object') profile.env = env;

    config[name] = profile;
    await saveProfilesConfig(config);
    clearProfileCache();

    // Store API key in keychain if provided
    let keyStored = false;
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      setKey(name, apiKey);
      keyStored = keyExists(name);
      if (!keyStored) {
        return c.json({ error: 'keychain unavailable — cannot store API key on this platform' }, 501);
      }
    }

    return c.json({ ok: true, profile: { ...profile, keyInKeychain: keyStored } });
  });

  // DELETE /api/config/profile/:name
  app.delete('/api/config/profile/:name', async (c) => {
    const name = c.req.param('name');
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (!isSafeName(name)) return c.json({ error: 'invalid profile name' }, 400);

    const config = await loadProfilesConfig();
    if (!config[name] || typeof config[name] !== 'object' || !('name' in (config[name] as object))) {
      return c.json({ error: `profile "${name}" not found` }, 404);
    }

    delete config[name];
    await saveProfilesConfig(config);
    clearProfileCache();
    deleteKey(name);

    return c.json({ ok: true });
  });

  // POST /api/config/default
  app.post('/api/config/default', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
    const { engine, profile } = body as Record<string, unknown>;
    if (typeof engine !== 'string' || !engine) return c.json({ error: 'engine is required' }, 400);
    if (typeof profile !== 'string' || !profile) return c.json({ error: 'profile is required' }, 400);
    if (!VALID_ENGINES.has(engine)) return c.json({ error: `invalid engine "${engine}"` }, 400);

    // Verify profile exists before setting as default
    const config = await loadProfilesConfig();
    if (!config[profile] || typeof config[profile] !== 'object' || !('name' in (config[profile] as object))) {
      return c.json({ error: `profile "${profile}" not found` }, 404);
    }

    await setDefaultProfile(engine as EngineId, profile);
    return c.json({ ok: true, engine, profile });
  });

  // POST /api/config/failover
  app.post('/api/config/failover', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
    const { order } = body as Record<string, unknown>;
    if (!Array.isArray(order)) return c.json({ error: 'order must be an array' }, 400);
    if (order.length > 20) return c.json({ error: 'order too long (max 20)' }, 400);

    // Validate each entry is a non-empty string matching an existing profile
    const config = await loadProfilesConfig();
    const validated: string[] = [];
    for (const entry of order) {
      if (typeof entry !== 'string' || !entry) return c.json({ error: 'order entries must be non-empty strings' }, 400);
      if (!config[entry] || typeof config[entry] !== 'object' || !('name' in (config[entry] as object))) {
        return c.json({ error: `profile "${entry}" not found` }, 400);
      }
      validated.push(entry);
    }

    await setFailoverOrder(validated);
    return c.json({ ok: true, failoverOrder: validated });
  });

  // GET /api/models — all models grouped by provider with pricing
  app.get('/api/models', async (c) => {
    const models = Object.entries(MODEL_OPTIONS).map(([id, opt]) => ({
      id,
      name: opt.label,
      provider: opt.provider,
      pricing: PRICING[id] ?? null,
      contextWindow: opt.contextWindow,
    }));
    return c.json({ models });
  });

  // GET /api/health — aggregated health of all providers
  app.get('/api/health', async (c) => {
    const engines = await detectEngines();
    const profiles = await loadProfiles();
    const profileList = Object.values(profiles).map(p => ({
      name: p.name,
      provider: p.provider,
      keyInKeychain: keyExists(p.name),
      hasBaseUrl: !!p.baseUrl,
      hasClaudeConfigDir: !!p.claudeConfigDir,
    }));

    const defaults: Record<string, string | undefined> = {};
    for (const engineId of ['claude-code', 'codex', 'qwen-code', 'gemini-cli'] as const) {
      defaults[engineId] = await getDefaultProfile(engineId);
    }

    return c.json({
      engines: engines.map(e => ({
        engine: e.engine,
        available: e.available,
        binaryPath: e.binaryPath,
        providers: e.providers,
      })),
      profiles: profileList,
      defaults,
      failoverOrder: await getFailoverOrder(),
    });
  });
}
