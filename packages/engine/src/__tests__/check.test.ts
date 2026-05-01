import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkProfile, clearCheckCache } from '../check.js';

vi.mock('../middleware/profiles.js', () => ({
  loadProfiles: vi.fn().mockResolvedValue({
    'claude-pro': {
      name: 'claude-pro',
      provider: 'claude',
      commandName: 'claude-pro',
      cliType: 'claude',
      claudeConfigDir: '/tmp/.claude-test',
    },
    'anthropic-api': {
      name: 'anthropic-api',
      provider: 'anthropic',
      commandName: 'anthropic-api',
      apiKey: 'sk-ant-test-key',
    },
    'openai-api': {
      name: 'openai-api',
      provider: 'openai',
      commandName: 'openai-api',
      apiKey: 'sk-test-key',
      model: 'gpt-4o',
    },
    'no-key': {
      name: 'no-key',
      provider: 'openai',
      commandName: 'no-key',
    },
  }),
  loadProfilesConfig: vi.fn().mockResolvedValue({ _config: {} }),
  saveProfilesConfig: vi.fn(),
  saveProfiles: vi.fn(),
  clearProfileCache: vi.fn(),
  getProfilesPath: vi.fn().mockReturnValue('/tmp/.sweech/profiles.json'),
}));

vi.mock('../keychain.js', () => ({
  getKey: vi.fn().mockReturnValue(null),
  migrateFromConfig: vi.fn(),
}));

describe('check', () => {
  beforeEach(() => {
    clearCheckCache();
    vi.restoreAllMocks();
  });

  it('returns no_profile for unknown profile', async () => {
    const result = await checkProfile('nonexistent');
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe('no_profile');
  });

  it('returns no_api_key for profile without credentials', async () => {
    const result = await checkProfile('no-key');
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe('no_api_key');
  });

  it('checks subscription provider by CLI availability', async () => {
    // 'which claude' will likely succeed in dev environment
    const result = await checkProfile('claude-pro');
    expect(result.profile).toBe('claude-pro');
    // Result depends on whether claude is installed — just check shape
    expect(['ok', 'base_url_down']).toContain(result.reason);
  });

  it('detects reachable Anthropic API profile', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'msg_test', type: 'message', content: [] }), { status: 200 }),
    );
    const result = await checkProfile('anthropic-api');
    expect(result.reachable).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.model).toBeTruthy();
  });

  it('detects auth_failed on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: 'authentication_error' } }), { status: 401 }),
    );
    const result = await checkProfile('anthropic-api');
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe('auth_failed');
  });

  it('detects subscription_tier on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }),
    );
    const result = await checkProfile('openai-api');
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe('subscription_tier');
  });

  it('detects base_url_down on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await checkProfile('openai-api');
    expect(result.reachable).toBe(false);
    expect(result.reason).toBe('base_url_down');
  });

  it('caches results for 5 minutes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'msg_test', type: 'message', content: [] }), { status: 200 }),
    );
    const first = await checkProfile('anthropic-api');
    expect(first.reachable).toBe(true);

    // Second call should use cache (no fetch)
    const second = await checkProfile('anthropic-api');
    expect(second.reachable).toBe(true);
    expect(second.checkedAt).toBe(first.checkedAt);
  });
});
