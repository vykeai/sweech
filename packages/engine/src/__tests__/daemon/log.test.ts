/// T-054: tests for the daemon log rotator.
///
/// Cases:
///   - rotates when size > maxBytes
///   - rotates when mtime is from a previous calendar day
///   - cap of N kept files (oldest dropped)
///   - no-op when neither size nor day boundary triggers
///   - missing log file = no-op (not error)
///   - back-to-back calls produce one rotation, not two
///   - active log keeps its inode (copy-truncate, not rename)
///   - SWEECH_LOG_PATH env override
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, stat, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { LogRotator, maybeRotateLog, getDaemonLogPath, DEFAULT_KEEP } from '../../daemon/log.js';

async function makeLog(path: string, sizeBytes: number, mtime?: Date): Promise<void> {
  const chunk = Buffer.alloc(Math.min(sizeBytes, 1024 * 64), 0x41);
  // Build the file in chunks so >10 MiB tests don't allocate one giant buffer.
  const handle = await (await import('node:fs/promises')).open(path, 'w');
  try {
    let remaining = sizeBytes;
    while (remaining > 0) {
      const take = Math.min(remaining, chunk.length);
      await handle.write(chunk.subarray(0, take));
      remaining -= take;
    }
  } finally {
    await handle.close();
  }
  if (mtime) {
    await utimes(path, mtime, mtime);
  }
}

describe('LogRotator — maybeRotateLog (one-shot)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sweech-log-test-'));
    logPath = join(dir, 'sweech-serve.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rotates when size exceeds maxBytes', async () => {
    await makeLog(logPath, 200);
    const res = maybeRotateLog(logPath, { maxBytes: 100, keep: 5 });
    expect(res.rotated).toBe(true);
    expect(res.reason).toBe('size');
    expect(res.sizeBefore).toBe(200);
    // Active log truncated; .1 holds the previous content.
    expect(statSync(logPath).size).toBe(0);
    expect(statSync(`${logPath}.1`).size).toBe(200);
  });

  it('rotates when mtime is from a previous local calendar day', async () => {
    await makeLog(logPath, 50);
    // Fake mtime: 36h ago. Definitely a prior calendar day.
    const oldDate = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await utimes(logPath, oldDate, oldDate);

    const res = maybeRotateLog(logPath, { maxBytes: 10_000_000, keep: 5 });
    expect(res.rotated).toBe(true);
    expect(res.reason).toBe('daily');
    expect(statSync(logPath).size).toBe(0);
    expect(statSync(`${logPath}.1`).size).toBe(50);
  });

  it('no-op when neither size nor day boundary triggers', async () => {
    await makeLog(logPath, 50);
    // mtime = now → same calendar day, size under limit.
    const res = maybeRotateLog(logPath, { maxBytes: 10_000, keep: 5 });
    expect(res.rotated).toBe(false);
    expect(res.reason).toBe('no-op');
    expect(statSync(logPath).size).toBe(50);
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it('returns missing when log does not exist', () => {
    const res = maybeRotateLog(logPath, { maxBytes: 100, keep: 5 });
    expect(res.rotated).toBe(false);
    expect(res.reason).toBe('missing');
    expect(res.sizeBefore).toBe(0);
  });

  it('caps history at `keep` files — older rotations are dropped', async () => {
    // Pre-seed .1 … .5 with distinct content, then rotate the active file.
    await writeFile(`${logPath}.1`, 'b1');
    await writeFile(`${logPath}.2`, 'b2');
    await writeFile(`${logPath}.3`, 'b3');
    await writeFile(`${logPath}.4`, 'b4');
    await writeFile(`${logPath}.5`, 'b5');
    await makeLog(logPath, 200);

    const res = maybeRotateLog(logPath, { maxBytes: 100, keep: 5 });
    expect(res.rotated).toBe(true);

    // After rotation: .1 = previous active, .2 = old .1, .3 = old .2, etc.
    // Old .5 ('b5') must be gone. There must be no .6.
    expect(statSync(`${logPath}.1`).size).toBe(200);
    expect(await readFile(`${logPath}.2`, 'utf-8')).toBe('b1');
    expect(await readFile(`${logPath}.3`, 'utf-8')).toBe('b2');
    expect(await readFile(`${logPath}.4`, 'utf-8')).toBe('b3');
    expect(await readFile(`${logPath}.5`, 'utf-8')).toBe('b4');
    expect(existsSync(`${logPath}.6`)).toBe(false);
  });

  it('uses copy-truncate semantics (active log keeps its inode)', async () => {
    await makeLog(logPath, 200);
    const inodeBefore = statSync(logPath).ino;

    const res = maybeRotateLog(logPath, { maxBytes: 100, keep: 5 });
    expect(res.rotated).toBe(true);

    const inodeAfter = statSync(logPath).ino;
    // Critical: launchd holds the writer fd. Truncate must preserve the inode
    // so the fd keeps writing into the same (now-empty) file. A rename-based
    // rotation would change the inode here and break the writer fd.
    expect(inodeAfter).toBe(inodeBefore);
  });

  it('honours custom keep count (keep=3)', async () => {
    await writeFile(`${logPath}.1`, 'b1');
    await writeFile(`${logPath}.2`, 'b2');
    await writeFile(`${logPath}.3`, 'b3');
    await makeLog(logPath, 200);

    const res = maybeRotateLog(logPath, { maxBytes: 100, keep: 3 });
    expect(res.rotated).toBe(true);

    expect(statSync(`${logPath}.1`).size).toBe(200);
    expect(await readFile(`${logPath}.2`, 'utf-8')).toBe('b1');
    expect(await readFile(`${logPath}.3`, 'utf-8')).toBe('b2');
    // Old .3 ('b3') is gone; no .4 exists.
    expect(existsSync(`${logPath}.4`)).toBe(false);
  });

  it('rejects invalid keep or maxBytes', async () => {
    await makeLog(logPath, 50);
    expect(() => maybeRotateLog(logPath, { keep: 0 })).toThrow(/keep must be >= 1/);
    expect(() => maybeRotateLog(logPath, { maxBytes: 0 })).toThrow(/maxBytes must be >= 1/);
  });
});

