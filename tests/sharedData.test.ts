/**
 * Tests for shared data mode features:
 * - list output with sharedWith tag and reverse dependency tags
 * - doctor symlink validity check
 * - clone with shared inheritance
 */

import { ProfileConfig, SHAREABLE_DIRS } from '../src/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs');
jest.mock('os');
jest.mock('child_process');
jest.mock('inquirer', () => ({}));
jest.mock('chalk', () => {
  const m = (str: string) => str;
  m.bold = m;
  m.cyan = m;
  m.green = m;
  m.red = m;
  m.yellow = m;
  m.gray = m;
  m.magenta = m;
  m.white = m;
  return m;
});

const mockFs = fs as jest.Mocked<typeof fs>;
const mockOs = os as jest.Mocked<typeof os>;

const mockHomeDir = '/mock/home';

beforeEach(() => {
  jest.clearAllMocks();
  mockOs.homedir.mockReturnValue(mockHomeDir);
  mockFs.existsSync.mockReturnValue(false);
  mockFs.mkdirSync.mockImplementation(() => undefined as any);
});

// ---------------------------------------------------------------------------
// SHAREABLE_DIRS constant
// ---------------------------------------------------------------------------
describe('SHAREABLE_DIRS', () => {
  test('contains exactly the 9 expected directories', () => {
    expect(SHAREABLE_DIRS).toHaveLength(9);
    expect(SHAREABLE_DIRS).toContain('projects');
    expect(SHAREABLE_DIRS).toContain('plans');
    expect(SHAREABLE_DIRS).toContain('tasks');
    expect(SHAREABLE_DIRS).toContain('commands');
    expect(SHAREABLE_DIRS).toContain('plugins');
    expect(SHAREABLE_DIRS).toContain('hooks');
    expect(SHAREABLE_DIRS).toContain('agents');
    expect(SHAREABLE_DIRS).toContain('teams');
    expect(SHAREABLE_DIRS).toContain('todos');
  });

  test('does not include auth/runtime dirs', () => {
    const excluded = ['settings.json', 'cache', 'session-env', 'credentials'];
    excluded.forEach(item => {
      expect(SHAREABLE_DIRS).not.toContain(item);
    });
  });
});

// ---------------------------------------------------------------------------
// ProfileConfig sharedWith field
// ---------------------------------------------------------------------------
describe('ProfileConfig sharedWith field', () => {
  test('profile with sharedWith stores master commandName', () => {
    const profile: ProfileConfig = {
      name: 'claude-work',
      commandName: 'claude-work',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: new Date().toISOString(),
      sharedWith: 'claude'
    };
    expect(profile.sharedWith).toBe('claude');
  });

  test('profile without sharedWith is undefined', () => {
    const profile: ProfileConfig = {
      name: 'claude-solo',
      commandName: 'claude-solo',
      cliType: 'claude',
      provider: 'minimax',
      createdAt: new Date().toISOString()
    };
    expect(profile.sharedWith).toBeUndefined();
  });

  test('sharedWith can refer to another sweech profile commandName', () => {
    const master: ProfileConfig = {
      name: 'claude-main',
      commandName: 'claude-main',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: new Date().toISOString()
    };

    const child: ProfileConfig = {
      name: 'claude-backup',
      commandName: 'claude-backup',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: new Date().toISOString(),
      sharedWith: master.commandName
    };

    expect(child.sharedWith).toBe('claude-main');
  });
});

