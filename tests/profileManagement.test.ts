import * as fs from 'fs';
import {
  createManagedProfile,
  getManageableProviders,
  removeManagedProfile,
  renameManagedProfile,
} from '../src/profileManagement';

jest.mock('fs');
jest.mock('../src/clis', () => ({
  getCLI: jest.fn((name: string) => {
    if (name === 'claude') return { name: 'claude', command: 'claude' };
    if (name === 'codex') return { name: 'codex', command: 'codex' };
    return undefined;
  }),
}));
jest.mock('../src/providers', () => ({
  getProvider: jest.fn((name: string) => {
    const providers: Record<string, any> = {
      anthropic: {
        name: 'anthropic',
        displayName: 'Claude (Anthropic)',
        description: 'Official Anthropic Claude models',
        compatibility: ['claude'],
        isCustom: false,
        baseUrl: '',
        defaultModel: 'claude-sonnet-4-6',
      },
      minimax: {
        name: 'minimax',
        displayName: 'MiniMax',
        description: 'MiniMax coding models',
        compatibility: ['claude'],
        isCustom: false,
        baseUrl: 'https://api.minimax.io/anthropic',
        defaultModel: 'MiniMax-M2.7',
      },
      openai: {
        name: 'openai',
        displayName: 'OpenAI',
        description: 'Official OpenAI models via Codex CLI',
        compatibility: ['codex'],
        isCustom: false,
        baseUrl: '',
        defaultModel: 'gpt-5.4',
      },
    };
    return providers[name];
  }),
  getProvidersForCLI: jest.fn((cliType: string) => {
    const all = {
      claude: [
        {
          name: 'anthropic',
          displayName: 'Claude (Anthropic)',
          description: 'Official Anthropic Claude models',
          compatibility: ['claude'],
          isCustom: false,
        },
        {
          name: 'minimax',
          displayName: 'MiniMax',
          description: 'MiniMax coding models',
          compatibility: ['claude'],
          isCustom: false,
        },
      ],
      codex: [
        {
          name: 'openai',
          displayName: 'OpenAI',
          description: 'Official OpenAI models via Codex CLI',
          compatibility: ['codex'],
          isCustom: false,
        },
      ],
    };
    return all[cliType as 'claude' | 'codex'] ?? [];
  }),
}));
jest.mock('../src/systemCommands', () => ({
  validateCommandName: jest.fn(async () => ({ valid: true })),
}));
jest.mock('../src/profileCreation', () => ({
  createProfile: jest.fn(async () => undefined),
}));
jest.mock('../src/reset', () => ({
  isDefaultCLIDirectory: jest.fn(() => false),
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const { createProfile } = jest.requireMock('../src/profileCreation') as { createProfile: jest.Mock };

describe('profileManagement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.writeFileSync.mockImplementation(() => undefined);
    mockFs.renameSync.mockImplementation(() => undefined);
    mockFs.unlinkSync.mockImplementation(() => undefined);
    mockFs.existsSync.mockReturnValue(false);
  });

  test('lists manageable providers with auth capabilities', () => {
    const providers = getManageableProviders('claude');
    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'anthropic',
        supportsOAuth: true,
        defaultCommandName: 'claude-work',
      }),
      expect.objectContaining({
        name: 'minimax',
        supportsOAuth: false,
        requiresApiKey: true,
        defaultCommandName: 'claude-mini',
      }),
    ]));
  });

  test('creates a managed profile through shared creation logic', async () => {
    const config = {
      getProfiles: () => [],
      getProfileDir: (name: string) => `/mock/home/.${name}`,
    };

    const result = await createManagedProfile({
      cliType: 'claude',
      provider: 'anthropic',
      commandName: 'claude-work',
      authMethod: 'oauth',
    }, config as any);

    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'claude',
        provider: 'anthropic',
        commandName: 'claude-work',
        authMethod: 'oauth',
      }),
      expect.objectContaining({ name: 'anthropic' }),
      expect.objectContaining({ name: 'claude' }),
      config,
      { quiet: true }
    );
    expect(result.profileDir).toBe('/mock/home/.claude-work');
  });

  test('rename updates dependent shared profiles and recreates symlinks', async () => {
    const config = {
      getProfiles: () => [
        {
          name: 'claude-work',
          commandName: 'claude-work',
          cliType: 'claude',
          provider: 'anthropic',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          name: 'claude-pair',
          commandName: 'claude-pair',
          cliType: 'claude',
          provider: 'anthropic',
          sharedWith: 'claude-work',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      getConfigFile: () => '/mock/home/.sweech/config.json',
      getProfileDir: (name: string) => `/mock/home/.${name}`,
      getBinDir: () => '/mock/home/.sweech/bin',
      createWrapperScript: jest.fn(),
      setupSharedDirs: jest.fn(),
    };

    mockFs.existsSync.mockImplementation((value: fs.PathLike) => (
      value === '/mock/home/.claude-work' || value === '/mock/home/.sweech/bin/claude-work'
    ));

    const result = await renameManagedProfile('claude-work', 'claude-renamed', config as any);

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      '/mock/home/.sweech/config.json',
      expect.stringContaining('"sharedWith": "claude-renamed"')
    );
    expect(mockFs.renameSync).toHaveBeenCalledWith('/mock/home/.claude-work', '/mock/home/.claude-renamed');
    expect(config.createWrapperScript).toHaveBeenCalledWith('claude-renamed', expect.objectContaining({ name: 'claude' }));
    expect(config.setupSharedDirs).toHaveBeenCalledWith('claude-pair', 'claude-renamed', 'claude');
    expect(result.updatedDependents).toEqual(['claude-pair']);
  });

  test('remove guards shared dependents unless forced', () => {
    const config = {
      getProfiles: () => [
        {
          name: 'claude-work',
          commandName: 'claude-work',
          cliType: 'claude',
          provider: 'anthropic',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          name: 'claude-pair',
          commandName: 'claude-pair',
          cliType: 'claude',
          provider: 'anthropic',
          sharedWith: 'claude-work',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      getProfileDir: (name: string) => `/mock/home/.${name}`,
      removeProfile: jest.fn(),
    };

    expect(() => removeManagedProfile('claude-work', {}, config as any))
      .toThrow("Profile 'claude-work' is shared by: claude-pair");

    const result = removeManagedProfile('claude-work', { forceDependents: true }, config as any);
    expect(config.removeProfile).toHaveBeenCalledWith('claude-work');
    expect(result.removedDependents).toEqual(['claude-pair']);
  });
});
