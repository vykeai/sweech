import http from 'node:http';
import net from 'node:net';
import { _generateHTML, startDashboard } from '../src/dashboard';

const mockList = jest.fn();
const mockClose = jest.fn();

jest.mock('../src/sessionsDb', () => ({
  SessionsDb: jest.fn().mockImplementation(() => ({
    list: mockList,
    close: mockClose,
  })),
}));

jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

describe('dashboard server', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    mockList.mockReturnValue([
      {
        id: 's1',
        workspace: 'sweech',
        cwd: '/repo/sweech',
        cwdBasename: 'sweech',
        machine: 'devbox',
        tmuxName: 'sweech-s1',
        claudeSid: null,
        jsonlPath: null,
        pid: 123,
        terminalApp: 'Ghostty',
        launchedAt: 1,
        lastActiveAt: 2,
        closedAt: null,
        status: 'live',
        messageCount: 4,
        msgCountFirst: 1,
        msgCountLast: 4,
        summaryOne: null,
        summaryBullets: null,
        summaryProvider: null,
        summaryModel: null,
        summaryCostUsd: null,
        summaryAt: null,
        summaryStale: false,
        summaryMsgAt: null,
      },
    ]);
    const started = await startDashboard({ port: 0, open: false });
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    jest.clearAllMocks();
  });

  function request(path: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }).on('error', reject);
    });
  }

  test('serves dashboard state from the sessions database', async () => {
    const res = await request('/dashboard/state');
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ id: 's1', status: 'live', workspace: 'sweech' });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test('serves sessions alias from the same state payload', async () => {
    const res = await request('/dashboard/sessions');
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.sessions[0].id).toBe('s1');
  });

  test('opens an SSE stream for dashboard events', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/dashboard/events' }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.includes('event: session.changed')) {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(body).toContain('"id":"s1"');
            req.destroy();
            resolve();
          }
        });
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') return;
        reject(error);
      });
      setTimeout(() => reject(new Error('timed out waiting for SSE connect')), 1000).unref();
    });
  });

  test('rejects malformed URL encoding without crashing', async () => {
    const res = await request('/%E0%A4%A');
    const body = JSON.parse(res.body);
    expect(res.status).toBe(400);
    expect(body.error).toBe('Bad path encoding');
  });

  test('rejects malformed absolute-form request targets without crashing', async () => {
    const statusLine = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET http://%zz/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let body = '';
      socket.on('data', (chunk) => { body += chunk; });
      socket.on('end', () => resolve(body.split('\r\n')[0]));
      socket.on('error', reject);
    });
    expect(statusLine).toBe('HTTP/1.1 400 Bad Request');
  });

  test('escapes legacy HTML dashboard status labels', () => {
    const html = _generateHTML({
      generatedAt: new Date().toISOString(),
      history: [],
      launchStats: [],
      accounts: [{
        name: 'bad',
        commandName: 'bad',
        cliType: 'claude',
        configDir: '/tmp/bad',
        meta: { plan: 'pro' },
        messages5h: 0,
        messages7d: 0,
        totalMessages: 0,
        live: { status: '<img src=x onerror=alert(1)>', capturedAt: Date.now(), buckets: [] },
      }],
    });
    expect(html).toContain('escapeHTML(bl)');
    expect(html).not.toContain('>' + '<img src=x onerror=alert(1)>' + '<');
  });
});
