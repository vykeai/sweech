/**
 * Tests for src/projectConfig.ts — the `.sweech.json` upward walker
 * and pin schema validator.
 *
 * Filesystem strategy: every test creates its own real tmpdir, builds a
 * directory layout, and runs the resolver against that layout. We
 * deliberately avoid jest.mock('fs') here — the resolver's correctness
 * is path/HOME/walk-stop behaviour, not "what does fs.readFileSync
 * return". Mocking fs in this surface causes more bugs than it catches.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  findProjectPin,
  readProjectPin,
  writeProjectPin,
  removeProjectPin,
  tierRank,
  exceedsMaxTier,
  PIN_FILENAME,
  _resetWarningCache,
  type ProjectPin,
} from '../src/projectConfig';

// Hold onto the real HOME so each test can scope its own.
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;

function setHome(dir: string): void {
  // jest doesn't reset env vars between tests by default.
  process.env.HOME = dir;
  process.env.USERPROFILE = dir; // Windows fallback
  // os.homedir() reads env on each call so this takes effect immediately.
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-pin-'));
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

// ── readProjectPin ───────────────────────────────────────────────────────────

describe('readProjectPin', () => {
  test('returns null when the file does not exist', () => {
    const p = path.join(tmpRoot, 'nope.json');
    expect(readProjectPin(p)).toBeNull();
  });

  test('parses a fully-populated pin', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify({
      profile: 'claude-work',
      cliType: 'claude',
      maxTier: 'max',
      model: 'claude-opus-4-7',
    }));
    expect(readProjectPin(p)).toEqual({
      profile: 'claude-work',
      cliType: 'claude',
      maxTier: 'max',
      model: 'claude-opus-4-7',
    });
  });

  test('parses a partial pin (profile only)', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify({ profile: 'claude-work' }));
    expect(readProjectPin(p)).toEqual({ profile: 'claude-work' });
  });

  test('returns null and logs once for malformed JSON', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, '{ not valid json');
    expect(readProjectPin(p)).toBeNull();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain('malformed .sweech.json');
  });

  test('malformed warning is one-shot per filePath', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, '{ not valid');
    readProjectPin(p);
    readProjectPin(p);
    readProjectPin(p);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test('returns empty pin for non-object root (array)', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify(['claude-work']));
    expect(readProjectPin(p)).toEqual({});
  });

  test('returns empty pin for non-object root (string)', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify('claude-work'));
    expect(readProjectPin(p)).toEqual({});
  });

  test('drops invalid cliType with a stderr warning, keeps valid fields', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify({
      profile: 'good',
      cliType: 'banana',
    }));
    const pin = readProjectPin(p);
    expect(pin).toEqual({ profile: 'good' });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain('cliType');
  });

  test('drops invalid maxTier with a stderr warning', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify({
      profile: 'good',
      maxTier: 'super-saiyan',
    }));
    const pin = readProjectPin(p);
    expect(pin).toEqual({ profile: 'good' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('maxTier'));
  });

  test('accepts unknown keys but warns once (forward-compat)', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify({
      profile: 'good',
      newFutureKey: 'whatever',
    }));
    const pin = readProjectPin(p);
    expect(pin).toEqual({ profile: 'good' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("unknown key 'newFutureKey'"));
  });

  test('budget object is preserved through the pin', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify({
      profile: 'good',
      budget: { daily: 5, currency: 'USD' },
    }));
    const pin = readProjectPin(p);
    expect(pin).toEqual({
      profile: 'good',
      budget: { daily: 5, currency: 'USD' },
    });
  });

  test('drops budget when it is not an object', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify({
      profile: 'good',
      budget: 42,
    }));
    expect(readProjectPin(p)).toEqual({ profile: 'good' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('budget'));
  });

  test('drops empty-string profile', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify({ profile: '' }));
    expect(readProjectPin(p)).toEqual({});
  });

  test('trims whitespace from profile', () => {
    const p = path.join(tmpRoot, PIN_FILENAME);
    fs.writeFileSync(p, JSON.stringify({ profile: '  claude-work  ' }));
    expect(readProjectPin(p)).toEqual({ profile: 'claude-work' });
  });

  test('accepts all valid cliType values', () => {
    for (const cli of ['claude', 'codex', 'kimi']) {
      _resetWarningCache();
      const p = path.join(tmpRoot, PIN_FILENAME);
      fs.writeFileSync(p, JSON.stringify({ cliType: cli }));
      expect(readProjectPin(p)).toEqual({ cliType: cli });
    }
  });

  test('accepts all valid maxTier values', () => {
    for (const tier of ['free', 'pro', 'max', 'team', 'enterprise']) {
      _resetWarningCache();
      const p = path.join(tmpRoot, PIN_FILENAME);
      fs.writeFileSync(p, JSON.stringify({ maxTier: tier }));
      expect(readProjectPin(p)).toEqual({ maxTier: tier });
    }
  });
});

// ── findProjectPin (upward walk) ─────────────────────────────────────────────

describe('findProjectPin (upward walk)', () => {
  test('returns null when no pin exists anywhere under HOME', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    const sub = path.join(proj, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(findProjectPin(sub)).toBeNull();
  });

  test('finds a pin in the exact cwd', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    const pinPath = path.join(proj, PIN_FILENAME);
    fs.writeFileSync(pinPath, JSON.stringify({ profile: 'cwd-pin' }));

    const result = findProjectPin(proj);
    expect(result).not.toBeNull();
    expect(result!.pin).toEqual({ profile: 'cwd-pin' });
    expect(result!.source).toBe(pinPath);
    expect(result!.projectRoot).toBe(proj);
  });

  test('finds a pin one directory up', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    fs.writeFileSync(path.join(proj, PIN_FILENAME), JSON.stringify({ profile: 'parent-pin' }));
    const sub = path.join(proj, 'src');
    fs.mkdirSync(sub);

    const result = findProjectPin(sub);
    expect(result).not.toBeNull();
    expect(result!.pin.profile).toBe('parent-pin');
    expect(result!.projectRoot).toBe(proj);
  });

  test('finds a pin two directories up (grandparent)', () => {
    const proj = fs.mkdtempSync(path.join(homeDir, 'proj-'));
    fs.writeFileSync(path.join(proj, PIN_FILENAME), JSON.stringify({ profile: 'grandparent' }));
    const deep = path.join(proj, 'pkg', 'src');
    fs.mkdirSync(deep, { recursive: true });

    const result = findProjectPin(deep);
    expect(result!.pin.profile).toBe('grandparent');
    expect(result!.projectRoot).toBe(proj);
  });

  test('nearest pin wins over an outer pin (monorepo case)', () => {
    const root = fs.mkdtempSync(path.join(homeDir, 'mono-'));
    const inner = path.join(root, 'apps', 'web');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(root, PIN_FILENAME), JSON.stringify({ profile: 'outer' }));
    fs.writeFileSync(path.join(inner, PIN_FILENAME), JSON.stringify({ profile: 'inner' }));

    const result = findProjectPin(inner);
    expect(result!.pin.profile).toBe('inner');
    expect(result!.projectRoot).toBe(inner);
  });

  test('does not leak a HOME-level pin into an unrelated path', () => {
    // Place a pin at HOME itself.
    fs.writeFileSync(path.join(homeDir, PIN_FILENAME), JSON.stringify({ profile: 'home-pin' }));

    // Start from a totally unrelated path (sibling of HOME under tmpRoot).
    const unrelated = fs.mkdtempSync(path.join(tmpRoot, 'unrelated-'));

    expect(findProjectPin(unrelated)).toBeNull();
  });

  test('uses a HOME-level pin when cwd IS HOME', () => {
    fs.writeFileSync(path.join(homeDir, PIN_FILENAME), JSON.stringify({ profile: 'home-pin' }));
    const result = findProjectPin(homeDir);
    expect(result).not.toBeNull();
    expect(result!.pin.profile).toBe('home-pin');
  });

  test('uses a HOME-level pin from a subdirectory of HOME', () => {
    fs.writeFileSync(path.join(homeDir, PIN_FILENAME), JSON.stringify({ profile: 'home-pin' }));
    const sub = path.join(homeDir, 'subproject');
    fs.mkdirSync(sub);
    const result = findProjectPin(sub);
    expect(result).not.toBeNull();
    expect(result!.pin.profile).toBe('home-pin');
  });

  test('uses safe cwd fallback when cwd is empty / undefined', () => {
    // We just verify it doesn't throw and is resolved relative to a real path.
    expect(() => findProjectPin()).not.toThrow();
  });

  test('keeps walking past a malformed pin (does not block outer good pin)', () => {
    const outer = fs.mkdtempSync(path.join(homeDir, 'outer-'));
    fs.writeFileSync(path.join(outer, PIN_FILENAME), JSON.stringify({ profile: 'outer-good' }));
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, PIN_FILENAME), '{ malformed');

    const result = findProjectPin(inner);
    expect(result).not.toBeNull();
    expect(result!.pin.profile).toBe('outer-good');
    // Warning was logged for the malformed inner pin.
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('malformed .sweech.json'));
  });
});

// ── tierRank / exceedsMaxTier ────────────────────────────────────────────────

describe('tierRank', () => {
  test('ranks free < pro < max < team < enterprise', () => {
    expect(tierRank('free')).toBeLessThan(tierRank('pro'));
    expect(tierRank('pro')).toBeLessThan(tierRank('max'));
    expect(tierRank('max')).toBeLessThan(tierRank('team'));
    expect(tierRank('team')).toBeLessThan(tierRank('enterprise'));
  });

  test('is case-insensitive', () => {
    expect(tierRank('MAX')).toBe(tierRank('max'));
    expect(tierRank('Pro')).toBe(tierRank('pro'));
  });

  test('normalises keychain-style tier strings (max_5x → max)', () => {
    expect(tierRank('max_5x')).toBe(tierRank('max'));
    expect(tierRank('max_20x')).toBe(tierRank('max'));
    // keychain commonly stores `default_claude_max_20x` — substring match wins.
    expect(tierRank('default_claude_max_20x')).toBe(tierRank('max'));
    expect(tierRank('default_claude_pro_5x')).toBe(tierRank('pro'));
  });

  test('returns -1 for unknown / missing tiers', () => {
    expect(tierRank(undefined)).toBe(-1);
    expect(tierRank(null)).toBe(-1);
    expect(tierRank('')).toBe(-1);
    expect(tierRank('banana')).toBe(-1);
  });
});

describe('exceedsMaxTier', () => {
  test('no cap = nothing exceeds', () => {
    expect(exceedsMaxTier('enterprise', undefined)).toBe(false);
  });

  test('cap at max — enterprise exceeds', () => {
    expect(exceedsMaxTier('enterprise', 'max')).toBe(true);
  });

  test('cap at max — max does NOT exceed', () => {
    expect(exceedsMaxTier('max', 'max')).toBe(false);
  });

  test('cap at max — pro does NOT exceed', () => {
    expect(exceedsMaxTier('pro', 'max')).toBe(false);
  });

  test('unknown tier candidates pass through (do not filter)', () => {
    expect(exceedsMaxTier('banana', 'max')).toBe(false);
    expect(exceedsMaxTier(undefined, 'max')).toBe(false);
  });

  test('keychain "max_20x" treated as max, does not exceed max cap', () => {
    expect(exceedsMaxTier('max_20x', 'max')).toBe(false);
  });

  test('team exceeds max cap', () => {
    expect(exceedsMaxTier('team', 'max')).toBe(true);
  });
});

// ── writeProjectPin / removeProjectPin ───────────────────────────────────────

describe('writeProjectPin', () => {
  test('writes the JSON to ./.sweech.json in the target dir', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'wp-'));
    const out = writeProjectPin(dir, { profile: 'claude-work', cliType: 'claude' });
    expect(out).toBe(path.join(dir, PIN_FILENAME));
    const written = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(written).toEqual({ profile: 'claude-work', cliType: 'claude' });
  });

  test('strips undefined keys before serialising', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'wp-'));
    const out = writeProjectPin(dir, { profile: 'p', cliType: undefined });
    const written = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(written).toEqual({ profile: 'p' });
    expect('cliType' in written).toBe(false);
  });

  test('round-trips through readProjectPin cleanly', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'wp-'));
    const original: ProjectPin = {
      profile: 'claude-work',
      cliType: 'claude',
      maxTier: 'max',
      model: 'opus',
    };
    const out = writeProjectPin(dir, original);
    expect(readProjectPin(out)).toEqual(original);
  });

  test('overwrites an existing pin file', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'wp-'));
    writeProjectPin(dir, { profile: 'first' });
    writeProjectPin(dir, { profile: 'second' });
    const written = JSON.parse(fs.readFileSync(path.join(dir, PIN_FILENAME), 'utf-8'));
    expect(written.profile).toBe('second');
  });
});

describe('removeProjectPin', () => {
  test('returns true and deletes the file when present', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'rp-'));
    writeProjectPin(dir, { profile: 'doomed' });
    expect(removeProjectPin(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, PIN_FILENAME))).toBe(false);
  });

  test('returns false when the file is missing (idempotent)', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'rp-'));
    expect(removeProjectPin(dir)).toBe(false);
  });
});
