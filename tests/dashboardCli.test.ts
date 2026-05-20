import * as cp from 'child_process';
import * as fs from 'fs';
import http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';

const CLI_PATH = path.join(__dirname, '..', 'dist', 'cli.js');

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-dashboard-cli-'));
  fs.mkdirSync(path.join(home, '.sweech'), { recursive: true });
  return home;
}

async function getFreePort(): Promise<number> {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type DashboardCliProcess = cp.ChildProcessByStdio<null, Readable, Readable>;

function spawnCli(args: string[], home: string): DashboardCliProcess {
  return cp.spawn('node', [CLI_PATH, ...args], {
    env: {
      ...process.env,
      HOME: home,
      SWEECH_HOME: home,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForOutput(
  child: DashboardCliProcess,
  pattern: RegExp,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${pattern}; stdout=${stdout}; stderr=${stderr}`));
    }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    const onData = () => {
      if (pattern.test(stdout) || pattern.test(stderr)) {
        cleanup();
        resolve({ stdout, stderr });
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`process exited before ${pattern}; code=${code}; signal=${signal}; stdout=${stdout}; stderr=${stderr}`));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

async function waitForExit(child: DashboardCliProcess, timeoutMs = 15000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for CLI exit; stdout=${stdout}; stderr=${stderr}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function stopChild(child: DashboardCliProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 3000)),
  ]);
}

describe('sweech dashboard CLI', () => {
  const homes: string[] = [];
  const children: DashboardCliProcess[] = [];

  beforeAll(() => {
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`dist/cli.js not found - run \`npm run build\` before dashboard CLI tests.`);
    }
  });

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopChild));
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  test('uses the configured fed dashboard port when --port is omitted', async () => {
    const home = makeHome();
    homes.push(home);
    const port = await getFreePort();
    fs.mkdirSync(path.join(home, '.fed'), { recursive: true });
    fs.writeFileSync(path.join(home, '.fed', 'config.json'), JSON.stringify({
      tools: { sweech: { dash: port } },
    }));

    const child = spawnCli(['dashboard', '--no-open'], home);
    children.push(child);

    const { stdout } = await waitForOutput(child, new RegExp(`sweech dashboard running at http://127\\.0\\.0\\.1:${port}/`));
    expect(stdout).toContain(`http://127.0.0.1:${port}/`);
  }, 20000);

  test('attaches only when the occupied port is an existing dashboard', async () => {
    const home = makeHome();
    homes.push(home);
    const port = await getFreePort();
    const server = spawnCli(['dashboard', '--port', String(port), '--no-open'], home);
    children.push(server);
    await waitForOutput(server, /sweech dashboard running at/);

    const attach = spawnCli(['dashboard', '--port', String(port), '--no-open'], home);
    const result = await waitForExit(attach);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`sweech dashboard already running at http://127.0.0.1:${port}/`);
  }, 20000);

  test('exits non-zero when the dashboard port is occupied by another service', async () => {
    const home = makeHome();
    homes.push(home);
    const port = await getFreePort();
    const otherServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not sweech');
    });
    await new Promise<void>((resolve) => otherServer.listen(port, '127.0.0.1', resolve));

    try {
      const child = spawnCli(['dashboard', '--port', String(port), '--no-open'], home);
      children.push(child);
      const result = await waitForExit(child);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`port ${port} is already in use by a non-dashboard service`);
    } finally {
      await new Promise<void>((resolve) => otherServer.close(() => resolve()));
    }
  }, 20000);
});
