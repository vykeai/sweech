/**
 * Tests for the share-topology snapshot + heal mechanism:
 *
 *   - removeProfile snapshots symlinks before destruction
 *   - healShareTopology re-creates missing symlinks (case a)
 *   - healShareTopology no-ops on correct symlinks (case b)
 *   - healShareTopology backs up + merges + symlinks on collisions (case c)
 *   - the safety log captures every action
 *   - healProfileSharedDirs is the hot-path heal used by `use`/`auto`
 *
 * Real fs against tmpdir-rooted homedir so the symlink behavior is
 * tested faithfully. Mocks BOTH `os` and `node:os` per the test
 * isolation pattern documented in workspaceCrud.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

// CRITICAL: mock os.homedir() BEFORE importing any sweech module.
// macOS resolves homedir from getpwuid() inside libuv (not $HOME),
// so setting process.env.HOME is silently ignored.
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

import { ConfigManager, type ProfileConfig } from '../src/config';
import type { CLIConfig } from '../src/clis';

function isolateHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-heal-test-'));
  setHomedir(home);
  process.env.SWEECH_HOME = home;
  // Hard safety check: prior incidents damaged real ~/.claude-pole because
  // a test wrote real workspace markers. Verify tmpdir rooting first.
  if (!os.homedir().startsWith(os.tmpdir()) || !os.homedir().includes('sweech-heal-test-')) {
    throw new Error(
      `isolateHome safety check failed: os.homedir()=${os.homedir()} is not under ${os.tmpdir()}.`,
    );
  }
  return home;
}

afterEach(() => {
  setHomedir(null);
  delete process.env.SWEECH_HOME;
  ConfigManager.disableConstructorHeal = false;
});

describe('snapshotShareTopology + removeProfile', () => {
  test('removeProfile writes a snapshot capturing all symlinks', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();

    // Build a master profile dir with content.
    const masterDir = path.join(home, '.claude');
    fs.mkdirSync(masterDir, { recursive: true });
    fs.mkdirSync(path.join(masterDir, 'projects'));
    fs.mkdirSync(path.join(masterDir, 'sessions'));

    // Build a sibling profile whose dirs are symlinks back into master.
    const siblingDir = path.join(home, '.test-sibling');
    fs.mkdirSync(siblingDir);
    fs.symlinkSync(path.join(masterDir, 'projects'), path.join(siblingDir, 'projects'));
    fs.symlinkSync(path.join(masterDir, 'sessions'), path.join(siblingDir, 'sessions'));
    // A real (non-link) file is NOT in the snapshot.
    fs.writeFileSync(path.join(siblingDir, 'settings.json'), '{}');

    cfg.writeProfiles([{
      name: 'test-sibling',
      commandName: 'test-sibling',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-17T00:00:00Z',
      sharedWith: 'claude',
    } as any]);

    cfg.removeProfile('test-sibling');

    const snapPath = path.join(cfg.getShareSnapshotsDir(), 'test-sibling.json');
    expect(fs.existsSync(snapPath)).toBe(true);
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
    expect(snap.commandName).toBe('test-sibling');
    expect(Object.keys(snap.links).sort()).toEqual(['projects', 'sessions']);
    expect(snap.links.projects).toBe(path.join(masterDir, 'projects'));
    expect(fs.existsSync(siblingDir)).toBe(false);
  });

  test('removeProfile with keepData=true does NOT snapshot or destroy', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    const siblingDir = path.join(home, '.test-keep');
    fs.mkdirSync(siblingDir);
    fs.writeFileSync(path.join(siblingDir, 'settings.json'), '{}');
    cfg.writeProfiles([{
      name: 'test-keep',
      commandName: 'test-keep',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-17T00:00:00Z',
    } as any]);

    cfg.removeProfile('test-keep', { keepData: true });

    expect(fs.existsSync(siblingDir)).toBe(true);
    expect(fs.existsSync(path.join(cfg.getShareSnapshotsDir(), 'test-keep.json'))).toBe(false);
  });
});

describe('healShareTopology', () => {
  test('case (a): re-creates missing symlinks from snapshot', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();

    const masterDir = path.join(home, '.claude');
    fs.mkdirSync(path.join(masterDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(masterDir, 'sessions'), { recursive: true });

    // Write a snapshot directly — simulates "profile was removed in a prior
    // session, snapshot survived".
    fs.writeFileSync(
      path.join(cfg.getShareSnapshotsDir(), 'test-resurrected.json'),
      JSON.stringify({
        schemaVersion: 1,
        commandName: 'test-resurrected',
        capturedAt: '2026-05-17T00:00:00Z',
        links: {
          projects: path.join(masterDir, 'projects'),
          sessions: path.join(masterDir, 'sessions'),
        },
      }),
    );

    // Recreate the profile dir but without the links.
    const profileDir = path.join(home, '.test-resurrected');
    fs.mkdirSync(profileDir);

    const result = cfg.healShareTopology();

    expect(result.linksCreated).toHaveLength(2);
    const projectsLink = path.join(profileDir, 'projects');
    expect(fs.lstatSync(projectsLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(projectsLink)).toBe(path.join(masterDir, 'projects'));
  });

  test('case (b): no-op when symlink is already correct', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    const masterDir = path.join(home, '.claude');
    fs.mkdirSync(path.join(masterDir, 'projects'), { recursive: true });

    fs.writeFileSync(
      path.join(cfg.getShareSnapshotsDir(), 'test-already-linked.json'),
      JSON.stringify({
        schemaVersion: 1,
        commandName: 'test-already-linked',
        links: { projects: path.join(masterDir, 'projects') },
      }),
    );

    const profileDir = path.join(home, '.test-already-linked');
    fs.mkdirSync(profileDir);
    fs.symlinkSync(path.join(masterDir, 'projects'), path.join(profileDir, 'projects'));

    const result = cfg.healShareTopology();

    expect(result.linksCreated).toHaveLength(0);
    expect(result.collisionsHealed).toHaveLength(0);
    expect(result.collisionsSkipped).toHaveLength(0);
  });

  test('case (c): backs up + merges + symlinks when a real dir collides with snapshot', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    const masterDir = path.join(home, '.claude');
    fs.mkdirSync(path.join(masterDir, 'projects'), { recursive: true });
    // Master has file A only.
    fs.writeFileSync(path.join(masterDir, 'projects', 'A.jsonl'), 'master-A\n');

    fs.writeFileSync(
      path.join(cfg.getShareSnapshotsDir(), 'test-collide.json'),
      JSON.stringify({
        schemaVersion: 1,
        commandName: 'test-collide',
        links: { projects: path.join(masterDir, 'projects') },
      }),
    );

    // Profile has a REAL projects/ dir (not a symlink) with two files:
    // B (new, should merge into master) and A (same name as master, master-wins).
    const profileDir = path.join(home, '.test-collide');
    const realProjects = path.join(profileDir, 'projects');
    fs.mkdirSync(realProjects, { recursive: true });
    fs.writeFileSync(path.join(realProjects, 'A.jsonl'), 'profile-A\n');
    fs.writeFileSync(path.join(realProjects, 'B.jsonl'), 'profile-B\n');

    const result = cfg.healShareTopology();

    expect(result.collisionsHealed).toHaveLength(1);
    const healed = result.collisionsHealed[0];
    expect(healed.profile).toBe('test-collide');
    expect(healed.name).toBe('projects');

    // After heal, projects/ MUST be a symlink to master.
    const stat = fs.lstatSync(path.join(profileDir, 'projects'));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(profileDir, 'projects')))
      .toBe(path.join(masterDir, 'projects'));

    // Master must contain BOTH A (unchanged) and B (merged from profile).
    expect(fs.readFileSync(path.join(masterDir, 'projects', 'A.jsonl'), 'utf-8'))
      .toBe('master-A\n'); // master-wins
    expect(fs.readFileSync(path.join(masterDir, 'projects', 'B.jsonl'), 'utf-8'))
      .toBe('profile-B\n');

    // Backup must contain the original profile contents.
    expect(fs.existsSync(healed.backupPath)).toBe(true);
    expect(fs.readFileSync(path.join(healed.backupPath, 'A.jsonl'), 'utf-8'))
      .toBe('profile-A\n');
    expect(fs.readFileSync(path.join(healed.backupPath, 'B.jsonl'), 'utf-8'))
      .toBe('profile-B\n');

    // Lifecycle log must record the resolution.
    const logFile = path.join(cfg.getLogsDir(), 'lifecycle.jsonl');
    expect(fs.existsSync(logFile)).toBe(true);
    const logLines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(logLines.some(l => l.event === 'share_heal.collision_resolved' && l.profile === 'test-collide'))
      .toBe(true);
  });

  test('skips snapshots with poisoned commandName', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    fs.writeFileSync(
      path.join(cfg.getShareSnapshotsDir(), 'evil.json'),
      JSON.stringify({
        schemaVersion: 1,
        commandName: '../../../etc',
        links: { passwd: '/etc/passwd' },
      }),
    );
    const result = cfg.healShareTopology();
    expect(result.profilesScanned).toBe(0);
  });

  test('aborts WITHOUT destruction when the backup dir cannot be created', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    const masterDir = path.join(home, '.claude');
    fs.mkdirSync(path.join(masterDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(masterDir, 'projects', 'master.jsonl'), 'M\n');

    fs.writeFileSync(
      path.join(cfg.getShareSnapshotsDir(), 'test-backup-blocked.json'),
      JSON.stringify({
        schemaVersion: 1,
        commandName: 'test-backup-blocked',
        links: { projects: path.join(masterDir, 'projects') },
      }),
    );

    const profileDir = path.join(home, '.test-backup-blocked');
    const realProjects = path.join(profileDir, 'projects');
    fs.mkdirSync(realProjects, { recursive: true });
    fs.writeFileSync(path.join(realProjects, 'precious.jsonl'), 'IRREPLACEABLE\n');

    // Force backup-mkdir to fail by making backupsDir/share-heal/ a FILE
    // instead of a dir. healOneCollision must refuse to destroy.
    const backupBlocker = path.join(cfg.getBackupsDir(), 'share-heal');
    fs.writeFileSync(backupBlocker, 'this is not a directory');

    const result = cfg.healShareTopology();

    // Heal must have aborted — the precious data must still be on disk.
    expect(fs.existsSync(path.join(realProjects, 'precious.jsonl'))).toBe(true);
    expect(result.collisionsHealed).toHaveLength(0);
    expect(result.collisionsSkipped.length).toBeGreaterThan(0);
  });

  test('skips link targets outside homedir', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    fs.mkdirSync(path.join(home, '.test-bad-target'));
    fs.writeFileSync(
      path.join(cfg.getShareSnapshotsDir(), 'test-bad-target.json'),
      JSON.stringify({
        schemaVersion: 1,
        commandName: 'test-bad-target',
        links: { foo: '/etc/passwd' },
      }),
    );
    const result = cfg.healShareTopology();
    expect(result.linksCreated).toHaveLength(0);
    expect(fs.existsSync(path.join(home, '.test-bad-target', 'foo'))).toBe(false);
  });
});

describe('createWrapperScript embeds gated pre-launch maintenance', () => {
  test('wrapper template gates _heal-profile behind target-aware drift checks', () => {
    isolateHome();
    const cfg = new ConfigManager();
    const profile: ProfileConfig = {
      name: 'test-wrapper',
      commandName: 'test-wrapper',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-20T00:00:00Z',
      sharedWith: 'claude',
    };
    cfg.writeProfiles([profile]);
    const cli: CLIConfig = {
      name: 'claude',
      command: 'claude',
      displayName: 'Claude Code',
      configDirEnvVar: 'CLAUDE_CONFIG_DIR',
      description: 'Anthropic Claude Code CLI',
    };
    cfg.createWrapperScript('test-wrapper', cli);
    const wrapper = fs.readFileSync(path.join(cfg.getBinDir(), 'test-wrapper'), 'utf-8');
    expect(wrapper).toContain('sweech _heal-profile');
    expect(wrapper).toContain('_NEEDS_HEAL=0');
    expect(wrapper).toContain('_SHARE_HEAL_ENABLED=1');
    expect(wrapper).not.toContain('_SHARE_FP=');
    expect(wrapper).toContain('readlink');
    expect(wrapper).toContain(path.join(os.homedir(), '.claude', 'projects'));
    // Heal call must be inside the `if [ "$_NEEDS_HEAL" = "1" ]` block.
    const healCallIdx = wrapper.indexOf('sweech _heal-profile');
    const preceding = wrapper.slice(0, healCallIdx);
    expect(preceding).toMatch(/if \[ "\$_NEEDS_HEAL" = "1" \]/);
    // Must be best-effort.
    expect(wrapper.slice(healCallIdx, healCallIdx + 200)).toContain('|| true');
  });

  test('wrapper template skips share heal gate for non-shared profiles', () => {
    isolateHome();
    const cfg = new ConfigManager();
    const cli: CLIConfig = {
      name: 'claude',
      command: 'claude',
      displayName: 'Claude Code',
      configDirEnvVar: 'CLAUDE_CONFIG_DIR',
      description: 'Anthropic Claude Code CLI',
    };
    cfg.createWrapperScript('test-wrapper', cli);
    const wrapper = fs.readFileSync(path.join(cfg.getBinDir(), 'test-wrapper'), 'utf-8');
    expect(wrapper).toContain('_SHARE_HEAL_ENABLED=0');
    expect(wrapper).toContain('sweech _heal-profile');
  });

  test('wrapper template checks optional codex shared db when master db exists', () => {
    isolateHome();
    const cfg = new ConfigManager();
    const profile: ProfileConfig = {
      name: 'codex-test',
      commandName: 'codex-test',
      cliType: 'codex',
      provider: 'openai',
      createdAt: '2026-05-20T00:00:00Z',
      sharedWith: 'codex',
    };
    cfg.writeProfiles([profile]);
    const cli: CLIConfig = {
      name: 'codex',
      command: 'codex',
      displayName: 'Codex',
      configDirEnvVar: 'CODEX_HOME',
      description: 'OpenAI Codex CLI',
    };
    cfg.createWrapperScript('codex-test', cli);
    const wrapper = fs.readFileSync(path.join(cfg.getBinDir(), 'codex-test'), 'utf-8');
    expect(wrapper).toContain('logs_1.sqlite');
    expect(wrapper).toContain('[ ! -e ');
    expect(wrapper).toContain('[ ! -L ');
  });

  test('share fingerprint ignores package version so wrappers survive upgrades', () => {
    isolateHome();
    const cfg = new ConfigManager();
    const first = cfg.buildProfileShareFingerprint('test-wrapper', 'claude');
    const versionShim = cfg as unknown as { readSweechVersion: () => string };
    versionShim.readSweechVersion = () => '999.999.999';

    expect(cfg.buildProfileShareFingerprint('test-wrapper', 'claude')).toBe(first);
  });

  test('wrapper template gates _ensure-session-pointers behind cwd jsonl scan', () => {
    isolateHome();
    const cfg = new ConfigManager();
    const cli = {
      name: 'claude',
      command: 'claude',
      displayName: 'Claude Code',
      configDirEnvVar: 'CLAUDE_CONFIG_DIR',
    } as any;
    cfg.createWrapperScript('test-wrapper', cli);
    const wrapper = fs.readFileSync(path.join(cfg.getBinDir(), 'test-wrapper'), 'utf-8');
    expect(wrapper).toContain('sweech _ensure-session-pointers');
    expect(wrapper).toContain('_NEEDS_POINTERS=0');
    expect(wrapper).toContain('_ENCODED_CWD');
    expect(wrapper).toContain('.jsonl');
    // Pointer-regen call must reference --cwd "$PWD".
    expect(wrapper).toMatch(/sweech _ensure-session-pointers .*--cwd "\$PWD"/);
  });
});

describe('sweech run prelaunch maintenance', () => {
  test('prelaunch helper checks topology even when fingerprint is current', () => {
    const cliSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf-8');
    const helperBlock = cliSource.slice(
      cliSource.indexOf('function prelaunchShareHeal'),
      cliSource.indexOf('program', cliSource.indexOf('function prelaunchShareHeal')),
    );
    expect(helperBlock).toContain('isProfileShareFingerprintCurrent');
    expect(helperBlock).toContain('isProfileShareTopologyHealthy');
  });

  test('run resolves local --account before --profile for share heal', () => {
    const cliSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf-8');
    const runBlock = cliSource.slice(
      cliSource.indexOf(".command('run <prompt>')"),
      cliSource.indexOf('// Build request body'),
    );
    expect(runBlock).toContain('flags.account || flags.profile');
    expect(runBlock).toMatch(/flags\.account[\s\S]*profiles\.find\(p => p\.commandName === flags\.account\)[\s\S]*flags\.profile[\s\S]*profiles\.find\(p => p\.commandName === flags\.profile\)/);
    expect(runBlock).toContain('prelaunchShareHeal(config, profile)');
  });
});

describe('launcher prelaunch maintenance', () => {
  test('interactive launcher heals shared entries before spawning native CLI', () => {
    const launcherSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'launcher.ts'), 'utf-8');
    const launchStart = launcherSource.indexOf('const launch = async () =>');
    const launchBlock = launcherSource.slice(
      launchStart,
      launcherSource.indexOf('const preview = buildCommandPreview', launchStart),
    );
    expect(launchBlock).toContain('entry.sharedWith');
    expect(launchBlock).toContain('isProfileShareFingerprintCurrent');
    expect(launchBlock).toContain('isProfileShareTopologyHealthy');
    expect(launchBlock).toContain('healProfileSharedDirs(entry.name)');
  });
});

describe('ensureSessionPointers', () => {
  test('regenerates a pointer file for a jsonl with no matching pointer', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();

    const cwd = '/Users/test/dev/myproject';
    const encoded = '-Users-test-dev-myproject';
    const profileDir = path.join(home, '.test-profile');
    fs.mkdirSync(path.join(profileDir, 'projects', encoded), { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'sessions'), { recursive: true });

    const sid = '8081375f-a174-49e7-bc3c-1e19a7b84f10';
    fs.writeFileSync(
      path.join(profileDir, 'projects', encoded, `${sid}.jsonl`),
      '{"type":"user","text":"hi"}\n',
    );

    const created = cfg.ensureSessionPointers('test-profile', cwd);
    expect(created).toBe(1);

    const pointers = fs.readdirSync(path.join(profileDir, 'sessions'));
    expect(pointers).toHaveLength(1);
    const pointer = JSON.parse(fs.readFileSync(path.join(profileDir, 'sessions', pointers[0]), 'utf-8'));
    expect(pointer.sessionId).toBe(sid);
    expect(pointer.cwd).toBe(cwd);
    expect(pointer.status).toBe('idle');
    expect(pointer._sweechSynthetic).toBe(true);
    expect(pointer.pid).toBeGreaterThanOrEqual(1_000_000_000);
  });

  test('skips jsonls that already have a pointer', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();

    const cwd = '/Users/test/dev/myproject';
    const encoded = '-Users-test-dev-myproject';
    const profileDir = path.join(home, '.test-profile');
    fs.mkdirSync(path.join(profileDir, 'projects', encoded), { recursive: true });
    fs.mkdirSync(path.join(profileDir, 'sessions'), { recursive: true });

    const sid = '8081375f-a174-49e7-bc3c-1e19a7b84f10';
    fs.writeFileSync(
      path.join(profileDir, 'projects', encoded, `${sid}.jsonl`),
      '{"type":"user","text":"hi"}\n',
    );
    // Pre-existing pointer
    fs.writeFileSync(
      path.join(profileDir, 'sessions', '12345.json'),
      JSON.stringify({ pid: 12345, sessionId: sid, cwd, status: 'idle' }),
    );

    const created = cfg.ensureSessionPointers('test-profile', cwd);
    expect(created).toBe(0);
  });

  test('rejects unsafe commandName', () => {
    isolateHome();
    const cfg = new ConfigManager();
    expect(cfg.ensureSessionPointers('../bad', '/tmp')).toBe(0);
  });

  test('rejects non-absolute cwd', () => {
    isolateHome();
    const cfg = new ConfigManager();
    expect(cfg.ensureSessionPointers('test', 'relative/path')).toBe(0);
  });
});

describe('healProfileSharedDirs (hot-path)', () => {
  test('returns 0 when profile has no sharedWith', () => {
    isolateHome();
    const cfg = new ConfigManager();
    cfg.writeProfiles([{
      name: 'test-solo',
      commandName: 'test-solo',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-17T00:00:00Z',
    } as any]);
    expect(cfg.healProfileSharedDirs('test-solo')).toBe(0);
  });

  test('repairs a profile whose sharedWith link was rm-ed', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();

    const masterDir = path.join(home, '.claude');
    fs.mkdirSync(path.join(masterDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(masterDir, 'sessions'), { recursive: true });

    const profileDir = path.join(home, '.test-shared');
    fs.mkdirSync(profileDir);
    // Pre-existing wrapper would have placed symlinks here — simulate
    // the regression where they got rm-ed by setting NOTHING up.

    cfg.writeProfiles([{
      name: 'test-shared',
      commandName: 'test-shared',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-17T00:00:00Z',
      sharedWith: 'claude',
    } as any]);

    const repaired = cfg.healProfileSharedDirs('test-shared');
    expect(repaired).toBeGreaterThan(0);
    expect(fs.lstatSync(path.join(profileDir, 'projects')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(profileDir, 'sessions')).isSymbolicLink()).toBe(true);
  });

  test('writes share fingerprint and audit log after repairing drift', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();

    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const profileDir = path.join(home, '.test-fingerprint');
    fs.mkdirSync(profileDir);
    const profile: ProfileConfig = {
      name: 'test-fingerprint',
      commandName: 'test-fingerprint',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-20T00:00:00Z',
      sharedWith: 'claude',
    };
    cfg.writeProfiles([profile]);

    expect(cfg.isProfileShareFingerprintCurrent('test-fingerprint')).toBe(false);
    const repaired = cfg.healProfileSharedDirs('test-fingerprint');

    expect(repaired).toBeGreaterThan(0);
    expect(cfg.isProfileShareFingerprintCurrent('test-fingerprint')).toBe(true);
    const audit = fs.readFileSync(path.join(home, '.sweech', 'audit.log'), 'utf-8');
    expect(audit).toContain('share-heal profile=test-fingerprint');
    expect(audit).toMatch(/repaired=\d+/);
  });

  test('topology health detects drift after fingerprint was written', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();

    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const profileDir = path.join(home, '.test-drift');
    fs.mkdirSync(profileDir);
    const profile: ProfileConfig = {
      name: 'test-drift',
      commandName: 'test-drift',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-20T00:00:00Z',
      sharedWith: 'claude',
    };
    cfg.writeProfiles([profile]);

    cfg.healProfileSharedDirs('test-drift');
    expect(cfg.isProfileShareFingerprintCurrent('test-drift')).toBe(true);
    fs.unlinkSync(path.join(profileDir, 'projects'));

    expect(cfg.isProfileShareFingerprintCurrent('test-drift')).toBe(true);
    expect(cfg.isProfileShareTopologyHealthy('test-drift')).toBe(false);
  });

  test('does not replace a real codex transcript db during hot-path heal', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    const masterDir = path.join(home, '.codex');
    const profileDir = path.join(home, '.codex-real-db');
    fs.mkdirSync(path.join(masterDir, 'sessions'), { recursive: true });
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(masterDir, 'logs_1.sqlite'), 'master');
    fs.writeFileSync(path.join(profileDir, 'logs_1.sqlite'), 'local');
    cfg.writeProfiles([{
      name: 'codex-real-db',
      commandName: 'codex-real-db',
      cliType: 'codex',
      provider: 'openai',
      createdAt: '2026-05-20T00:00:00Z',
      sharedWith: 'codex',
    }]);

    cfg.healProfileSharedDirs('codex-real-db');

    const dbPath = path.join(profileDir, 'logs_1.sqlite');
    expect(fs.lstatSync(dbPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dbPath, 'utf-8')).toBe('local');
    expect(cfg.isProfileShareTopologyHealthy('codex-real-db')).toBe(true);
    expect(cfg.isProfileShareFingerprintCurrent('codex-real-db')).toBe(true);
  });

  test('does not follow symlinked share fingerprint path', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    const profileDir = path.join(home, '.test-fp-symlink');
    fs.mkdirSync(profileDir);
    const victim = path.join(home, 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(profileDir, '.sweech-share-fingerprint'));

    cfg.writeProfileShareFingerprint('test-fp-symlink', 'claude');

    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep');
  });

  test('does not truncate hardlinked share fingerprint path', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    const profileDir = path.join(home, '.test-fp-hardlink');
    fs.mkdirSync(profileDir);
    const victim = path.join(home, 'hardlink-victim.txt');
    fs.writeFileSync(victim, 'keep');
    fs.linkSync(victim, path.join(profileDir, '.sweech-share-fingerprint'));

    cfg.writeProfileShareFingerprint('test-fp-hardlink', 'claude');

    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep');
  });

  test('does not follow symlinked audit log path', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();

    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const profileDir = path.join(home, '.test-audit-symlink');
    fs.mkdirSync(profileDir);
    const profile: ProfileConfig = {
      name: 'test-audit-symlink',
      commandName: 'test-audit-symlink',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-20T00:00:00Z',
      sharedWith: 'claude',
    };
    cfg.writeProfiles([profile]);
    const victim = path.join(home, 'audit-victim.txt');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(home, '.sweech', 'audit.log'));

    cfg.healProfileSharedDirs('test-audit-symlink');

    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep');
  });

  test('does not append to hardlinked audit log path', () => {
    const home = isolateHome();
    const cfg = new ConfigManager();

    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const profileDir = path.join(home, '.test-audit-hardlink');
    fs.mkdirSync(profileDir);
    cfg.writeProfiles([{
      name: 'test-audit-hardlink',
      commandName: 'test-audit-hardlink',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-20T00:00:00Z',
      sharedWith: 'claude',
    }]);
    const victim = path.join(home, 'audit-hardlink-victim.txt');
    fs.writeFileSync(victim, 'keep');
    fs.linkSync(victim, path.join(home, '.sweech', 'audit.log'));

    cfg.healProfileSharedDirs('test-audit-hardlink');

    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep');
  });
});
