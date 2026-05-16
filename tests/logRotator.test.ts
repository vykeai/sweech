/**
 * T-054: tests for the fed-server log rotator (CommonJS sibling of
 * packages/engine/src/__tests__/daemon/log.test.ts).
 *
 * Cases:
 *   - rotates when size > maxBytes
 *   - rotates when mtime is from a previous calendar day
 *   - cap of N kept files (oldest dropped)
 *   - no-op when neither size nor day boundary triggers
 *   - missing log file = no-op (not error)
 *   - back-to-back calls produce one rotation, not two
 *   - active log keeps its inode (copy-truncate, not rename)
 *   - SWEECH_LOG_PATH env override
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogRotator, maybeRotateLog, getServeLogPath, DEFAULT_KEEP } from '../src/logRotator';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-log-test-'));
}

function makeLog(filePath: string, sizeBytes: number, mtime?: Date): void {
  const chunk = Buffer.alloc(Math.min(sizeBytes, 64 * 1024), 0x41);
  const fd = fs.openSync(filePath, 'w');
  try {
    let remaining = sizeBytes;
    while (remaining > 0) {
      const take = Math.min(remaining, chunk.length);
      fs.writeSync(fd, chunk, 0, take, null);
      remaining -= take;
    }
  } finally {
    fs.closeSync(fd);
  }
  if (mtime) fs.utimesSync(filePath, mtime, mtime);
}

describe('logRotator — maybeRotateLog', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = makeTempDir();
    logPath = path.join(dir, 'sweech-serve.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rotates when size exceeds maxBytes', () => {
    makeLog(logPath, 200);
    const res = maybeRotateLog(logPath, { maxBytes: 100, keep: 5 });
    expect(res.rotated).toBe(true);
    expect(res.reason).toBe('size');
    expect(res.sizeBefore).toBe(200);
    expect(fs.statSync(logPath).size).toBe(0);
    expect(fs.statSync(`${logPath}.1`).size).toBe(200);
  });

  it('rotates when mtime is from a previous local calendar day', () => {
    makeLog(logPath, 50);
    const oldDate = new Date(Date.now() - 36 * 60 * 60 * 1000);
    fs.utimesSync(logPath, oldDate, oldDate);

    const res = maybeRotateLog(logPath, { maxBytes: 10_000_000, keep: 5 });
    expect(res.rotated).toBe(true);
    expect(res.reason).toBe('daily');
    expect(fs.statSync(logPath).size).toBe(0);
    expect(fs.statSync(`${logPath}.1`).size).toBe(50);
  });

  it('no-op when neither size nor day boundary triggers', () => {
    makeLog(logPath, 50);
    const res = maybeRotateLog(logPath, { maxBytes: 10_000, keep: 5 });
    expect(res.rotated).toBe(false);
    expect(res.reason).toBe('no-op');
    expect(fs.statSync(logPath).size).toBe(50);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });

  it('returns missing when log does not exist', () => {
    const res = maybeRotateLog(logPath, { maxBytes: 100, keep: 5 });
    expect(res.rotated).toBe(false);
    expect(res.reason).toBe('missing');
    expect(res.sizeBefore).toBe(0);
  });

  it('caps history at `keep` files — older rotations are dropped', () => {
    fs.writeFileSync(`${logPath}.1`, 'b1');
    fs.writeFileSync(`${logPath}.2`, 'b2');
    fs.writeFileSync(`${logPath}.3`, 'b3');
    fs.writeFileSync(`${logPath}.4`, 'b4');
    fs.writeFileSync(`${logPath}.5`, 'b5');
    makeLog(logPath, 200);

    const res = maybeRotateLog(logPath, { maxBytes: 100, keep: 5 });
    expect(res.rotated).toBe(true);

    expect(fs.statSync(`${logPath}.1`).size).toBe(200);
    expect(fs.readFileSync(`${logPath}.2`, 'utf-8')).toBe('b1');
    expect(fs.readFileSync(`${logPath}.3`, 'utf-8')).toBe('b2');
    expect(fs.readFileSync(`${logPath}.4`, 'utf-8')).toBe('b3');
    expect(fs.readFileSync(`${logPath}.5`, 'utf-8')).toBe('b4');
    expect(fs.existsSync(`${logPath}.6`)).toBe(false);
  });

  it('uses copy-truncate semantics (active log keeps its inode)', () => {
    makeLog(logPath, 200);
    const inodeBefore = fs.statSync(logPath).ino;

    const res = maybeRotateLog(logPath, { maxBytes: 100, keep: 5 });
    expect(res.rotated).toBe(true);

    const inodeAfter = fs.statSync(logPath).ino;
    // launchd holds the writer fd. Truncate must preserve the inode so the
    // fd keeps writing into the same (now-empty) file.
    expect(inodeAfter).toBe(inodeBefore);
  });

  it('rejects invalid keep or maxBytes', () => {
    makeLog(logPath, 50);
    expect(() => maybeRotateLog(logPath, { keep: 0 })).toThrow(/keep must be >= 1/);
    expect(() => maybeRotateLog(logPath, { maxBytes: 0 })).toThrow(/maxBytes must be >= 1/);
  });
});

describe('LogRotator — class API + concurrency', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = makeTempDir();
    logPath = path.join(dir, 'sweech-serve.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('two sequential maybeRotate() calls produce one rotation', () => {
    makeLog(logPath, 200);
    const rotator = new LogRotator({ logPath, maxBytes: 100, keep: 5 });
    const first = rotator.maybeRotate();
    expect(first.rotated).toBe(true);
    const second = rotator.maybeRotate();
    expect(second.rotated).toBe(false);
    expect(second.reason).toBe('no-op');
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.existsSync(`${logPath}.2`)).toBe(false);
  });

  it('start() runs an immediate rotation when criteria met', () => {
    makeLog(logPath, 200);
    const rotator = new LogRotator({ logPath, maxBytes: 100, keep: 5, intervalMs: 60_000 });
    rotator.start();
    try {
      expect(fs.statSync(logPath).size).toBe(0);
      expect(fs.statSync(`${logPath}.1`).size).toBe(200);
    } finally {
      rotator.stop();
    }
  });

  it('start() then stop() removes the timer', async () => {
    makeLog(logPath, 50);
    const rotator = new LogRotator({ logPath, maxBytes: 1_000_000, keep: 5, intervalMs: 25 });
    rotator.start();
    rotator.stop();

    makeLog(logPath, 1_500_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.statSync(logPath).size).toBe(1_500_000);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });

  it('stop() is idempotent', () => {
    const rotator = new LogRotator({ logPath, maxBytes: 100, keep: 5 });
    rotator.stop();
    rotator.start();
    rotator.stop();
    rotator.stop();
  });

  it('start() is idempotent', () => {
    makeLog(logPath, 200);
    const rotator = new LogRotator({ logPath, maxBytes: 100, keep: 5, intervalMs: 60_000 });
    rotator.start();
    rotator.start();
    try {
      expect(fs.existsSync(`${logPath}.1`)).toBe(true);
      expect(fs.existsSync(`${logPath}.2`)).toBe(false);
    } finally {
      rotator.stop();
    }
  });
});

describe('getServeLogPath', () => {
  it('honours SWEECH_LOG_PATH override', () => {
    expect(getServeLogPath({ SWEECH_LOG_PATH: '/tmp/custom.log' })).toBe('/tmp/custom.log');
  });

  it('falls back to ~/Library/Logs/sweech-serve.log when env unset', () => {
    expect(getServeLogPath({})).toMatch(/Library\/Logs\/sweech-serve\.log$/);
  });

  it('treats blank SWEECH_LOG_PATH as unset', () => {
    expect(getServeLogPath({ SWEECH_LOG_PATH: '   ' })).toMatch(/Library\/Logs\/sweech-serve\.log$/);
  });
});

describe('DEFAULT_KEEP matches T-054 acceptance criteria', () => {
  it('keeps 5 rotations by default', () => {
    expect(DEFAULT_KEEP).toBe(5);
  });
});
