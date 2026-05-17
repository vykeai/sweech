/**
 * E2E test: `sweech accounts <action> --email --json` error envelope.
 *
 * The CRUD wave (T-LU-010) added hide/unhide/logout/delete/edit verbs
 * under `sweech accounts`. Each path catches resolver throws and emits a
 * `{ ok: false, error }` JSON envelope to stdout while exiting non-zero.
 *
 * This test spawns the real CLI against an isolated $HOME so the error
 * envelope is exercised end-to-end (resolver → catch → JSON.stringify
 * → exit code). Unit tests in tests/accountCrud.test.ts cover the
 * resolver throws directly; this test guards the CLI plumbing.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

/**
 * Extract the LAST JSON object printed to stdout. The CLI uses
 * JSON.stringify(..., null, 2) which spans multiple lines, so a naive
 * .split('\n').pop() returns just the closing brace. Walk backward
 * matching braces instead.
 */
function parseEnvelope(stdout: string): { ok: boolean; error?: string } {
  const trimmed = stdout.trimEnd();
  const end = trimmed.lastIndexOf('}');
  if (end < 0) throw new Error(`no JSON object in stdout: ${stdout}`);
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return JSON.parse(trimmed.slice(i, end + 1));
    }
  }
  throw new Error(`unbalanced JSON in stdout: ${stdout}`);
}

function runCli(
  args: string[],
  homeOverride: string,
): { stdout: string; stderr: string; code: number } {
  const result = cp.spawnSync('node', [CLI_PATH, ...args], {
    env: {
      ...process.env,
      HOME: homeOverride,
      // Disable colour so JSON parse below isn't tripped by ANSI escapes
      // that chalk would otherwise wrap stderr in.
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? -1,
  };
}

describe('sweech accounts CRUD — JSON error envelope', () => {
  let homeDir: string;

  beforeAll(() => {
    // Skip the whole suite if the build artifact is missing — the CI/test
    // environment runs `npm test` after `npm run build`, but a developer
    // running jest directly may not have rebuilt. Soft-skip preserves
    // the green run instead of forcing a confusing failure.
    if (!fs.existsSync(CLI_PATH)) {
      // eslint-disable-next-line no-console
      console.warn(`[cli-accounts-crud-errors] dist/cli.js missing — run \`npm run build\` first. Skipping.`);
    }
  });

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-cli-crud-test-'));
    fs.mkdirSync(path.join(homeDir, '.sweech'), { recursive: true, mode: 0o700 });
    // Empty accounts.json — every test below targets an account that
    // doesn't exist or relies on the resolver's not-found branch.
    fs.writeFileSync(
      path.join(homeDir, '.sweech', 'accounts.json'),
      JSON.stringify({ schemaVersion: 2, accounts: [] }),
    );
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  // Skip everything in this block when dist/cli.js isn't built.
  const maybe = fs.existsSync(CLI_PATH) ? test : test.skip;

  maybe('hide --json on missing account emits {ok:false, error} + exit 1', () => {
    const { stdout, code } = runCli(
      ['accounts', 'hide', '--email', 'nope@nope.nope', '--json'],
      homeDir,
    );
    expect(code).toBe(1);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/not found/);
  });

  maybe('delete --json on missing account emits {ok:false, error} + exit 1', () => {
    const { stdout, code } = runCli(
      ['accounts', 'delete', '--email', 'gone@nope.nope', '--json'],
      homeDir,
    );
    expect(code).toBe(1);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/not found/);
  });

  maybe('missing --email exits 1 with clear error', () => {
    // Note: the CLI prints to stderr and exits before any JSON envelope
    // is constructed for this branch — that's the documented behaviour
    // (the JSON envelope path only kicks in once a target is resolved).
    const { stderr, code } = runCli(
      ['accounts', 'hide', '--json'],
      homeDir,
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/--email.+required/);
  });

  maybe('logout --json on missing account emits {ok:false, error} + exit 1', () => {
    const { stdout, code } = runCli(
      ['accounts', 'logout', '--email', 'phantom@nope.nope', '--json'],
      homeDir,
    );
    expect(code).toBe(1);
    const envelope = parseEnvelope(stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/not found/);
  });
});
