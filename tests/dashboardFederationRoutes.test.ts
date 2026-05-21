import http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSweechFedServer, DashboardPeerCache, startDashboardPeerPolling } from '../src/fedServer';
import { signDaemonRequest } from '../src/daemonAuth';
import { SessionsDb } from '../src/sessionsDb';
import { launchTerminal } from '../src/terminalLauncher';

jest.mock('../src/config', () => ({
  ConfigManager: jest.fn().mockImplementation(() => ({
    getProfiles: jest.fn().mockReturnValue([
      { name: 'claude', commandName: 'claude', cliType: 'claude', provider: 'anthropic' },
    ]),
  })),
}));

jest.mock('../src/subscriptions', () => ({
  getKnownAccounts: jest.fn().mockReturnValue([
    { name: 'claude', commandName: 'claude', cliType: 'claude', configDir: '/mock/.claude' },
  ]),
  getAccountInfo: jest.fn().mockResolvedValue([
    {
      name: 'claude',
      commandName: 'claude',
      cliType: 'claude',
      meta: { plan: 'pro', limits: {} },
      messages5h: 2,
      messages7d: 7,
      hoursUntilWeeklyReset: 24,
      lastActive: '2026-05-21T10:00:00Z',
      live: { status: 'allowed' },
    },
  ]),
}));

jest.mock('../src/auditLog', () => ({
  readAuditLog: jest.fn().mockReturnValue([]),
}));

jest.mock('../src/terminalLauncher', () => ({
  launchTerminal: jest.fn().mockResolvedValue({ ok: true, command: 'open', args: ['ghostty://run?...'] }),
}));

const mockLaunchTerminal = jest.mocked(launchTerminal);

