/**
 * Tests for src/workspaceCrud.ts — workspace lifecycle CRUD.
 *
 * Uses real ConfigManager against an isolated $HOME so the keychain branch
 * stays out of scope (no API keys in the test profiles → no credential-store
 * writes).
 */

import * as fs from 'fs';
import * as path from 'path';

// CRITICAL: mock os.homedir() BEFORE importing any sweech module. macOS
// resolves homedir from getpwuid() inside libuv (not $HOME), so setting
// process.env.HOME is silently ignored — that's how a prior version of
// this test clobbered the developer's real ~/.sweech/config.json.
//
// jest.mock is hoisted to the top of the module, so this runs before
// the ConfigManager import below. `__mockHome` is rewritten per-test
// via setHomedir().
let __mockHome: string | null = null;
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    homedir: () => __mockHome ?? actual.homedir(),
  };
});
import * as os from 'os';
function setHomedir(p: string | null): void { __mockHome = p; }

import { ConfigManager, ProfileConfig } from '../src/config';
import {
  setWorkspaceFlag,
  deleteWorkspace,
  editWorkspace,
  listWorkspaces,
  sortProfilesByStatus,
  isWorkspaceInactive,
  profileFlags,
} from '../src/workspaceCrud';

function isolateHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-crud-test-'));
  setHomedir(home);
  return home;
}

function freshConfig(): ConfigManager {
  // ConfigManager reads os.homedir() at construct-time, which we've already
  // overridden via process.env.HOME above. Each test gets a clean instance
  // because the cached config file lives under the new $HOME.
  return new ConfigManager();
}

function seedProfile(over: Partial<ProfileConfig>): ProfileConfig {
  return {
    name: 'claude-test',
    commandName: 'claude-test',
    cliType: 'claude',
    provider: 'anthropic',
    createdAt: '2026-05-17T00:00:00.000Z',
    ...over,
  };
}

function writeProfiles(config: ConfigManager, profiles: ProfileConfig[]): void {
  config.writeProfiles(profiles);
  // Also create the data dirs so deleteWorkspace exercises the rm branch.
  for (const p of profiles) {
    const dir = config.getProfileDir(p.commandName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

describe('profileFlags / sortProfilesByStatus / isWorkspaceInactive', () => {
  test('profileFlags coerces undefined → false', () => {
    expect(profileFlags(seedProfile({}))).toEqual({ disabled: false, hidden: false });
    expect(profileFlags(seedProfile({ disabled: true }))).toEqual({ disabled: true, hidden: false });
    expect(profileFlags(seedProfile({ hidden: true }))).toEqual({ disabled: false, hidden: true });
  });

  test('sortProfilesByStatus tiers visible < disabled < hidden, alpha within tier', () => {
    const profiles = [
      seedProfile({ commandName: 'claude-c', hidden: true }),
      seedProfile({ commandName: 'claude-a' }),
      seedProfile({ commandName: 'claude-d', disabled: true }),
      seedProfile({ commandName: 'claude-b' }),
      seedProfile({ commandName: 'claude-e', disabled: true }),
    ];
    const sorted = sortProfilesByStatus(profiles).map(p => p.commandName);
    expect(sorted).toEqual(['claude-a', 'claude-b', 'claude-d', 'claude-e', 'claude-c']);
  });

  test('hidden beats disabled when both are set (still sinks to hidden tier)', () => {
    const profiles = [
      seedProfile({ commandName: 'b', disabled: true }),
      seedProfile({ commandName: 'a', disabled: true, hidden: true }),
    ];
    expect(sortProfilesByStatus(profiles).map(p => p.commandName)).toEqual(['b', 'a']);
  });

  test('isWorkspaceInactive returns true for either flag', () => {
    expect(isWorkspaceInactive(seedProfile({}))).toBe(false);
    expect(isWorkspaceInactive(seedProfile({ disabled: true }))).toBe(true);
    expect(isWorkspaceInactive(seedProfile({ hidden: true }))).toBe(true);
    expect(isWorkspaceInactive(seedProfile({ disabled: true, hidden: true }))).toBe(true);
  });
});

describe('setWorkspaceFlag', () => {
  let config: ConfigManager;
  let home: string;
  beforeEach(() => {
    home = isolateHome();
    config = freshConfig();
    writeProfiles(config, [seedProfile({ commandName: 'claude-pole' })]);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    setHomedir(null);
  });

  test('disable → persists disabled=true, no hidden change', () => {
    const result = setWorkspaceFlag('claude-pole', 'disable', config);
    expect(result.noop).toBe(false);
    expect(result.before).toEqual({ disabled: false, hidden: false });
    expect(result.after).toEqual({ disabled: true, hidden: false });

    const profile = config.getProfiles().find(p => p.commandName === 'claude-pole')!;
    expect(profile.disabled).toBe(true);
    expect(profile.hidden).toBeUndefined();
  });

  test('enable a disabled workspace clears the flag entirely', () => {
    setWorkspaceFlag('claude-pole', 'disable', config);
    const result = setWorkspaceFlag('claude-pole', 'enable', config);
    expect(result.noop).toBe(false);
    expect(result.after.disabled).toBe(false);

    const profile = config.getProfiles().find(p => p.commandName === 'claude-pole')!;
    // Toggled-false flags are dropped from config.json — verify the on-disk
    // shape contains no `disabled` key.
    expect(Object.prototype.hasOwnProperty.call(profile, 'disabled')).toBe(false);
  });

  test('disable on already-disabled is a noop with same before/after', () => {
    setWorkspaceFlag('claude-pole', 'disable', config);
    const result = setWorkspaceFlag('claude-pole', 'disable', config);
    expect(result.noop).toBe(true);
    expect(result.before).toEqual(result.after);
  });

  test('hide and disable compose — both flags can be set simultaneously', () => {
    setWorkspaceFlag('claude-pole', 'disable', config);
    setWorkspaceFlag('claude-pole', 'hide', config);

    const profile = config.getProfiles().find(p => p.commandName === 'claude-pole')!;
    expect(profile.disabled).toBe(true);
    expect(profile.hidden).toBe(true);
  });

  test('throws when workspace does not exist', () => {
    expect(() => setWorkspaceFlag('does-not-exist', 'disable', config))
      .toThrow(/not found/);
  });
});

describe('deleteWorkspace — decoupling contract', () => {
  let config: ConfigManager;
  let home: string;
  beforeEach(() => {
    home = isolateHome();
    config = freshConfig();
    writeProfiles(config, [
      seedProfile({ commandName: 'claude-ted' }),
      seedProfile({ commandName: 'claude-pole' }),
    ]);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    setHomedir(null);
  });

  test('default delete removes the profile record AND the data dir', () => {
    const dir = config.getProfileDir('claude-ted');
    expect(fs.existsSync(dir)).toBe(true);

    const result = deleteWorkspace('claude-ted', {}, config);
    expect(result.commandName).toBe('claude-ted');
    expect(result.keptData).toBe(false);
    expect(result.profileDirRemoved).toBe(true);

    expect(fs.existsSync(dir)).toBe(false);
    expect(config.getProfiles().map(p => p.commandName)).toEqual(['claude-pole']);
  });

  test('--keep-data preserves the data dir but still drops the profile record', () => {
    const dir = config.getProfileDir('claude-ted');
    fs.writeFileSync(path.join(dir, 'history.jsonl'), '{"session":1}\n');

    const result = deleteWorkspace('claude-ted', { keepData: true }, config);
    expect(result.keptData).toBe(true);
    expect(result.profileDirRemoved).toBe(false);

    // Data dir survives, profile record gone — exactly the "logout-and-park"
    // semantic the user asked for.
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'history.jsonl'))).toBe(true);
    expect(config.getProfiles().map(p => p.commandName)).toEqual(['claude-pole']);
  });

  test('refuses to delete a workspace shared by another profile (without --force-dependents)', () => {
    writeProfiles(config, [
      seedProfile({ commandName: 'claude-pole' }),
      seedProfile({ commandName: 'claude-rai', sharedWith: 'claude-pole' }),
    ]);
    expect(() => deleteWorkspace('claude-pole', {}, config))
      .toThrow(/shared by: claude-rai/);

    // Force flag overrides.
    const result = deleteWorkspace('claude-pole', { forceDependents: true }, config);
    expect(result.removedDependents).toEqual(['claude-rai']);
  });

  test('throws on unknown workspace', () => {
    expect(() => deleteWorkspace('nope', {}, config)).toThrow(/not found/);
  });
});

