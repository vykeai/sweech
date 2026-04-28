/**
 * Tests for sweech share / unshare commands
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockPrompt = jest.fn();

jest.mock('fs');
jest.mock('os');
jest.mock('inquirer', () => ({
  __esModule: true,
  default: { prompt: mockPrompt },
}));
jest.mock('chalk', () => {
  const passthrough = (s: string) => s;
  const handler: ProxyHandler<any> = {
    get: () => new Proxy(passthrough, handler),
    apply: (_t: any, _this: any, args: any[]) => args[0],
  };
  return { __esModule: true, default: new Proxy(passthrough, handler) };
});

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

import { runShare, runUnshare, runShareStatus, SKILLS_ITEMS, DATA_ITEMS } from '../src/shareCommands';
import { SHAREABLE_DIRS, SHAREABLE_FILES } from '../src/config';

const HOME = '/mock/home';

function setupMocks(profiles: any[] = []) {
  mockOs.homedir.mockReturnValue(HOME);
  mockFs.existsSync.mockReturnValue(true);
  mockFs.mkdirSync.mockImplementation(() => undefined as any);
  mockFs.writeFileSync.mockImplementation(() => undefined);
  mockFs.symlinkSync.mockImplementation(() => undefined);
  mockFs.unlinkSync.mockImplementation(() => undefined);
  mockFs.rmSync.mockImplementation(() => undefined);
  mockFs.readFileSync.mockImplementation((p: any) => {
    if (String(p).endsWith('config.json')) return JSON.stringify(profiles);
    return '{}';
  });
  // Default: items are NOT symlinks
  mockFs.lstatSync.mockImplementation(() => {
    throw new Error('ENOENT');
  });
}

function makeProfile(name: string, extra: any = {}) {
  return {
    name,
    commandName: name,
    cliType: 'claude',
    provider: 'dashscope',
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

// Suppress process.exit
jest.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

const mockConsoleError = console.error as jest.Mock;
const mockConsoleLog = console.log as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Item categorization ──────────────────────────────────────────────────────

describe('Item categorization', () => {
  test('SKILLS_ITEMS contains expected items', () => {
    expect(SKILLS_ITEMS).toContain('commands');
    expect(SKILLS_ITEMS).toContain('mcp.json');
    expect(SKILLS_ITEMS).toContain('hooks');
    expect(SKILLS_ITEMS).toContain('agents');
    expect(SKILLS_ITEMS).toContain('CLAUDE.md');
  });

  test('DATA_ITEMS contains expected items', () => {
    expect(DATA_ITEMS).toContain('projects');
    expect(DATA_ITEMS).toContain('plans');
    expect(DATA_ITEMS).toContain('tasks');
    expect(DATA_ITEMS).toContain('todos');
    expect(DATA_ITEMS).toContain('teams');
    expect(DATA_ITEMS).toContain('plugins');
  });

  test('SKILLS + DATA covers all SHAREABLE_DIRS + SHAREABLE_FILES', () => {
    const all = new Set([...SKILLS_ITEMS, ...DATA_ITEMS]);
    for (const dir of SHAREABLE_DIRS) expect(all.has(dir)).toBe(true);
    for (const file of SHAREABLE_FILES) expect(all.has(file)).toBe(true);
  });

  test('no item appears in both SKILLS and DATA', () => {
    const skills = new Set<string>(SKILLS_ITEMS);
    for (const item of DATA_ITEMS) {
      expect(skills.has(item)).toBe(false);
    }
  });
});

// ── sweech share ─────────────────────────────────────────────────────────────

describe('runShare', () => {
  test('errors if profile not found', async () => {
    setupMocks([]);
    await expect(runShare('nonexistent', {})).rejects.toThrow('exit');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  test('errors if source dir does not exist', async () => {
    setupMocks([makeProfile('claude-ali')]);
    mockFs.existsSync.mockImplementation((p: any) => {
      if (String(p) === path.join(HOME, '.claude')) return false;
      return true;
    });
    await expect(runShare('claude-ali', { from: 'claude' })).rejects.toThrow('exit');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  test('errors on circular sharing', async () => {
    const profiles = [
      makeProfile('claude-ali'),
      makeProfile('claude-z', { sharedWith: 'claude-ali' }),
    ];
    setupMocks(profiles);
    await expect(runShare('claude-ali', { from: 'claude-z' })).rejects.toThrow('exit');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('Circular'));
  });

  test('--all shares all shareable items', async () => {
    setupMocks([makeProfile('claude-ali')]);
    await runShare('claude-ali', { all: true });

    const allItems = [...SHAREABLE_DIRS, ...SHAREABLE_FILES];
    const symlinkCalls = mockFs.symlinkSync.mock.calls;
    expect(symlinkCalls.length).toBe(allItems.length);

    for (const item of allItems) {
      expect(symlinkCalls.some(([target, link]) =>
        String(link).endsWith(`/${item}`) && String(target).includes('.claude/')
      )).toBe(true);
    }
  });

  test('--all skips already-shared items', async () => {
    setupMocks([makeProfile('claude-ali')]);

    mockFs.lstatSync.mockImplementation((p: any) => {
      if (String(p).endsWith('/commands')) {
        return { isSymbolicLink: () => true } as any;
      }
      throw new Error('ENOENT');
    });
    mockFs.readlinkSync.mockImplementation((p: any) => {
      if (String(p).endsWith('/commands')) return path.join(HOME, '.claude/commands');
      return '';
    });

    await runShare('claude-ali', { all: true });

    const symlinkCalls = mockFs.symlinkSync.mock.calls;
    expect(symlinkCalls.some(([_, link]) => String(link).endsWith('/commands'))).toBe(false);
  });

  test('interactive mode defaults skills items to checked', async () => {
    setupMocks([makeProfile('claude-ali')]);

    let capturedChoices: any[] = [];
    mockPrompt.mockImplementation(async (questions: any[]) => {
      capturedChoices = questions[0].choices;
      return { items: [] };
    });

    await runShare('claude-ali', {});

    for (const item of SKILLS_ITEMS) {
      const choice = capturedChoices.find((c: any) => c.value === item);
      expect(choice?.checked).toBe(true);
    }
    for (const item of DATA_ITEMS) {
      const choice = capturedChoices.find((c: any) => c.value === item);
      if (choice && !choice.disabled) {
        expect(choice?.checked).toBe(false);
      }
    }
  });

  test('creates target dir if it does not exist', async () => {
    setupMocks([makeProfile('claude-ali')]);
    mockFs.existsSync.mockImplementation((p: any) => {
      if (String(p).endsWith('/commands')) return false;
      return true;
    });

    await runShare('claude-ali', { all: true });

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('commands'),
      { recursive: true, mode: 0o700 }
    );
  });

  test('updates sharedWith in config.json', async () => {
    setupMocks([makeProfile('claude-ali')]);
    await runShare('claude-ali', { all: true });

    const writeCalls = mockFs.writeFileSync.mock.calls;
    const configWrite = writeCalls.find(([p]) => String(p).endsWith('config.json'));
    expect(configWrite).toBeTruthy();
    const saved = JSON.parse(configWrite![1] as string);
    expect(saved[0].sharedWith).toBe('claude');
  });

  test('resolves --from to custom profile dir', async () => {
    setupMocks([makeProfile('claude-ali'), makeProfile('claude-z')]);
    await runShare('claude-ali', { from: 'claude-z', all: true });

    const symlinkCalls = mockFs.symlinkSync.mock.calls;
    for (const [target] of symlinkCalls) {
      expect(String(target)).toContain('.claude-z/');
    }
  });
});

// ── sweech unshare ───────────────────────────────────────────────────────────

describe('runUnshare', () => {
  test('errors if profile not found', async () => {
    setupMocks([]);
    await expect(runUnshare('nonexistent', {})).rejects.toThrow('exit');
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  test('shows message when no items are shared', async () => {
    setupMocks([makeProfile('claude-ali')]);
    await runUnshare('claude-ali', {});
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('no shared items'));
  });

  test('--all removes all symlinks', async () => {
    setupMocks([makeProfile('claude-ali', { sharedWith: 'claude' })]);

    mockFs.lstatSync.mockImplementation((p: any) => {
      const name = path.basename(String(p));
      if (name === 'commands' || name === 'mcp.json') {
        return { isSymbolicLink: () => true } as any;
      }
      throw new Error('ENOENT');
    });
    mockFs.readlinkSync.mockImplementation(() => '/mock/target');

    await runUnshare('claude-ali', { all: true });

    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  test('creates empty dir after unlinking directory item', async () => {
    setupMocks([makeProfile('claude-ali', { sharedWith: 'claude' })]);

    mockFs.lstatSync.mockImplementation((p: any) => {
      if (path.basename(String(p)) === 'commands') {
        return { isSymbolicLink: () => true } as any;
      }
      throw new Error('ENOENT');
    });
    mockFs.readlinkSync.mockImplementation(() => '/mock/target');

    await runUnshare('claude-ali', { all: true });

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('commands'),
      { recursive: true, mode: 0o700 }
    );
  });

  test('creates empty file after unlinking file item', async () => {
    setupMocks([makeProfile('claude-ali', { sharedWith: 'claude' })]);

    mockFs.lstatSync.mockImplementation((p: any) => {
      if (path.basename(String(p)) === 'mcp.json') {
        return { isSymbolicLink: () => true } as any;
      }
      throw new Error('ENOENT');
    });
    mockFs.readlinkSync.mockImplementation(() => '/mock/target');

    await runUnshare('claude-ali', { all: true });

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('mcp.json'),
      ''
    );
  });

  test('clears sharedWith when all items unshared', async () => {
    setupMocks([makeProfile('claude-ali', { sharedWith: 'claude' })]);

    // Track which symlinks have been unlinked
    const unlinked = new Set<string>();
    mockFs.unlinkSync.mockImplementation((p: any) => { unlinked.add(String(p)); });

    mockFs.lstatSync.mockImplementation((p: any) => {
      const s = String(p);
      // After unlinkSync, the item is no longer a symlink
      if (unlinked.has(s)) throw new Error('ENOENT');
      if (path.basename(s) === 'commands') {
        return { isSymbolicLink: () => true } as any;
      }
      throw new Error('ENOENT');
    });
    mockFs.readlinkSync.mockImplementation(() => '/mock/target');

    await runUnshare('claude-ali', { all: true });

    const configWrite = mockFs.writeFileSync.mock.calls.find(([p]) => String(p).endsWith('config.json'));
    expect(configWrite).toBeTruthy();
    const saved = JSON.parse(configWrite![1] as string);
    expect(saved[0].sharedWith).toBeUndefined();
  });
});

// ── sweech share --status ────────────────────────────────────────────────────

describe('runShareStatus', () => {
  test('handles empty profile list', async () => {
    setupMocks([]);
    await runShareStatus();
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('No profiles'));
  });

  test('shows isolated profiles', async () => {
    setupMocks([makeProfile('claude-solo')]);
    await runShareStatus();
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('isolated'));
  });

  test('shows shared profiles with source', async () => {
    setupMocks([makeProfile('claude-ali', { sharedWith: 'claude' })]);

    mockFs.lstatSync.mockImplementation((p: any) => {
      if (path.basename(String(p)) === 'commands') {
        return { isSymbolicLink: () => true } as any;
      }
      throw new Error('ENOENT');
    });
    mockFs.readlinkSync.mockImplementation(() => '/mock/target');

    await runShareStatus();
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('claude'));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('commands'));
  });

  test('shows reverse dependencies', async () => {
    setupMocks([
      makeProfile('claude-ali', { sharedWith: 'claude' }),
      makeProfile('claude-z', { sharedWith: 'claude' }),
    ]);

    await runShareStatus();
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('shared by'));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('claude-ali'));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('claude-z'));
  });
});