describe('/fed/dashboard federation routes', () => {
  let tmp: string;
  let secretPath: string;
  let secret: string;
  let servers: http.Server[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-fed-dashboard-routes-'));
    secret = 'test-secret-for-dashboard-federation';
    secretPath = path.join(tmp, 'daemon.secret');
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    servers = [];
    mockLaunchTerminal.mockClear();
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => close(server)));
    fs.rmSync(tmp, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  test('GET /fed/info advertises dashboard capability and TXT caps', async () => {
    const daemon = await listen(createSweechFedServer(0, { daemonSecretPath: secretPath }));

    const res = await request(daemon, 'GET', '/fed/info');

    expect(res.status).toBe(200);
    expect(res.body.caps).toBe('dashboard-v1');
    expect(res.body.txt).toEqual({ caps: 'dashboard-v1' });
    expect(res.body.capabilities).toEqual(expect.arrayContaining(['dashboard', 'dashboard-v1']));
  });

  test('GET /fed/dashboard/state requires HMAC and returns this peer snapshot', async () => {
    const dbPath = path.join(tmp, 'peer-a', '.sweech', 'sessions.db');
    seedSession(dbPath, 'a1', { workspace: 'claude-a', machine: 'peer-a' });
    const daemon = await listen(createSweechFedServer(0, { daemonSecretPath: secretPath, sessionsDbPath: dbPath }));

    const unsigned = await request(daemon, 'GET', '/fed/dashboard/state');
    const signed = await request(daemon, 'GET', '/fed/dashboard/state', undefined, authedHeaders('GET', '/fed/dashboard/state', ''));

    expect(unsigned.status).toBe(401);
    expect(signed.status).toBe(200);
    expect(signed.body.sessions).toHaveLength(1);
    expect(signed.body.sessions[0]).toMatchObject({ id: 'a1', workspace: 'claude-a', machine: 'peer-a' });
    expect(signed.body.accounts[0]).toMatchObject({ name: 'claude', slug: 'claude', messages5h: 2 });
    expect(signed.body.status).toMatchObject({ version: expect.any(String), accountCount: 1 });
  });

  test('two local daemons expose separate dashboard state databases', async () => {
    const dbA = path.join(tmp, 'daemon-a', '.sweech', 'sessions.db');
    const dbB = path.join(tmp, 'daemon-b', '.sweech', 'sessions.db');
    seedSession(dbA, 'a1', { workspace: 'claude-a', machine: 'daemon-a' });
    seedSession(dbB, 'b1', { workspace: 'claude-b', machine: 'daemon-b' });
    const daemonA = await listen(createSweechFedServer(0, { daemonSecretPath: secretPath, sessionsDbPath: dbA }));
    const daemonB = await listen(createSweechFedServer(0, { daemonSecretPath: secretPath, sessionsDbPath: dbB }));

    const stateA = await request(daemonA, 'GET', '/fed/dashboard/state', undefined, authedHeaders('GET', '/fed/dashboard/state', ''));
    const stateB = await request(daemonB, 'GET', '/fed/dashboard/state', undefined, authedHeaders('GET', '/fed/dashboard/state', ''));

    expect(stateA.body.sessions.map((session: { id: string }) => session.id)).toEqual(['a1']);
    expect(stateB.body.sessions.map((session: { id: string }) => session.id)).toEqual(['b1']);
  });

  test('POST /fed/dashboard/restore requires HMAC and invokes terminal restore path', async () => {
    const dbPath = path.join(tmp, 'restore', '.sweech', 'sessions.db');
    seedSession(dbPath, 'restore-1', { tmuxName: 'repo-claude-sweech', cwd: '/repo/project' });
    const daemon = await listen(createSweechFedServer(0, { daemonSecretPath: secretPath, sessionsDbPath: dbPath }));
    const body = JSON.stringify({ sessionId: 'restore-1', terminal: 'ghostty' });

    const unsigned = await request(daemon, 'POST', '/fed/dashboard/restore', body, { 'Content-Type': 'application/json' });
    const signed = await request(daemon, 'POST', '/fed/dashboard/restore', body, authedHeaders('POST', '/fed/dashboard/restore', body));

    expect(unsigned.status).toBe(401);
    expect(signed.status).toBe(200);
    expect(signed.body.ok).toBe(true);
    expect(mockLaunchTerminal).toHaveBeenCalledWith({
      terminal: 'ghostty',
      command: ['tmux', 'attach', '-t', 'repo-claude-sweech'],
      cwd: '/repo/project',
      title: 'sweech claude',
    });
  });

  test('POST /fed/dashboard/summary requires HMAC and writes summary fields', async () => {
    const dbPath = path.join(tmp, 'summary', '.sweech', 'sessions.db');
    seedSession(dbPath, 'summary-1', { messageCount: 10, summaryStale: true });
    const daemon = await listen(createSweechFedServer(0, { daemonSecretPath: secretPath, sessionsDbPath: dbPath }));
    const body = JSON.stringify({
      sessionId: 'summary-1',
      summaryOne: 'Implemented federation dashboard routes.',
      summaryBullets: ['added HMAC', 'wrote sqlite summary'],
      summaryProvider: 'peer-b',
      summaryModel: 'local-model',
      summaryCostUsd: 0.001,
      summaryAt: 1779360000000,
      summaryMsgAt: 10,
    });

    const signed = await request(daemon, 'POST', '/fed/dashboard/summary', body, authedHeaders('POST', '/fed/dashboard/summary', body));
    const db = new SessionsDb(dbPath);
    const session = db.byId('summary-1');
    db.close();

    expect(signed.status).toBe(200);
    expect(session).toMatchObject({
      summaryOne: 'Implemented federation dashboard routes.',
      summaryBullets: '["added HMAC","wrote sqlite summary"]',
      summaryProvider: 'peer-b',
      summaryModel: 'local-model',
      summaryCostUsd: 0.001,
      summaryAt: 1779360000000,
      summaryStale: false,
      summaryMsgAt: 10,
    });
  });

  test('peer cache polling records reachable dashboard peers', async () => {
    const dbPath = path.join(tmp, 'poll-peer', '.sweech', 'sessions.db');
    seedSession(dbPath, 'poll-1', { workspace: 'claude-peer' });
    const peerDaemon = await listen(createSweechFedServer(0, { daemonSecretPath: secretPath, sessionsDbPath: dbPath }));
    const cache = new DashboardPeerCache();

    const stop = startDashboardPeerPolling({
      cache,
      secretPath,
      intervalMs: 25,
      isDashboardOpen: () => true,
      peersProvider: () => [{ name: 'peer-one', host: '127.0.0.1', port: peerDaemon.port, secret }],
    });
    await waitFor(() => cache.list().some((peer) => peer.status === 'online' && peer.sessionCount === 1));
    stop();

    expect(cache.list()[0]).toMatchObject({
      status: 'online',
      sessionCount: 1,
      capabilities: expect.arrayContaining(['dashboard-v1']),
    });
  });

  function authedHeaders(method: string, requestPath: string, body: string): http.OutgoingHttpHeaders {
    return {
      ...signDaemonRequest(secret, method, requestPath, body, Date.now()),
      'Content-Type': 'application/json',
    };
  }

  function seedSession(dbPath: string, id: string, overrides: Partial<Parameters<SessionsDb['insert']>[0]> = {}): void {
    const db = new SessionsDb(dbPath);
    db.insert({
      id,
      workspace: 'claude',
      cwd: '/repo/project',
      machine: 'test-peer',
      launchedAt: 1000,
      lastActiveAt: 2000,
      status: 'live',
      ...overrides,
    });
    db.close();
  }

  async function listen(server: http.Server): Promise<{ server: http.Server; port: number }> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP port');
    return { server, port: address.port };
  }

  function request(
    daemon: { port: number },
    method: string,
    requestPath: string,
    body = '',
    headers: http.OutgoingHttpHeaders = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: daemon.port, path: requestPath, method, headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  function close(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 1000) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('condition was not met');
  }
});