describe('editWorkspace', () => {
  let config: ConfigManager;
  let home: string;
  beforeEach(() => {
    home = isolateHome();
    config = freshConfig();
    writeProfiles(config, [seedProfile({
      commandName: 'claude-pole',
      model: 'old-model',
      baseUrl: 'https://old.example.com',
    })]);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    setHomedir(null);
  });

  test('updates model + baseUrl; leaves other fields intact', () => {
    const merged = editWorkspace('claude-pole', {
      model: 'new-model',
      baseUrl: 'https://new.example.com',
    }, config);

    expect(merged.model).toBe('new-model');
    expect(merged.baseUrl).toBe('https://new.example.com');
    expect(merged.cliType).toBe('claude');
    expect(merged.provider).toBe('anthropic');
  });

  test('empty-string clears the field', () => {
    const merged = editWorkspace('claude-pole', { model: '' }, config);
    expect(Object.prototype.hasOwnProperty.call(merged, 'model')).toBe(false);
  });

  test('envOverrides merge rather than replace', () => {
    config.editProfile('claude-pole', { envOverrides: { FOO: 'a', BAR: 'b' } });
    const merged = editWorkspace('claude-pole', {
      envOverrides: { BAR: 'b2', BAZ: 'c' },
    }, config);
    expect(merged.envOverrides).toEqual({ FOO: 'a', BAR: 'b2', BAZ: 'c' });
  });

  test('throws on unknown workspace', () => {
    expect(() => editWorkspace('nope', { model: 'x' }, config))
      .toThrow(/not found/);
  });
});

describe('listWorkspaces', () => {
  let config: ConfigManager;
  let home: string;
  beforeEach(() => {
    home = isolateHome();
    config = freshConfig();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    setHomedir(null);
  });

  test('returns rows sorted by status tier and includes disk-existence', () => {
    writeProfiles(config, [
      seedProfile({ commandName: 'claude-a' }),
      seedProfile({ commandName: 'claude-b', disabled: true }),
      seedProfile({ commandName: 'claude-c', hidden: true }),
    ]);
    // Knock out the data dir for claude-c to verify the disk-existence flag.
    fs.rmSync(config.getProfileDir('claude-c'), { recursive: true, force: true });

    const rows = listWorkspaces(config);
    expect(rows.map(r => r.commandName)).toEqual(['claude-a', 'claude-b', 'claude-c']);
    expect(rows[0]).toMatchObject({ disabled: false, hidden: false, profileDirExists: true });
    expect(rows[1]).toMatchObject({ disabled: true, hidden: false });
    expect(rows[2]).toMatchObject({ hidden: true, profileDirExists: false });
  });
});
