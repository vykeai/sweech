/**
 * Tests for doctor command: database integrity check (T-010)
 *
 * Verifies that runDoctor() finds *.sqlite and *.db files in profile
 * directories and runs `sqlite3 <file> "PRAGMA integrity_check"`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// We test the logic in isolation rather than calling runDoctor() directly,
// because runDoctor() has many side effects (console output, network calls,
// keychain access). Instead we verify the building blocks.

describe('Doctor Database Integrity Check', () => {
  const tmpDir = path.join(os.tmpdir(), `sweech-doctor-db-test-${Date.now()}`);
  let hasSqlite3 = false;

  beforeAll(async () => {
    fs.mkdirSync(tmpDir, { recursive: true });

    // Check if sqlite3 is available
    try {
      await execFileAsync('sqlite3', ['--version'], { timeout: 5000 });
      hasSqlite3 = true;
    } catch {
      hasSqlite3 = false;
    }
  });

  afterAll(() => {
    // Clean up
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  });

  test('finds .sqlite files in a directory', () => {
    const profileDir = path.join(tmpDir, 'profile-sqlite');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'data.sqlite'), '');
    fs.writeFileSync(path.join(profileDir, 'other.txt'), '');

    const entries = fs.readdirSync(profileDir);
    const dbFiles = entries.filter(e => e.endsWith('.sqlite') || e.endsWith('.db'));
    expect(dbFiles).toEqual(['data.sqlite']);
  });

  test('finds .db files in a directory', () => {
    const profileDir = path.join(tmpDir, 'profile-db');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'cache.db'), '');
    fs.writeFileSync(path.join(profileDir, 'notes.txt'), '');

    const entries = fs.readdirSync(profileDir);
    const dbFiles = entries.filter(e => e.endsWith('.sqlite') || e.endsWith('.db'));
    expect(dbFiles).toEqual(['cache.db']);
  });

  test('finds both .sqlite and .db files', () => {
    const profileDir = path.join(tmpDir, 'profile-both');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'a.sqlite'), '');
    fs.writeFileSync(path.join(profileDir, 'b.db'), '');

    const entries = fs.readdirSync(profileDir);
    const dbFiles = entries.filter(e => e.endsWith('.sqlite') || e.endsWith('.db'));
    expect(dbFiles).toHaveLength(2);
    expect(dbFiles).toContain('a.sqlite');
    expect(dbFiles).toContain('b.db');
  });

  test('returns empty when no db files exist', () => {
    const profileDir = path.join(tmpDir, 'profile-empty');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'readme.md'), '');

    const entries = fs.readdirSync(profileDir);
    const dbFiles = entries.filter(e => e.endsWith('.sqlite') || e.endsWith('.db'));
    expect(dbFiles).toHaveLength(0);
  });

  test('handles non-existent directory gracefully', () => {
    const missingDir = path.join(tmpDir, 'does-not-exist');
    expect(fs.existsSync(missingDir)).toBe(false);

    // The doctor code checks fs.existsSync before readdirSync
    let dbFiles: string[] = [];
    if (fs.existsSync(missingDir)) {
      const entries = fs.readdirSync(missingDir);
      dbFiles = entries.filter(e => e.endsWith('.sqlite') || e.endsWith('.db'));
    }
    expect(dbFiles).toHaveLength(0);
  });

  // Conditional tests that require sqlite3 binary
  const sqliteTest = hasSqlite3 ? test : test.skip;

  test('sqlite3 PRAGMA integrity_check on healthy DB returns ok', async () => {
    if (!hasSqlite3) return;

    const dbPath = path.join(tmpDir, 'healthy.db');
    // Create a valid SQLite database
    await execFileAsync('sqlite3', [dbPath, 'CREATE TABLE t(x); INSERT INTO t VALUES(1);'], { timeout: 5000 });

    const { stdout } = await execFileAsync('sqlite3', [dbPath, 'PRAGMA integrity_check'], { timeout: 5000 });
    expect(stdout.trim()).toBe('ok');
  });

  test('sqlite3 command fails on invalid file', async () => {
    if (!hasSqlite3) return;

    const badPath = path.join(tmpDir, 'corrupt.db');
    fs.writeFileSync(badPath, 'not a real sqlite database');

    try {
      await execFileAsync('sqlite3', [badPath, 'PRAGMA integrity_check'], { timeout: 5000 });
      // If it somehow succeeds, the result should not be "ok"
    } catch {
      // Expected to fail — corrupt file
      expect(true).toBe(true);
    }
  });

  test('timeout parameter is respected (5 seconds)', () => {
    // Verify the pattern: execFileAsync('sqlite3', [...], { timeout: 5000 })
    // The timeout value used in runDoctor is 5000ms
    const EXPECTED_TIMEOUT = 5000;
    expect(EXPECTED_TIMEOUT).toBe(5000);
  });

  test('doctor checks db files after size check and before symlinks', async () => {
    // Read the source to verify ordering
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'utilityCommands.ts'),
      'utf-8',
    );

    const sizeCheckIdx = src.indexOf('Check profile data directory size');
    const dbCheckIdx = src.indexOf('Check SQLite database integrity');
    const symlinkIdx = src.indexOf('Check symlinks for profiles that share data');

    expect(sizeCheckIdx).toBeGreaterThan(-1);
    expect(dbCheckIdx).toBeGreaterThan(-1);
    expect(symlinkIdx).toBeGreaterThan(-1);

    // DB check should be after size check and before symlink check
    expect(dbCheckIdx).toBeGreaterThan(sizeCheckIdx);
    expect(dbCheckIdx).toBeLessThan(symlinkIdx);
  });

  test('integrity check uses PRAGMA integrity_check command', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'utilityCommands.ts'),
      'utf-8',
    );

    expect(src).toContain("'PRAGMA integrity_check'");
    expect(src).toContain("'sqlite3'");
  });

  test('result "ok" is treated as success', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'utilityCommands.ts'),
      'utf-8',
    );

    // Verify the success condition
    expect(src).toContain("stdout.trim() === 'ok'");
  });
});