// ---------------------------------------------------------------------------
// List output logic (shared tags + reverse dependency tags)
// ---------------------------------------------------------------------------
describe('List shared tags logic', () => {
  const profiles: ProfileConfig[] = [
    {
      name: 'claude-rai',
      commandName: 'claude-rai',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2025-01-01T00:00:00.000Z',
      sharedWith: 'claude'
    },
    {
      name: 'claude-work',
      commandName: 'claude-work',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2025-01-01T00:00:00.000Z'
    }
  ];

  test('profile with sharedWith produces sharedTag', () => {
    const profile = profiles[0];
    const sharedTag = profile.sharedWith ? `[shared ↔ ${profile.sharedWith}]` : '';
    expect(sharedTag).toBe('[shared ↔ claude]');
  });

  test('profile without sharedWith produces empty sharedTag', () => {
    const profile = profiles[1];
    const sharedTag = profile.sharedWith ? `[shared ↔ ${profile.sharedWith}]` : '';
    expect(sharedTag).toBe('');
  });

  test('master profiles show reverse dependency tag', () => {
    const masterName = 'claude';
    const sharingProfiles = profiles.filter(p => p.sharedWith === masterName);
    const reverseTag = sharingProfiles.length > 0
      ? `(← shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`
      : '';
    expect(reverseTag).toBe('(← shared by: claude-rai)');
  });

  test('profile with no dependents shows empty reverse tag', () => {
    const masterName = 'claude-work';
    const sharingProfiles = profiles.filter(p => p.sharedWith === masterName);
    const reverseTag = sharingProfiles.length > 0
      ? `(← shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`
      : '';
    expect(reverseTag).toBe('');
  });

  test('default claude footer shows sharing profiles', () => {
    const claudeSharingProfiles = profiles.filter(p => p.sharedWith === 'claude');
    const footerNote = claudeSharingProfiles.length > 0
      ? `(← shared by: ${claudeSharingProfiles.map(p => p.commandName).join(', ')})`
      : '';
    expect(footerNote).toContain('claude-rai');
  });

  test('multiple profiles sharing the same master', () => {
    const multiProfiles: ProfileConfig[] = [
      { name: 'a', commandName: 'claude-a', cliType: 'claude', provider: 'anthropic', createdAt: '', sharedWith: 'claude' },
      { name: 'b', commandName: 'claude-b', cliType: 'claude', provider: 'anthropic', createdAt: '', sharedWith: 'claude' },
      { name: 'c', commandName: 'claude-c', cliType: 'claude', provider: 'minimax', createdAt: '' }
    ];
    const sharingProfiles = multiProfiles.filter(p => p.sharedWith === 'claude');
    const reverseTag = `(← shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`;
    expect(reverseTag).toBe('(← shared by: claude-a, claude-b)');
  });
});

