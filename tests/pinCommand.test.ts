/**
 * Tests for the `sweech pin` command (show / set / unset) and the
 * project-pin shape on the auto/recommend JSON outputs.
 *
 * Implementation choice: we don't spin up the full Commander program
 * here — instead we test the unit-of-work the action handler delegates
 * to (projectConfig.{read,write,remove,findProjectPin}). That gives us
 * fast, deterministic coverage of the public contract: what a user
 * writes through `sweech pin set` is what `findProjectPin` later
 * surfaces, and what `--json` exposes matches the on-disk shape.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  findProjectPin,
  readProjectPin,
  writeProjectPin,
  removeProjectPin,
  PIN_FILENAME,
  _resetWarningCache,
  type ProjectPin,
} from '../src/projectConfig';

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;

function setHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

function restoreHome(): void {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME;
  else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE;
  else delete process.env.USERPROFILE;
}

let tmpRoot: string;
let homeDir: string;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-pin-cmd-'));
  homeDir = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  setHome(homeDir);
  _resetWarningCache();
  stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreHome();
  stderrSpy.mockRestore();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// ── `sweech pin set` semantics (via writeProjectPin) ─────────────────────────

describe('sweech pin set (writeProjectPin contract)', () => {
  test('writes a profile-only pin to ./.sweech.json', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    const out = writeProjectPin(proj, { profile: 'claude-work' });

    expect(out).toBe(path.join(proj, PIN_FILENAME));
    const written = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(written).toEqual({ profile: 'claude-work' });
  });

  test('writes a full pin (profile + cliType + maxTier + model)', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    const out = writeProjectPin(proj, {
      profile: 'claude-work',
      cliType: 'claude',
      maxTier: 'max',
      model: 'claude-opus-4-7',
    });

    const written = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(written).toEqual({
      profile: 'claude-work',
      cliType: 'claude',
      maxTier: 'max',
      model: 'claude-opus-4-7',
    });
  });

  test('written pin round-trips through readProjectPin without warnings', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    const original: ProjectPin = {
      profile: 'p', cliType: 'codex', maxTier: 'team', model: 'gpt-5',
    };
    const out = writeProjectPin(proj, original);
    expect(readProjectPin(out)).toEqual(original);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('written pin is discoverable via findProjectPin from the same dir', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj, { profile: 'claude-work', cliType: 'claude' });

    const resolved = findProjectPin(proj);
    expect(resolved).not.toBeNull();
    expect(resolved!.pin).toEqual({ profile: 'claude-work', cliType: 'claude' });
    expect(resolved!.projectRoot).toBe(proj);
  });

  test('written pin is discoverable from a subdirectory', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj, { profile: 'mono-pin' });
    const sub = path.join(proj, 'apps', 'web');
    fs.mkdirSync(sub, { recursive: true });

    const resolved = findProjectPin(sub);
    expect(resolved!.pin.profile).toBe('mono-pin');
    expect(resolved!.projectRoot).toBe(proj);
  });

  test('overwrites a previous pin in the same directory', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj, { profile: 'one' });
    writeProjectPin(proj, { profile: 'two', cliType: 'codex' });

    expect(readProjectPin(path.join(proj, PIN_FILENAME))).toEqual({
      profile: 'two', cliType: 'codex',
    });
  });

  test('strips undefined fields from the on-disk JSON', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj, {
      profile: 'p',
      cliType: undefined,
      maxTier: undefined,
      model: undefined,
    });
    const written = JSON.parse(fs.readFileSync(path.join(proj, PIN_FILENAME), 'utf-8'));
    expect(written).toEqual({ profile: 'p' });
    expect(Object.keys(written).sort()).toEqual(['profile']);
  });

  test('JSON output is pretty-printed (2-space indent)', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj, { profile: 'p', cliType: 'claude' });
    const raw = fs.readFileSync(path.join(proj, PIN_FILENAME), 'utf-8');
    expect(raw).toContain('\n  "profile"');
    expect(raw).toContain('\n  "cliType"');
    expect(raw.endsWith('\n')).toBe(true); // trailing newline
  });
});

// ── `sweech pin unset` semantics (via removeProjectPin) ──────────────────────

describe('sweech pin unset (removeProjectPin contract)', () => {
  test('returns true when the pin existed and was deleted', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj, { profile: 'doomed' });

    expect(removeProjectPin(proj)).toBe(true);
    expect(fs.existsSync(path.join(proj, PIN_FILENAME))).toBe(false);
  });

  test('returns false when the pin did not exist (idempotent)', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    expect(removeProjectPin(proj)).toBe(false);
    expect(removeProjectPin(proj)).toBe(false); // still false on repeat
  });

  test('removing a parent pin does not affect a sibling pin', () => {
    const proj1 = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    const proj2 = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj1, { profile: 'one' });
    writeProjectPin(proj2, { profile: 'two' });

    removeProjectPin(proj1);
    expect(readProjectPin(path.join(proj2, PIN_FILENAME))).toEqual({ profile: 'two' });
  });
});

// ── `sweech pin show` semantics (via findProjectPin) ─────────────────────────

describe('sweech pin show (findProjectPin contract)', () => {
  test('returns null when nothing is pinned anywhere', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    expect(findProjectPin(proj)).toBeNull();
  });

  test('reports the source path for an active pin', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    const pinPath = writeProjectPin(proj, { profile: 'shown' });

    const resolved = findProjectPin(proj);
    expect(resolved!.source).toBe(pinPath);
  });

  test('reports the project root (not the cwd) for nested cwd', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj, { profile: 'rooted' });
    const deep = path.join(proj, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });

    const resolved = findProjectPin(deep);
    expect(resolved!.projectRoot).toBe(proj);
  });

  test('show + set + show: round-trip is observable', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    expect(findProjectPin(proj)).toBeNull();
    writeProjectPin(proj, { profile: 'fresh' });
    const after = findProjectPin(proj);
    expect(after!.pin.profile).toBe('fresh');
  });

  test('show + unset + show: removal is observable', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj, { profile: 'transient' });
    expect(findProjectPin(proj)!.pin.profile).toBe('transient');
    removeProjectPin(proj);
    expect(findProjectPin(proj)).toBeNull();
  });
});

// ── JSON shape (matches what `sweech pin --json` emits) ──────────────────────

describe('sweech pin --json shape', () => {
  test('show JSON contains pin + source + projectRoot keys', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    writeProjectPin(proj, { profile: 'json-test', cliType: 'claude' });

    const resolved = findProjectPin(proj);
    // Same shape the CLI emits.
    const json = {
      pin: resolved!.pin,
      source: resolved!.source,
      projectRoot: resolved!.projectRoot,
    };
    expect(JSON.parse(JSON.stringify(json))).toEqual({
      pin: { profile: 'json-test', cliType: 'claude' },
      source: path.join(proj, PIN_FILENAME),
      projectRoot: proj,
    });
  });

  test('show JSON when no pin contains null fields + searchRoot', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    const resolved = findProjectPin(proj);
    // Caller emits a "null" shape when no pin is found.
    const json = resolved
      ? { pin: resolved.pin, source: resolved.source, projectRoot: resolved.projectRoot }
      : { pin: null, source: null, projectRoot: null, searchRoot: proj };
    expect(json).toEqual({
      pin: null, source: null, projectRoot: null, searchRoot: proj,
    });
  });
});

// ── validation: invalid pins fail loudly at read time ───────────────────────

describe('sweech pin set validation guard (read-side)', () => {
  test('an invalid cliType written to disk is dropped at read time', () => {
    // We bypass writeProjectPin (which trusts ProjectPin types) and
    // simulate a user hand-editing the file with a bogus cliType.
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    fs.writeFileSync(
      path.join(proj, PIN_FILENAME),
      JSON.stringify({ profile: 'good', cliType: 'banana' }),
    );

    const resolved = findProjectPin(proj);
    expect(resolved!.pin).toEqual({ profile: 'good' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('cliType'));
  });

  test('an invalid maxTier written to disk is dropped at read time', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    fs.writeFileSync(
      path.join(proj, PIN_FILENAME),
      JSON.stringify({ profile: 'good', maxTier: 'super-saiyan' }),
    );

    const resolved = findProjectPin(proj);
    expect(resolved!.pin).toEqual({ profile: 'good' });
  });

  test('completely empty pin file = empty pin (no fields)', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    fs.writeFileSync(path.join(proj, PIN_FILENAME), JSON.stringify({}));
    expect(findProjectPin(proj)!.pin).toEqual({});
  });
});
