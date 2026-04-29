import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectEngines: vi.fn(),
  resolveAccount: vi.fn(),
  resolveProfile: vi.fn(),
  resolveDefaultForEngine: vi.fn(),
}));

vi.mock('../../detect.js', () => ({
  detectEngines: mocks.detectEngines,
}));

vi.mock('../../middleware/accounts.js', () => ({
  resolveAccount: mocks.resolveAccount,
}));

vi.mock('../../middleware/profiles.js', () => ({
  resolveProfile: mocks.resolveProfile,
  resolveDefaultForEngine: mocks.resolveDefaultForEngine,
}));

import { resolveSelectionTarget } from '../../select.js';
import { select } from '../../select.js';
import { ExecutionResolutionError } from '../../execution-target.js';

const mockedDetectEngines = vi.mocked(mocks.detectEngines);
const mockedResolveAccount = vi.mocked(mocks.resolveAccount);
const mockedResolveProfile = vi.mocked(mocks.resolveProfile);
const mockedResolveDefaultForEngine = vi.mocked(mocks.resolveDefaultForEngine);

describe('select routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolveDefaultForEngine.mockResolvedValue(null);
    mockedResolveProfile.mockResolvedValue({ provider: 'claude' });
  });

  it('routes codex provider to the codex engine', async () => {
    mockedDetectEngines.mockResolvedValueOnce([
      { engine: 'codex', available: true, binaryPath: '/usr/local/bin/codex', providers: ['codex'] },
    ]);

    const runner = await select({ provider: 'codex' });

    expect(runner.engine).toBe('codex');
  });

  it('does not route openai provider to codex', async () => {
    mockedDetectEngines.mockResolvedValueOnce([
      { engine: 'codex', available: true, binaryPath: '/usr/local/bin/codex', providers: ['codex'] },
    ]);

    await expect(select({ provider: 'openai' })).rejects.toThrow(
      'No engine available for provider "openai". Install pi-mono, opencode, or goose for API-key based OpenAI routing.',
    );
  });

  it('routes openai provider to pi-mono when available', async () => {
    mockedDetectEngines.mockResolvedValueOnce([
      { engine: 'pi-mono', available: true, binaryPath: '/usr/local/bin/pi', providers: ['openai'] },
      { engine: 'codex', available: true, binaryPath: '/usr/local/bin/codex', providers: ['codex'] },
    ]);

    const runner = await select({ provider: 'openai' });

    expect(runner.engine).toBe('pi-mono');
  });

  it('gives explicit engine precedence over account or profile', async () => {
    mockedDetectEngines.mockResolvedValueOnce([
      { engine: 'copilot', available: true, binaryPath: '/usr/local/bin/copilot', providers: ['openai', 'claude'] },
      { engine: 'pi-mono', available: true, binaryPath: '/usr/local/bin/pi', providers: ['openai'] },
      { engine: 'claude-code', available: true, binaryPath: '/usr/local/bin/claude', providers: ['claude'] },
    ]);

    const target = await resolveSelectionTarget({
      engine: 'copilot',
      account: 'my-account',
      profile: 'my-profile',
    });

    expect(target).toMatchObject({ source: 'explicit-engine', engine: 'copilot', provider: undefined, account: 'my-account' });
    expect(mockedResolveAccount).not.toHaveBeenCalled();
    expect(mockedResolveProfile).not.toHaveBeenCalled();
  });

  it('uses account selection before profile defaults', async () => {
    mockedDetectEngines.mockResolvedValueOnce([
      { engine: 'pi-mono', available: true, binaryPath: '/usr/local/bin/pi', providers: ['openai'] },
      { engine: 'claude-code', available: true, binaryPath: '/usr/local/bin/claude', providers: ['claude'] },
    ]);
    mockedResolveAccount.mockResolvedValue({
      account: 'preferred-account',
      provider: 'openai',
      options: {
        provider: 'openai',
      },
      source: 'providers',
    });

    const target = await resolveSelectionTarget({ account: 'preferred-account', profile: 'my-profile' });

    expect(target).toMatchObject({ source: 'account', engine: 'pi-mono', provider: 'openai', account: 'preferred-account' });
    expect(mockedResolveProfile).not.toHaveBeenCalled();
  });

  it('wraps account resolution failures with a typed resolution error', async () => {
    mockedDetectEngines.mockResolvedValueOnce([]);
    mockedResolveAccount.mockRejectedValue(new Error('account not found'));

    const err = await resolveSelectionTarget({ account: 'unknown' }).catch((error) => error);

    expect(err).toBeInstanceOf(ExecutionResolutionError);
    expect((err as ExecutionResolutionError).status).toBe(400);
    expect((err as ExecutionResolutionError).body.code).toBe('INVALID_ACCOUNT');
  });

  it('resolves profile before selection when both are present', async () => {
    mockedDetectEngines.mockResolvedValueOnce([
      { engine: 'pi-mono', available: true, binaryPath: '/usr/local/bin/pi', providers: ['openai'] },
      { engine: 'copilot', available: true, binaryPath: '/usr/local/bin/copilot', providers: ['openai', 'copilot'] },
    ]);
    mockedResolveProfile.mockResolvedValueOnce({ provider: 'openai' });

    const target = await resolveSelectionTarget({
      profile: 'my-profile',
      selection: { engine: 'copilot' },
    });

    expect(target).toMatchObject({ source: 'profile', engine: 'pi-mono', provider: 'openai' });
    expect(mockedResolveProfile).toHaveBeenCalledTimes(1);
  });

  it('falls back to selection before detection', async () => {
    mockedDetectEngines.mockResolvedValueOnce([
      { engine: 'pi-mono', available: true, binaryPath: '/usr/local/bin/pi', providers: ['openai'] },
      { engine: 'copilot', available: true, binaryPath: '/usr/local/bin/copilot', providers: ['openai', 'copilot'] },
      { engine: 'claude-code', available: true, binaryPath: '/usr/local/bin/claude', providers: ['claude'] },
    ]);

    const target = await resolveSelectionTarget({
      provider: 'openai',
      selection: { provider: 'copilot', engine: 'copilot', account: 'some' },
    });

    expect(target).toMatchObject({ source: 'selection', engine: 'copilot', provider: 'copilot', account: 'some' });
  });

  describe('capability-based routing', () => {
    it('routes to vision-capable engine when capabilities=["vision"]', async () => {
      mockedDetectEngines.mockResolvedValueOnce([
        { engine: 'codex', available: true, binaryPath: '/usr/local/bin/codex', providers: ['codex'] },
        { engine: 'claude-code', available: true, binaryPath: '/usr/local/bin/claude', providers: ['claude'] },
      ]);

      const target = await resolveSelectionTarget({ capabilities: ['vision'] });

      expect(target).toMatchObject({
        source: 'detect',
        engine: 'claude-code',
        fallbackReason: expect.stringContaining('vision'),
      });
    });

    it('routes to engine matching multiple capabilities', async () => {
      mockedDetectEngines.mockResolvedValueOnce([
        { engine: 'codex', available: true, binaryPath: '/usr/local/bin/codex', providers: ['codex'] },
        { engine: 'claude-code', available: true, binaryPath: '/usr/local/bin/claude', providers: ['claude'] },
        { engine: 'qwen-code', available: true, binaryPath: '/usr/local/bin/qwen', providers: ['qwen'] },
      ]);

      // Only claude-code has mcp + sessions + cost
      const target = await resolveSelectionTarget({ capabilities: ['mcp', 'sessions', 'cost'] });

      expect(target).toMatchObject({ source: 'detect', engine: 'claude-code' });
    });

    it('skips capability routing when explicit engine is given', async () => {
      mockedDetectEngines.mockResolvedValueOnce([
        { engine: 'codex', available: true, binaryPath: '/usr/local/bin/codex', providers: ['codex'] },
      ]);

      const target = await resolveSelectionTarget({ engine: 'codex', capabilities: ['vision'] });

      // codex has vision=false but explicit engine takes precedence
      expect(target).toMatchObject({ source: 'explicit-engine', engine: 'codex' });
    });

    it('returns fallbackReason listing requested capabilities', async () => {
      mockedDetectEngines.mockResolvedValueOnce([
        { engine: 'claude-code', available: true, binaryPath: '/usr/local/bin/claude', providers: ['claude'] },
      ]);

      const target = await resolveSelectionTarget({ capabilities: ['code', 'reasoning'] });

      expect(target.fallbackReason).toContain('code');
      expect(target.fallbackReason).toContain('reasoning');
    });
  });
});