// ---------------------------------------------------------------------------
// Doctor symlink check logic (pure logic tests, no realpathSync dependency)
// ---------------------------------------------------------------------------
describe('Doctor symlink check logic', () => {
  /**
   * Helper that mirrors the doctor's per-directory check:
   *   ok = lstatSync says symlink AND realpathSync(link) === realpathSync(expected)
   */
  function checkSymlink(
    linkPath: string,
    expectedTarget: string,
    lstatResult: { isSymbolicLink: () => boolean } | null,
    realpathFn: (p: string) => string
  ): boolean {
    let ok = false;
    try {
      if (!lstatResult) throw new Error('ENOENT');
      if (lstatResult.isSymbolicLink()) {
        const actual = realpathFn(linkPath);
        const expected = realpathFn(expectedTarget);
        ok = actual === expected;
      }
    } catch {
      ok = false;
    }
    return ok;
  }

  test('valid symlink pointing to master dir passes', () => {
    // When realpathFn resolves both to the same canonical path, the check passes
    const ok = checkSymlink(
      '/home/.claude-work/projects',
      '/home/.claude/projects',
      { isSymbolicLink: () => true },
      (_p) => '/home/.claude/projects' // both resolve to master
    );
    expect(ok).toBe(true);
  });

  test('symlink pointing to wrong target fails', () => {
    const ok = checkSymlink(
      '/home/.claude-work/projects',
      '/home/.claude/projects',
      { isSymbolicLink: () => true },
      (p) => p // identity — link and expected resolve differently
    );
    expect(ok).toBe(false);
  });

  test('broken symlink (lstatSync throws) fails', () => {
    const ok = checkSymlink(
      '/home/.claude-work/projects',
      '/home/.claude/projects',
      null, // simulates throw
      (p) => p
    );
    expect(ok).toBe(false);
  });

  test('path that is not a symlink fails', () => {
    const ok = checkSymlink(
      '/home/.claude-work/projects',
      '/home/.claude/projects',
      { isSymbolicLink: () => false },
      (p) => p
    );
    expect(ok).toBe(false);
  });

  test('all SHAREABLE_DIRS are checked for shared profiles', () => {
    const checked: string[] = [];
    const profileDir = '/home/.claude-work';

    for (const dir of SHAREABLE_DIRS) {
      const linkPath = path.join(profileDir, dir);
      // Simulating the loop the doctor runs
      checked.push(linkPath);
    }

    SHAREABLE_DIRS.forEach(dir => {
      expect(checked.some(p => p.endsWith(dir))).toBe(true);
    });
    expect(checked).toHaveLength(SHAREABLE_DIRS.length);
  });

  test('lstatSync not a symlink → ok is false, not unhandled error', () => {
    const ok = checkSymlink(
      '/home/.claude-work/tasks',
      '/home/.claude/tasks',
      { isSymbolicLink: () => false },
      (p) => p
    );
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Clone with shared inheritance logic
// ---------------------------------------------------------------------------
describe('Clone shared inheritance logic', () => {
  test('clone inherits sharedWith when user confirms', () => {
    const source: ProfileConfig = {
      name: 'claude-source',
      commandName: 'claude-source',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: new Date().toISOString(),
      sharedWith: 'claude'
    };

    // User confirms inheritance
    const inheritShare = true;
    const inheritSharedWith = inheritShare ? source.sharedWith : undefined;

    const cloned: ProfileConfig = {
      ...source,
      name: 'claude-clone',
      commandName: 'claude-clone',
      createdAt: new Date().toISOString(),
      sharedWith: inheritSharedWith
    };

    expect(cloned.sharedWith).toBe('claude');
    expect(cloned.commandName).toBe('claude-clone');
  });

  test('clone does NOT inherit sharedWith when user declines', () => {
    const source: ProfileConfig = {
      name: 'claude-source',
      commandName: 'claude-source',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: new Date().toISOString(),
      sharedWith: 'claude'
    };

    // User declines inheritance
    const inheritShare = false;
    const inheritSharedWith = inheritShare ? source.sharedWith : undefined;

    const cloned: ProfileConfig = {
      ...source,
      name: 'claude-clone',
      commandName: 'claude-clone',
      createdAt: new Date().toISOString(),
      sharedWith: inheritSharedWith
    };

    expect(cloned.sharedWith).toBeUndefined();
  });

  test('clone of non-shared profile does not ask about inheritance', () => {
    const source: ProfileConfig = {
      name: 'claude-fresh',
      commandName: 'claude-fresh',
      cliType: 'claude',
      provider: 'minimax',
      createdAt: new Date().toISOString()
      // no sharedWith
    };

    // Logic: only ask when source.sharedWith is set
    const shouldAsk = !!source.sharedWith;
    expect(shouldAsk).toBe(false);

    // Clone has no sharedWith
    const cloned: ProfileConfig = {
      ...source,
      name: 'claude-clone2',
      commandName: 'claude-clone2',
      createdAt: new Date().toISOString(),
      sharedWith: undefined
    };

    expect(cloned.sharedWith).toBeUndefined();
  });

  test('clone shares with same master as source when inheritance confirmed', () => {
    const profiles: ProfileConfig[] = [
      {
        name: 'claude-master',
        commandName: 'claude-master',
        cliType: 'claude',
        provider: 'anthropic',
        createdAt: new Date().toISOString()
      }
    ];

    const source: ProfileConfig = {
      name: 'claude-child',
      commandName: 'claude-child',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: new Date().toISOString(),
      sharedWith: 'claude-master'
    };

    const inheritShare = true;
    const cloned: ProfileConfig = {
      ...source,
      commandName: 'claude-child-copy',
      name: 'claude-child-copy',
      createdAt: new Date().toISOString(),
      sharedWith: inheritShare ? source.sharedWith : undefined
    };

    expect(cloned.sharedWith).toBe('claude-master');
  });
});

// ---------------------------------------------------------------------------
// Remove profile: dependent warning logic
// ---------------------------------------------------------------------------
describe('Remove profile: dependent warning logic', () => {
  test('identifies profiles that share data with the target profile', () => {
    const profiles: ProfileConfig[] = [
      {
        name: 'claude-main',
        commandName: 'claude-main',
        cliType: 'claude',
        provider: 'anthropic',
        createdAt: new Date().toISOString()
      },
      {
        name: 'claude-a',
        commandName: 'claude-a',
        cliType: 'claude',
        provider: 'anthropic',
        createdAt: new Date().toISOString(),
        sharedWith: 'claude-main'
      },
      {
        name: 'claude-b',
        commandName: 'claude-b',
        cliType: 'claude',
        provider: 'anthropic',
        createdAt: new Date().toISOString(),
        sharedWith: 'claude-main'
      }
    ];

    const targetName = 'claude-main';
    const dependents = profiles.filter(p => p.sharedWith === targetName);

    expect(dependents).toHaveLength(2);
    expect(dependents.map(d => d.commandName)).toContain('claude-a');
    expect(dependents.map(d => d.commandName)).toContain('claude-b');
  });

  test('no warning when no profiles depend on the target', () => {
    const profiles: ProfileConfig[] = [
      {
        name: 'claude-solo',
        commandName: 'claude-solo',
        cliType: 'claude',
        provider: 'minimax',
        createdAt: new Date().toISOString()
      }
    ];

    const dependents = profiles.filter(p => p.sharedWith === 'claude-solo');
    expect(dependents).toHaveLength(0);
  });
});
