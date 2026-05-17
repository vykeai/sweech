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
// CRITICAL: mock BOTH `os` and `node:os` — see accountCrud.test.ts for
// the incident note. ConfigManager uses unprefixed `os` so only the
// first mock is strictly required here, but mocking both insulates the
// test against future imports flipping the specifier.
//
// jest.mock factories are hoisted above all `let`/`const` declarations,
// so the factory body has to inline the `__mockHome` lookup via the
// (also-hoisted) `var` declaration below.
var __mockHome: string | null = null;
jest.mock('os', () => {
  const actual = jest.requireActual('node:os');
  return {
    ...actual,
    homedir: () => __mockHome ?? actual.homedir(),
  };
});
jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
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

  test('--keep-data scrubs credentials from settings.json (security M1 regression)', () => {
    // Review-round security finding: --keep-data preserved settings.json
    // which holds plaintext ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY. The
    // deleted workspace should not leak credentials to disk.
    const dir = config.getProfileDir('claude-ted');
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-secret',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      },
      oauth: { provider: 'anthropic', refreshToken: 'r0t-secret', expiresAt: 1 },
      hooks: { ConfigChange: [{ matcher: '', hooks: [] }] },
    }, null, 2));

    deleteWorkspace('claude-ted', { keepData: true }, config);

    const scrubbed = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
    expect(scrubbed.env).toBeUndefined();
    expect(scrubbed.oauth).toBeUndefined();
    // Preserves non-secret keys so the dir is re-attachable later.
    expect(scrubbed.hooks).toBeDefined();
  });

  test('--keep-data + --force-dependents — sibling profile re-binds and survives', () => {
    // Integration audit follow-up: the combination of "preserve data" +
    // "tolerate dependents" is a plausible parking scenario where the
    // user keeps the dir intact so a still-active sibling profile that
    // shares from it doesn't break. We assert the master is gone from
    // config.json, the data dir is preserved (with creds scrubbed),
    // and the dependent profile record remains intact.
    writeProfiles(config, [
      seedProfile({ commandName: 'claude-pole' }),
      seedProfile({ commandName: 'claude-rai', sharedWith: 'claude-pole' }),
    ]);
    const masterDir = config.getProfileDir('claude-pole');
    fs.writeFileSync(path.join(masterDir, 'history.jsonl'), '{"shared":"history"}\n');
    fs.writeFileSync(path.join(masterDir, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-master' },
    }));

    const result = deleteWorkspace(
      'claude-pole',
      { keepData: true, forceDependents: true },
      config,
    );
    expect(result.keptData).toBe(true);
    expect(result.removedDependents).toEqual(['claude-rai']);

    // Master record gone from config.json — but dir + dependent record intact.
    const remaining = config.getProfiles().map(p => p.commandName);
    expect(remaining).not.toContain('claude-pole');
    expect(remaining).toContain('claude-rai');
    expect(fs.existsSync(masterDir)).toBe(true);
    expect(fs.existsSync(path.join(masterDir, 'history.jsonl'))).toBe(true);
    // Credentials scrubbed even when keeping for the sibling's benefit.
    const scrubbed = JSON.parse(fs.readFileSync(path.join(masterDir, 'settings.json'), 'utf-8'));
    expect(scrubbed.env).toBeUndefined();
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

describe('getAccountInfo skips live refresh for inactive workspaces (codex P2.2 regression)', () => {
  let home: string;
  beforeEach(() => { home = isolateHome(); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); setHomedir(null); });

  test('disabled workspace returns cached live data; no network call attempted', async () => {
    // Smoke-test the contract: getAccountInfo on a disabled profile
    // must not invoke refreshLiveUsage/getLiveUsage. We exercise this
    // via a mock — if the live-fetch function is called for an
    // inactive profile, the test fails.
    const { getAccountInfo } = require('../src/subscriptions');
    const liveModule = require('../src/liveUsage');

    const getSpy = jest.spyOn(liveModule, 'getLiveUsage').mockResolvedValue(null);
    const refreshSpy = jest.spyOn(liveModule, 'refreshLiveUsage').mockResolvedValue(null);

    try {
      await getAccountInfo(
        [{ name: 'x', commandName: 'claude-x', cliType: 'claude', provider: 'anthropic', disabled: true }],
        { refresh: true, timeoutMs: 1000 },
      );
      expect(getSpy).not.toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      refreshSpy.mockRestore();
    }
  });

  test('hidden workspace also skips live refresh', async () => {
    const { getAccountInfo } = require('../src/subscriptions');
    const liveModule = require('../src/liveUsage');
    const refreshSpy = jest.spyOn(liveModule, 'refreshLiveUsage').mockResolvedValue(null);

    try {
      await getAccountInfo(
        [{ name: 'y', commandName: 'claude-y', cliType: 'claude', provider: 'anthropic', hidden: true }],
        { refresh: true, timeoutMs: 1000 },
      );
      expect(refreshSpy).not.toHaveBeenCalled();
    } finally {
      refreshSpy.mockRestore();
    }
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
