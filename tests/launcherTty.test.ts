/**
 * E2E: launcher must fail-fast when stdin is not a TTY.
 *
 * Without this guard, `node dist/cli.js < /dev/null` (CI, piped invocation,
 * subprocess chains) would hang forever waiting for keypresses that can
 * never arrive.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'cli.js');

describe('launcher non-TTY fail-fast', () => {
  beforeAll(() => {
    // Sanity: the test depends on a built CLI.
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`dist/cli.js not found — run \`npm run build\` first.`);
    }
  });

  it('exits non-zero with a helpful error on stderr when stdin is not a TTY', async () => {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve) => {
      // stdio: ['pipe', 'pipe', 'pipe'] — none of these are TTYs.
      const child = spawn('node', [CLI_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDECODE: undefined } as NodeJS.ProcessEnv,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });

      // Close stdin immediately (no input, no TTY).
      child.stdin.end();

      const killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 5000);

      child.on('exit', (code, signal) => {
        clearTimeout(killTimer);
        resolve({ code, signal, stdout, stderr, timedOut });
      });
    });

    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.code).not.toBeNull();
    expect(result.stderr).toContain('sweech launcher requires an interactive terminal');
    expect(result.stderr).toContain('`sweech list`');
    // The fail-fast message should NOT leak onto stdout.
    expect(result.stdout).not.toContain('sweech launcher requires an interactive terminal');
  }, 10000);
});
