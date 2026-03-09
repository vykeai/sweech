/**
 * Tests for ConfigManager with mocked file system
 */

import { ConfigManager, ProfileConfig } from '../src/config';
import { getProvider } from '../src/providers';
import { getDefaultCLI } from '../src/clis';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock os module
jest.mock('os');
const mockOs = os as jest.Mocked<typeof os>;

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  const mockHomeDir = '/mock/home';
  const mockConfigDir = '/mock/home/.sweech';
  const mockConfigFile = '/mock/home/.sweech/config.json';

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock os.homedir()
    mockOs.homedir.mockReturnValue(mockHomeDir);

    // Mock fs.existsSync to return false initially
    mockFs.existsSync.mockReturnValue(false);

    // Mock fs.mkdirSync (does nothing)
    mockFs.mkdirSync.mockImplementation(() => undefined as any);

    configManager = new ConfigManager();
  });

  describe('Initialization', () => {
    test('creates necessary directories', () => {
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        mockConfigDir,
        { recursive: true }
      );
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        path.join(mockConfigDir, 'profiles'),
        { recursive: true }
      );
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        path.join(mockConfigDir, 'bin'),
        { recursive: true }
      );
    });

    test('skips directory creation if they exist', () => {
      jest.clearAllMocks();
      mockFs.existsSync.mockReturnValue(true);

      new ConfigManager();

      expect(mockFs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('getProfiles', () => {
    test('returns empty array when config file does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);

      const profiles = configManager.getProfiles();

      expect(profiles).toEqual([]);
    });

    test('returns profiles from config file', () => {
      const mockProfiles: ProfileConfig[] = [
        {
          name: 'test',
          commandName: 'claude-mini',
          cliType: 'claude',
          provider: 'minimax',
          apiKey: 'sk-test',
          createdAt: '2025-02-03T00:00:00.000Z'
        }
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockProfiles));

      const profiles = configManager.getProfiles();

      expect(profiles).toHaveLength(1);
      expect(profiles[0].commandName).toBe('claude-mini');
    });

    test('adds cliType to legacy profiles', () => {
      const legacyProfile = {
        name: 'test',
        commandName: 'claude-mini',
        provider: 'minimax',
        apiKey: 'sk-test',
        createdAt: '2025-02-03T00:00:00.000Z'
        // Missing cliType
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([legacyProfile]));

      const profiles = configManager.getProfiles();

      expect(profiles[0].cliType).toBe('claude'); // Default
    });
  });

  describe('addProfile', () => {
    test('adds new profile successfully', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.writeFileSync.mockImplementation(() => {});

      const profile: ProfileConfig = {
        name: 'test',
        commandName: 'claude-mini',
        cliType: 'claude',
        provider: 'minimax',
        apiKey: 'sk-test',
        createdAt: new Date().toISOString()
      };

      configManager.addProfile(profile);

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const callArgs = mockFs.writeFileSync.mock.calls[0];
      expect(callArgs[0]).toBe(mockConfigFile);

      const writtenData = JSON.parse(callArgs[1] as string);
      expect(writtenData).toHaveLength(1);
      expect(writtenData[0].commandName).toBe('claude-mini');
    });

    test('throws error when command name already exists', () => {
      const existingProfile: ProfileConfig = {
        name: 'existing',
        commandName: 'claude-mini',
        cliType: 'claude',
        provider: 'minimax',
        apiKey: 'sk-existing',
        createdAt: '2025-02-03T00:00:00.000Z'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([existingProfile]));

      const newProfile: ProfileConfig = {
        name: 'new',
        commandName: 'claude-mini', // Duplicate!
        cliType: 'claude',
        provider: 'qwen',
        apiKey: 'sk-new',
        createdAt: new Date().toISOString()
      };

      expect(() => {
        configManager.addProfile(newProfile);
      }).toThrow("Command name 'claude-mini' already exists");
    });
  });

  describe('removeProfile', () => {
    test('removes profile and cleans up files', () => {
      const mockProfile: ProfileConfig = {
        name: 'test',
        commandName: 'claude-mini',
        cliType: 'claude',
        provider: 'minimax',
        apiKey: 'sk-test',
        createdAt: '2025-02-03T00:00:00.000Z'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([mockProfile]));
      mockFs.writeFileSync.mockImplementation(() => {});
      mockFs.unlinkSync.mockImplementation(() => {});
      mockFs.rmSync.mockImplementation(() => {});

      // lstatSync: profile dir is a regular directory (not symlink)
      (mockFs.lstatSync as jest.Mock).mockReturnValue({
        isSymbolicLink: () => false
      });

      configManager.removeProfile('claude-mini');

      // Check config file is updated (profile removed)
      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const writtenData = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(writtenData).toHaveLength(0);

      // Check wrapper script is removed
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(
        path.join(mockConfigDir, 'bin', 'claude-mini')
      );

      // Check profile directory is removed
      expect(mockFs.rmSync).toHaveBeenCalledWith(
        path.join(mockHomeDir, '.claude-mini'),
        { recursive: true, force: true }
      );
    });

    test('uses unlinkSync (not rmSync) when profile dir is a symlink', () => {
      const mockProfile: ProfileConfig = {
        name: 'test',
        commandName: 'claude-shared',
        cliType: 'claude',
        provider: 'minimax',
        apiKey: 'sk-test',
        sharedWith: 'claude',
        createdAt: '2025-02-03T00:00:00.000Z'
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify([mockProfile]));
      mockFs.writeFileSync.mockImplementation(() => {});
      mockFs.unlinkSync.mockImplementation(() => {});
      mockFs.rmSync.mockImplementation(() => {});

      // lstatSync: profile dir IS a symlink
      (mockFs.lstatSync as jest.Mock).mockReturnValue({
        isSymbolicLink: () => true
      });

      configManager.removeProfile('claude-shared');

      const profileDir = path.join(mockHomeDir, '.claude-shared');

      // Should use unlinkSync for the profile dir
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(profileDir);
      // Should NOT use rmSync for the profile dir
      const rmSyncCalls = (mockFs.rmSync as jest.Mock).mock.calls;
      const rmSyncOnProfileDir = rmSyncCalls.some(
        (args: any[]) => args[0] === profileDir
      );
      expect(rmSyncOnProfileDir).toBe(false);
    });
  });

  describe('setupSharedDirs', () => {
    const SHAREABLE_DIRS = ['projects', 'plans', 'tasks', 'commands', 'plugins'];

    beforeEach(() => {
      jest.clearAllMocks();
      mockOs.homedir.mockReturnValue(mockHomeDir);
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined as any);
      configManager = new ConfigManager();
    });

    test('creates symlinks for all SHAREABLE_DIRS when sharing with claude default', () => {
      // Profile dir exists, master (claude default) dirs do not
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined as any);
      (mockFs.lstatSync as jest.Mock).mockImplementation(() => {
        throw new Error('no such file');
      });
      const symlinkSpy = jest.spyOn(fs, 'symlinkSync').mockImplementation(() => {});

      configManager.setupSharedDirs('claude-work', 'claude');

      const profileDir = path.join(mockHomeDir, '.claude-work');
      const masterDir = path.join(mockHomeDir, '.claude');

      expect(symlinkSpy).toHaveBeenCalledTimes(SHAREABLE_DIRS.length);
      SHAREABLE_DIRS.forEach(dir => {
        const linkPath = path.join(profileDir, dir);
        const targetPath = path.join(masterDir, dir);
        expect(symlinkSpy).toHaveBeenCalledWith(targetPath, linkPath);
      });

      symlinkSpy.mockRestore();
    });

    test('creates target dir in master profile if it does not exist', () => {
      // Target doesn't exist — existsSync returns false for target, true for profile dir
      mockFs.existsSync.mockImplementation((p: any) => {
        // Directories of the profile exist, but master sub-dirs do not
        return String(p).includes('.sweech') || String(p).includes('.claude-work');
      });
      mockFs.mkdirSync.mockImplementation(() => undefined as any);
      (mockFs.lstatSync as jest.Mock).mockImplementation(() => {
        throw new Error('no such file');
      });
      const symlinkSpy = jest.spyOn(fs, 'symlinkSync').mockImplementation(() => {});

      configManager.setupSharedDirs('claude-work', 'claude');

      // mkdirSync should have been called for master sub-dirs
      const masterDir = path.join(mockHomeDir, '.claude');
      const mkdirCalls = (mockFs.mkdirSync as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      const masterDirCreations = mkdirCalls.filter((p: string) =>
        SHAREABLE_DIRS.some(d => p === path.join(masterDir, d))
      );
      expect(masterDirCreations.length).toBeGreaterThan(0);

      symlinkSpy.mockRestore();
    });

    test('creates symlinks for all SHAREABLE_DIRS when sharing with another sweech profile', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined as any);
      (mockFs.lstatSync as jest.Mock).mockImplementation(() => {
        throw new Error('no such file');
      });
      const symlinkSpy = jest.spyOn(fs, 'symlinkSync').mockImplementation(() => {});

      configManager.setupSharedDirs('claude-personal', 'claude-work');

      const profileDir = path.join(mockHomeDir, '.claude-personal');
      const masterDir = path.join(mockHomeDir, '.claude-work');

      SHAREABLE_DIRS.forEach(dir => {
        const linkPath = path.join(profileDir, dir);
        const targetPath = path.join(masterDir, dir);
        expect(symlinkSpy).toHaveBeenCalledWith(targetPath, linkPath);
      });

      symlinkSpy.mockRestore();
    });

    test('removes existing dir before creating symlink', () => {
      // Simulate existing dirs at link paths
      mockFs.existsSync.mockReturnValue(true);
      (mockFs.lstatSync as jest.Mock).mockReturnValue({ isSymbolicLink: () => false });
      mockFs.rmSync.mockImplementation(() => {});
      const symlinkSpy = jest.spyOn(fs, 'symlinkSync').mockImplementation(() => {});
      mockFs.mkdirSync.mockImplementation(() => undefined as any);

      configManager.setupSharedDirs('claude-work', 'claude');

      // rmSync should have been called to remove existing dirs
      expect(mockFs.rmSync).toHaveBeenCalled();
      // symlinkSync should still be called for all dirs
      expect(symlinkSpy).toHaveBeenCalledTimes(SHAREABLE_DIRS.length);

      symlinkSpy.mockRestore();
    });
  });

  describe('createProfileConfig', () => {
    test('creates settings.json with correct structure', () => {
      const provider = getProvider('minimax')!;
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined as any);
      mockFs.writeFileSync.mockImplementation(() => {});

      configManager.createProfileConfig('claude-mini', provider, 'sk-test-key');

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const callArgs = mockFs.writeFileSync.mock.calls[0];

      const settingsPath = callArgs[0] as string;
      expect(settingsPath).toContain('.claude-mini/settings.json');

      const settings = JSON.parse(callArgs[1] as string);
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-key');
      expect(settings.env.ANTHROPIC_BASE_URL).toBe(provider.baseUrl);
      expect(settings.env.ANTHROPIC_MODEL).toBe(provider.defaultModel);
    });

    test('adds timeout for MiniMax provider', () => {
      const provider = getProvider('minimax')!;
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined as any);
      mockFs.writeFileSync.mockImplementation(() => {});

      configManager.createProfileConfig('claude-mini', provider, 'sk-test');

      const settings = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(settings.env.API_TIMEOUT_MS).toBe('3000000');
    });

    test('does not add timeout for other providers', () => {
      const provider = getProvider('qwen')!;
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => undefined as any);
      mockFs.writeFileSync.mockImplementation(() => {});

      configManager.createProfileConfig('claude-qwen', provider, 'sk-test');

      const settings = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
      expect(settings.env.API_TIMEOUT_MS).toBeUndefined();
    });
  });

  describe('createWrapperScript', () => {
    test('creates executable bash script', () => {
      const cli = getDefaultCLI();
      mockFs.writeFileSync.mockImplementation(() => {});

      configManager.createWrapperScript('claude-mini', cli);

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const callArgs = mockFs.writeFileSync.mock.calls[0];

      const scriptPath = callArgs[0] as string;
      expect(scriptPath).toContain('bin/claude-mini');

      const scriptContent = callArgs[1] as string;
      expect(scriptContent).toContain('#!/bin/bash');
      expect(scriptContent).toContain('CLAUDE_CONFIG_DIR');
      expect(scriptContent).toContain('exec claude "${ARGS[@]}"');
      expect(scriptContent).toContain('--yolo');
      expect(scriptContent).toContain('--dangerously-skip-permissions');

      const options = callArgs[2] as any;
      expect(options.mode).toBe(0o755); // Executable
    });

    test('uses correct CLI configuration', () => {
      const cli = getDefaultCLI();
      mockFs.writeFileSync.mockImplementation(() => {});

      configManager.createWrapperScript('test-cmd', cli);

      const scriptContent = mockFs.writeFileSync.mock.calls[0][1] as string;
      expect(scriptContent).toContain(cli.configDirEnvVar);
      expect(scriptContent).toContain(`exec ${cli.command}`);
    });
  });

  describe('Path getters', () => {
    test('getBinDir returns correct path', () => {
      const binDir = configManager.getBinDir();
      expect(binDir).toBe(path.join(mockConfigDir, 'bin'));
    });

    test('getProfileDir returns correct path', () => {
      const profileDir = configManager.getProfileDir('claude-mini');
      expect(profileDir).toBe(path.join(mockHomeDir, '.claude-mini'));
    });

    test('getConfigDir returns correct path', () => {
      const configDir = configManager.getConfigDir();
      expect(configDir).toBe(mockConfigDir);
    });

    test('getConfigFile returns correct path', () => {
      const configFile = configManager.getConfigFile();
      expect(configFile).toBe(mockConfigFile);
    });

    test('getProfilesDir returns correct path', () => {
      const profilesDir = configManager.getProfilesDir();
      expect(profilesDir).toBe(path.join(mockConfigDir, 'profiles'));
    });
  });
});