describe('LogRotator — class API + concurrency', () => {
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sweech-log-test-'));
    logPath = join(dir, 'sweech-serve.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('two sequential maybeRotate() calls produce one rotation', async () => {
    await makeLog(logPath, 200);

    const rotator = new LogRotator({ logPath, maxBytes: 100, keep: 5 });
    const first = rotator.maybeRotate();
    expect(first.rotated).toBe(true);
    // Active log is now empty (truncated) → second call sees size 0 → no-op.
    const second = rotator.maybeRotate();
    expect(second.rotated).toBe(false);
    expect(second.reason).toBe('no-op');
    // Still only one historical file (.1), not two.
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(false);
  });

  it('start() runs an immediate rotation when criteria met', async () => {
    await makeLog(logPath, 200);
    const rotator = new LogRotator({ logPath, maxBytes: 100, keep: 5, intervalMs: 60_000 });
    rotator.start();
    try {
      // Immediate check ran synchronously in start().
      expect(statSync(logPath).size).toBe(0);
      expect(statSync(`${logPath}.1`).size).toBe(200);
    } finally {
      rotator.stop();
    }
  });

  it('start() then stop() removes the timer (no second rotation)', async () => {
    await makeLog(logPath, 50);
    const rotator = new LogRotator({ logPath, maxBytes: 1_000_000, keep: 5, intervalMs: 25 });
    rotator.start();
    rotator.stop();

    // Grow the file past the threshold AFTER stopping. If the timer were
    // still alive, it would rotate within 25 ms.
    await makeLog(logPath, 1_500_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(statSync(logPath).size).toBe(1_500_000);
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  it('stop() is idempotent', () => {
    const rotator = new LogRotator({ logPath, maxBytes: 100, keep: 5 });
    rotator.stop(); // before start
    rotator.start();
    rotator.stop();
    rotator.stop(); // double stop — must not throw
  });

  it('start() is idempotent (calling twice does not double-schedule)', async () => {
    await makeLog(logPath, 200);
    const rotator = new LogRotator({ logPath, maxBytes: 100, keep: 5, intervalMs: 60_000 });
    rotator.start();
    rotator.start();
    try {
      // Both calls combined still produce a single .1 (one rotation).
      expect(existsSync(`${logPath}.1`)).toBe(true);
      expect(existsSync(`${logPath}.2`)).toBe(false);
    } finally {
      rotator.stop();
    }
  });

  it('onError handler captures rotation failures', async () => {
    // Make a directory at the active log path → copyFileSync will throw EISDIR.
    await (await import('node:fs/promises')).mkdir(logPath, { recursive: true });
    const errors: unknown[] = [];
    const rotator = new LogRotator({
      logPath,
      maxBytes: 1,
      keep: 5,
      intervalMs: 60_000,
      onError: (e) => errors.push(e),
    });
    rotator.start();
    try {
      // start() runs maybeRotate synchronously → statSync(dir).size is 64
      // on macOS so it triggers size rotation, which then fails on copy.
      // Any non-zero capture proves the error path runs.
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      rotator.stop();
    }
  });
});

describe('getDaemonLogPath', () => {
  it('honours SWEECH_LOG_PATH override', () => {
    const p = getDaemonLogPath({ SWEECH_LOG_PATH: '/tmp/custom.log' });
    expect(p).toBe('/tmp/custom.log');
  });

  it('falls back to ~/Library/Logs/sweech-serve.log when env unset', () => {
    const p = getDaemonLogPath({});
    expect(p).toMatch(/Library\/Logs\/sweech-serve\.log$/);
  });

  it('treats blank SWEECH_LOG_PATH as unset', () => {
    const p = getDaemonLogPath({ SWEECH_LOG_PATH: '   ' });
    expect(p).toMatch(/Library\/Logs\/sweech-serve\.log$/);
  });
});

describe('DEFAULT_KEEP matches T-054 acceptance criteria', () => {
  it('keeps 5 historical rotations by default', () => {
    expect(DEFAULT_KEEP).toBe(5);
  });
});
