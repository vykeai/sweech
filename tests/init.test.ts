/**
 * Tests for interactive onboarding flow (init command + first-run detection)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock modules before importing subjects
jest.mock('fs');
jest.mock('os');
jest.mock('child_process');
const mockPrompt = jest.fn();
jest.mock('inquirer', () => {
  return {
    __esModule: true,
    default: { prompt: mockPrompt },
    prompt: mockPrompt
  };
});
jest.mock('chalk', () => {
  const identity = (str: any) => String(str);
  const fn: any = Object.assign(identity, {
    red: Object.assign(identity, { bold: identity }),
    green: Object.assign(identity, { bold: identity }),
    cyan: Object.assign(identity, { bold: identity }),
    yellow: Object.assign(identity, { bold: identity }),
    gray: identity,
    dim: identity,
    magenta: identity,
    bold: Object.assign(identity, {
      cyan: identity,
      green: identity,
      red: identity
    }),
  });
  return fn;
});
jest.mock('../src/interactive', () => ({
  interactiveAddProvider: jest.fn()
}));
jest.mock('../src/providers', () => ({
  getProvider: jest.fn().mockReturnValue({
    name: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: undefined,
    defaultModel: undefined,
    smallFastModel: undefined
  }),
  getProviderList: jest.fn().mockReturnValue([])
}));
jest.mock('../src/clis', () => ({
  getCLI: jest.fn().mockReturnValue({
    name: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    configDirEnvVar: 'CLAUDE_CONFIG_DIR',
    yoloFlag: '--dangerously-skip-permissions',
    resumeFlag: '--continue'
  }),
  getDefaultCLI: jest.fn(),
  SUPPORTED_CLIS: {
    claude: { name: 'claude', displayName: 'Claude Code', command: 'claude' },
    codex: { name: 'codex', displayName: 'Codex (OpenAI)', command: 'codex' }
  }
}));
jest.mock('../src/cliDetection', () => ({
  detectInstalledCLIs: jest.fn().mockResolvedValue([
    {
      cli: { name: 'claude', displayName: 'Claude Code', command: 'claude', installUrl: 'https://claude.ai' },
      installed: true,
      version: 'claude 1.0.0'
    },
    {
      cli: { name: 'codex', displayName: 'Codex (OpenAI)', command: 'codex', installUrl: 'https://openai.com' },
      installed: false
    }
  ]),
  formatCLIChoices: jest.fn()
}));
jest.mock('../src/utilityCommands', () => ({
  runDoctor: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../src/profileCreation', () => ({
  createProfile: jest.fn().mockResolvedValue(undefined)
}));

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

import { isFirstRun, runInit } from '../src/init';
import { ConfigManager } from '../src/config';
import { detectInstalledCLIs } from '../src/cliDetection';
import { interactiveAddProvider } from '../src/interactive';
import { runDoctor } from '../src/utilityCommands';

const mockDetectCLIs = detectInstalledCLIs as jest.MockedFunction<typeof detectInstalledCLIs>;
const mockInteractiveAdd = interactiveAddProvider as jest.MockedFunction<typeof interactiveAddProvider>;
const mockRunDoctor = runDoctor as jest.MockedFunction<typeof runDoctor>;

describe('Init / Onboarding', () => {
  const mockHomeDir = '/mock/home';

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrompt.mockReset();
    mockOs.homedir.mockReturnValue(mockHomeDir);
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockImplementation(() => undefined as any);
    mockFs.readFileSync.mockReturnValue('[]');
    mockFs.writeFileSync.mockImplementation(() => undefined);
    mockFs.appendFileSync.mockImplementation(() => undefined);

    // Suppress console output during tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isFirstRun', () => {
    test('returns true when no profiles exist (empty config file)', () => {
      mockFs.existsSync.mockReturnValue(false);
      const config = new ConfigManager();
      expect(isFirstRun(config)).toBe(true);
    });

    test('returns true when config file is empty array', () => {
      mockFs.existsSync.mockImplementation((p: any) => {
        if (String(p).endsWith('config.json')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue('[]');
      const config = new ConfigManager();
      expect(isFirstRun(config)).toBe(true);
    });

    test('returns false when profiles exist', () => {
      const profile = {
        name: 'test',
        commandName: 'claude-work',
        cliType: 'claude',
        provider: 'anthropic',
        createdAt: new Date().toISOString()
      };
      mockFs.existsSync.mockImplementation((p: any) => {
        if (String(p).endsWith('config.json')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify([profile]));
      const config = new ConfigManager();
      expect(isFirstRun(config)).toBe(false);
    });

    test('works without explicit ConfigManager argument', () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(isFirstRun()).toBe(true);
    });

    test('returns true with multiple empty config files', () => {
      // Config dir exists but no config.json
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('.sweech')) return true;
        if (s.endsWith('profiles')) return true;
        if (s.endsWith('bin')) return true;
        return false;
      });
      const config = new ConfigManager();
      expect(isFirstRun(config)).toBe(true);
    });
  });

  describe('runInit — first-run (no existing profiles)', () => {
    beforeEach(() => {
      // No existing profiles
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('.sweech') || s.endsWith('profiles') || s.endsWith('bin')) return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((p: any) => {
        if (String(p).endsWith('config.json')) throw new Error('ENOENT');
        return '';
      });
    });

    test('runs CLI detection during onboarding', async () => {
      // Mock inquirer to answer all prompts
      mockPrompt.mockResolvedValue({ addToPath: false } as any);
      mockInteractiveAdd.mockResolvedValue({
        cliType: 'claude',
        provider: 'anthropic',
        commandName: 'claude-work',
        authMethod: 'api-key',
        apiKey: 'sk-test'
      });
      // The function prompts multiple times — mock sequence
      mockPrompt
        .mockResolvedValueOnce({ addToPath: false } as any)   // PATH prompt
        .mockResolvedValueOnce({ installLater: true } as any)  // if no CLIs
        .mockResolvedValueOnce({ runDoctorCheck: false } as any); // doctor prompt

      await runInit();

      expect(mockDetectCLIs).toHaveBeenCalled();
    });

    test('offers to run doctor at the end', async () => {
      mockInteractiveAdd.mockResolvedValue({
        cliType: 'claude',
        provider: 'anthropic',
        commandName: 'claude-work',
        authMethod: 'api-key',
        apiKey: 'sk-test'
      });
      mockPrompt
        .mockResolvedValueOnce({ addToPath: false } as any)
        .mockResolvedValueOnce({ runDoctorCheck: true } as any);

      await runInit();

      expect(mockRunDoctor).toHaveBeenCalled();
    });

    test('skips doctor when user declines', async () => {
      mockInteractiveAdd.mockResolvedValue({
        cliType: 'claude',
        provider: 'anthropic',
        commandName: 'claude-work',
        authMethod: 'api-key',
        apiKey: 'sk-test'
      });
      mockPrompt
        .mockResolvedValueOnce({ addToPath: false } as any)
        .mockResolvedValueOnce({ runDoctorCheck: false } as any);

      await runInit();

      expect(mockRunDoctor).not.toHaveBeenCalled();
    });

    test('shows SweechBar suggestion in output', async () => {
      mockInteractiveAdd.mockResolvedValue({
        cliType: 'claude',
        provider: 'anthropic',
        commandName: 'claude-work',
        authMethod: 'api-key',
        apiKey: 'sk-test'
      });
      mockPrompt
        .mockResolvedValueOnce({ addToPath: false } as any)
        .mockResolvedValueOnce({ runDoctorCheck: false } as any);

      const logSpy = jest.spyOn(console, 'log');

      await runInit();

      const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain('SweechBar');
    });

    test('mentions next steps in final output', async () => {
      mockInteractiveAdd.mockResolvedValue({
        cliType: 'claude',
        provider: 'anthropic',
        commandName: 'claude-work',
        authMethod: 'api-key',
        apiKey: 'sk-test'
      });
      mockPrompt
        .mockResolvedValueOnce({ addToPath: false } as any)
        .mockResolvedValueOnce({ runDoctorCheck: false } as any);

      const logSpy = jest.spyOn(console, 'log');

      await runInit();

      const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain('sweech add');
      expect(allOutput).toContain('sweech doctor');
    });
  });

  describe('runInit — existing profiles (idempotent)', () => {
    const existingProfile = {
      name: 'work',
      commandName: 'claude-work',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: new Date().toISOString()
    };

    beforeEach(() => {
      mockFs.existsSync.mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('config.json')) return true;
        if (s.endsWith('.sweech') || s.endsWith('profiles') || s.endsWith('bin')) return true;
        return false;
      });
      mockFs.readFileSync.mockImplementation((p: any) => {
        if (String(p).endsWith('config.json')) return JSON.stringify([existingProfile]);
        return '';
      });
    });

    test('shows existing profiles and asks to continue', async () => {
      mockPrompt.mockResolvedValueOnce({ continueAnyway: false } as any);

      const logSpy = jest.spyOn(console, 'log');

      await runInit();

      const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain('claude-work');
      expect(allOutput).toContain('already have providers');
    });

    test('exits early when user declines to add another', async () => {
      mockPrompt.mockResolvedValueOnce({ continueAnyway: false } as any);

      await runInit();

      // Should not call detectInstalledCLIs since we exited early
      expect(mockDetectCLIs).not.toHaveBeenCalled();
    });

    test('continues flow when user wants to add another provider', async () => {
      mockPrompt
        .mockResolvedValueOnce({ continueAnyway: true } as any)   // continue
        .mockResolvedValueOnce({ addToPath: false } as any)        // PATH
        .mockResolvedValueOnce({ runDoctorCheck: false } as any);  // doctor

      mockInteractiveAdd.mockResolvedValue({
        cliType: 'claude',
        provider: 'anthropic',
        commandName: 'claude-personal',
        authMethod: 'api-key',
        apiKey: 'sk-test2'
      });

      await runInit();

      expect(mockDetectCLIs).toHaveBeenCalled();
      expect(mockInteractiveAdd).toHaveBeenCalled();
    });
  });

  describe('runInit — CLI detection integration', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    });

    test('shows detected CLIs', async () => {
      mockDetectCLIs.mockResolvedValue([
        {
          cli: { name: 'claude', displayName: 'Claude Code', command: 'claude', installUrl: 'https://claude.ai', configDirEnvVar: 'CLAUDE_CONFIG_DIR', description: '', yoloFlag: '', resumeFlag: '' },
          installed: true,
          version: 'claude 1.5.0'
        },
        {
          cli: { name: 'codex', displayName: 'Codex (OpenAI)', command: 'codex', installUrl: 'https://openai.com', configDirEnvVar: 'CODEX_CONFIG_DIR', description: '', yoloFlag: '', resumeFlag: '' },
          installed: false
        }
      ]);

      mockInteractiveAdd.mockResolvedValue({
        cliType: 'claude',
        provider: 'anthropic',
        commandName: 'claude-work',
        authMethod: 'api-key',
        apiKey: 'sk-test'
      });
      mockPrompt
        .mockResolvedValueOnce({ addToPath: false } as any)
        .mockResolvedValueOnce({ runDoctorCheck: false } as any);

      const logSpy = jest.spyOn(console, 'log');

      await runInit();

      const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain('Claude Code');
      expect(allOutput).toContain('detected');
    });

    test('warns when no CLIs are installed and user declines', async () => {
      mockDetectCLIs.mockResolvedValue([
        {
          cli: { name: 'claude', displayName: 'Claude Code', command: 'claude', installUrl: 'https://claude.ai', configDirEnvVar: 'CLAUDE_CONFIG_DIR', description: '', yoloFlag: '', resumeFlag: '' },
          installed: false
        },
        {
          cli: { name: 'codex', displayName: 'Codex (OpenAI)', command: 'codex', installUrl: 'https://openai.com', configDirEnvVar: 'CODEX_CONFIG_DIR', description: '', yoloFlag: '', resumeFlag: '' },
          installed: false
        }
      ]);

      mockPrompt
        .mockResolvedValueOnce({ addToPath: false } as any)
        .mockResolvedValueOnce({ installLater: false } as any);

      const logSpy = jest.spyOn(console, 'log');

      await runInit();

      const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain('No supported CLIs found');
      // Should not have proceeded to provider setup
      expect(mockInteractiveAdd).not.toHaveBeenCalled();
    });
  });

  describe('runInit — error handling', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      // Re-set CLI detection mock (clearAllMocks may have reset it)
      mockDetectCLIs.mockResolvedValue([
        {
          cli: { name: 'claude', displayName: 'Claude Code', command: 'claude', installUrl: 'https://claude.ai', configDirEnvVar: 'CLAUDE_CONFIG_DIR', description: '', yoloFlag: '', resumeFlag: '' },
          installed: true,
          version: 'claude 1.0.0'
        }
      ]);
    });

    test('handles provider setup failure gracefully', async () => {
      mockInteractiveAdd.mockRejectedValue(new Error('User cancelled'));
      mockPrompt.mockResolvedValueOnce({ addToPath: false } as any);

      const errorSpy = jest.spyOn(console, 'error');

      await runInit();

      const errorOutput = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errorOutput).toContain('Setup failed');
    });

    test('handles non-Error thrown objects', async () => {
      mockInteractiveAdd.mockRejectedValue('string error');
      mockPrompt.mockResolvedValueOnce({ addToPath: false } as any);

      const errorSpy = jest.spyOn(console, 'error');

      await runInit();

      const errorOutput = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errorOutput).toContain('Setup failed');
    });
  });

  describe('runInit — PATH detection', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    });

    test('detects when sweech is already in PATH', async () => {
      const binDir = path.join(mockHomeDir, '.sweech', 'bin');
      const origPath = process.env.PATH;
      process.env.PATH = `${binDir}:/usr/bin`;

      mockInteractiveAdd.mockResolvedValue({
        cliType: 'claude',
        provider: 'anthropic',
        commandName: 'claude-work',
        authMethod: 'api-key',
        apiKey: 'sk-test'
      });
      mockPrompt.mockResolvedValueOnce({ runDoctorCheck: false } as any);

      const logSpy = jest.spyOn(console, 'log');

      await runInit();

      const allOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allOutput).toContain('Sweech is in your PATH');

      process.env.PATH = origPath;
    });
  });

  describe('No-args handler integration', () => {
    test('isFirstRun returns true for fresh install', () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(isFirstRun()).toBe(true);
    });

    test('isFirstRun returns false after profiles are added', () => {
      const profile = {
        name: 'test',
        commandName: 'claude-work',
        cliType: 'claude',
        provider: 'anthropic',
        createdAt: new Date().toISOString()
      };
      mockFs.existsSync.mockImplementation((p: any) => {
        if (String(p).endsWith('config.json')) return true;
        return false;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify([profile]));
      expect(isFirstRun()).toBe(false);
    });
  });
});
