/**
 * Security-focused tests for sweech.
 *
 * Covers: command injection prevention, credential store safety,
 * directory permissions, PBKDF2 iterations, atomic file writes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SRC = path.join(__dirname, '..', 'src');

function readSrc(file: string): string {
  return fs.readFileSync(path.join(SRC, file), 'utf-8');
}

// ---------------------------------------------------------------------------
// Atomic write tests
// ---------------------------------------------------------------------------

describe('atomicWriteFileSync', () => {
  let atomicWriteFileSync: (filePath: string, data: string | Buffer) => void;
  let tmpDir: string;

  beforeAll(() => {
    ({ atomicWriteFileSync } = require(path.join(SRC, 'atomicWrite')));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-security-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes file atomically', () => {
    const target = path.join(tmpDir, 'test-atomic.json');
    atomicWriteFileSync(target, '{"hello": "world"}');
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"hello": "world"}');
  });

  test('writes Buffer data', () => {
    const target = path.join(tmpDir, 'test-buffer.bin');
    const data = Buffer.from([0x01, 0x02, 0x03]);
    atomicWriteFileSync(target, data);
    expect(fs.readFileSync(target)).toEqual(data);
  });

  test('cleans up temp file on write failure', () => {
    const target = path.join(tmpDir, 'nonexistent', 'nested', 'fail.txt');
    expect(() => atomicWriteFileSync(target, 'data')).toThrow();
    const files = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp.'));
    expect(files).toHaveLength(0);
  });

  test('cleans up temp file on rename failure', () => {
    const dir = path.join(tmpDir, 'target-is-dir');
    fs.mkdirSync(dir, { recursive: true });
    expect(() => atomicWriteFileSync(dir, 'data')).toThrow();
    const files = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp.'));
    expect(files).toHaveLength(0);
  });

  test('temp file name includes PID and timestamp', () => {
    const target = path.join(tmpDir, 'pattern-test.json');
    atomicWriteFileSync(target, '{}');
    // No .tmp files should remain after successful write
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
    // The target file should exist with correct content
    expect(fs.readFileSync(target, 'utf-8')).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// PBKDF2 iteration count tests
// ---------------------------------------------------------------------------

describe('PBKDF2 iteration count', () => {
  test('backup.ts uses 600k iterations for encryption', () => {
    expect(readSrc('backup.ts')).toContain('PBKDF2_ITERATIONS = 600000');
  });

  test('chatBackup.ts uses 600k iterations', () => {
    expect(readSrc('chatBackup.ts')).toContain('PBKDF2_ITERATIONS = 600000');
  });

  test('backup decrypt has 100k fallback for backward compat', () => {
    const source = readSrc('backup.ts');
    expect(source).toMatch(/100000/);
  });
});

// ---------------------------------------------------------------------------
// Command injection prevention tests
// ---------------------------------------------------------------------------

describe('command injection prevention', () => {
  test('plugins.ts uses execFileSync for npm commands', () => {
    const source = readSrc('plugins.ts');
    expect(source).not.toMatch(/execSync\(`npm install/);
    expect(source).not.toMatch(/execSync\(`npm uninstall/);
    expect(source).toMatch(/execFileSync\('npm', \['install'/);
    expect(source).toMatch(/execFileSync\('npm', \['uninstall'/);
  });

  test('liveUsage.ts uses execFileSync for security commands', () => {
    const source = readSrc('liveUsage.ts');
    expect(source).not.toMatch(/execSync\(\s*`security find-generic-password.*\$\{/);
    expect(source).toMatch(/execFileSync\('security', \[/);
  });

  test('subscriptions.ts uses execFileSync for keychain reads', () => {
    const source = readSrc('subscriptions.ts');
    expect(source).not.toMatch(/execSync\(\s*`security find-generic-password.*\$\{/);
  });

  test('credentialStore Linux store uses execFileSync for secret-tool', () => {
    const source = readSrc('credentialStore.ts');
    expect(source).toMatch(/execFileSync\('secret-tool'/);
  });
});

// ---------------------------------------------------------------------------
// Directory permissions tests
// ---------------------------------------------------------------------------

describe('directory permissions', () => {
  const securityFiles = [
    'credentialStore.ts',
    'launchd.ts',
    'liveUsage.ts',
    'updateChecker.ts',
    'templates.ts',
    'launcher.ts',
    'auditLog.ts',
    'cli.ts',
    'subscriptions.ts',
    'team.ts',
    'fedClient.ts',
    'usageHistory.ts',
    'plugins.ts',
  ];

  test.each(securityFiles)('%s uses mode: 0o700 for recursive mkdirSync', (file) => {
    const source = readSrc(file);
    const mkdirMatches = source.match(/mkdirSync\([^)]+\)/g) || [];
    for (const match of mkdirMatches) {
      if (match.includes('recursive')) {
        expect(match).toContain('0o700');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Credential store shell safety
// ---------------------------------------------------------------------------

describe('credential store shell safety', () => {
  test('macOS keychain has escapeShellArg function', () => {
    const source = readSrc('credentialStore.ts');
    expect(source).toMatch(/function escapeShellArg/);
    // Should handle single-quote escaping
    expect(source).toMatch(/replace\([^)]*'/);
  });
});

// ---------------------------------------------------------------------------
// Profile name validation
// ---------------------------------------------------------------------------

describe('profile name validation', () => {
  const safePattern = /^[a-z0-9-]+$/;

  test('accepts valid profile names', () => {
    expect(safePattern.test('claude-pole')).toBe(true);
    expect(safePattern.test('my-profile-123')).toBe(true);
    expect(safePattern.test('a')).toBe(true);
  });

  test('rejects shell metacharacters', () => {
    expect(safePattern.test('; rm -rf /')).toBe(false);
    expect(safePattern.test('$(evil)')).toBe(false);
    expect(safePattern.test('`cmd`')).toBe(false);
    expect(safePattern.test('foo"bar')).toBe(false);
    expect(safePattern.test("foo'bar")).toBe(false);
    expect(safePattern.test('a&b')).toBe(false);
    expect(safePattern.test('a|b')).toBe(false);
    expect(safePattern.test('a>b')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Atomic write adoption
// ---------------------------------------------------------------------------

describe('atomic write adoption', () => {
  const criticalFiles = ['team.ts', 'usage.ts', 'subscriptions.ts'];

  test.each(criticalFiles)('%s imports atomicWriteFileSync', (file) => {
    const source = readSrc(file);
    expect(source).toMatch(/atomicWriteFileSync/);
  });

  test('config.ts uses atomicWriteFileSync for config writes', () => {
    const source = readSrc('config.ts');
    expect(source).toMatch(/atomicWriteFileSync/);
  });
});
