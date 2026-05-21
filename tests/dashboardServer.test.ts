import http from 'node:http';
import net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDashboardRequestHandler } from '../src/dashboardServer';

const mockList = jest.fn();
const mockClose = jest.fn();
const mockSummarizeNow = jest.fn();
const mockSummarizerClose = jest.fn();

jest.mock('../src/sessionsDb', () => ({
  SessionsDb: jest.fn().mockImplementation(() => ({
    list: mockList,
    close: mockClose,
  })),
}));

jest.mock('../src/sessionSummarizer', () => ({
  SessionSummarizer: jest.fn().mockImplementation(() => ({
    summarizeNow: mockSummarizeNow,
    close: mockSummarizerClose,
  })),
}));

jest.mock('child_process', () => ({
  exec: jest.fn(),
}));

describe('dashboard server', () => {
  let server: http.Server;
  let port: number;
  let tmp: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-dashboard-server-'));
    fs.mkdirSync(path.join(tmp, 'assets'));
    fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>sweech dashboard</title><script src="/assets/app.js"></script>');
    fs.writeFileSync(path.join(tmp, 'assets', 'app.js'), 'window.__dashboard = true;');
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
    mockSummarizeNow.mockResolvedValue({
      sessionId: 's1',
      summaryOne: 'Dashboard route summary.',
      summaryBullets: ['Read viewport trigger'],
      summaryProvider: 'ollama',
      summaryModel: 'llama3',
      summaryCostUsd: 0,
      summaryAt: 123,
      summaryMsgAt: 50,
    });
    server = http.createServer((req, res) => {
      void createDashboardRequestHandler({ assetsDir: tmp, catchAllAssets: true })(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('server did not expose a TCP port'));
          return;
        }
        port = address.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  function request(path: string, method = 'GET'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: path.startsWith('/dashboard/') ? { Origin: 'http://127.0.0.1' } : {} }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
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

  test('POST /dashboard/sessions/:id/summary triggers viewport summarization', async () => {
    const res = await request('/dashboard/sessions/s1/summary', 'POST');
    const body = JSON.parse(res.body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      summary: {
        sessionId: 's1',
        summaryOne: 'Dashboard route summary.',
        summaryProvider: 'ollama',
      },
    });
    expect(mockSummarizeNow).toHaveBeenCalledWith('s1', 'viewport');
    expect(mockSummarizerClose).toHaveBeenCalled();
  });

  test('summary route returns accepted when session is not ready', async () => {
    mockSummarizeNow.mockResolvedValueOnce(null);

    const res = await request('/dashboard/sessions/s1/summary', 'POST');

    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'skipped' });
  });

  test('opens an SSE stream for dashboard events', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/dashboard/events', headers: { Origin: 'http://127.0.0.1' } }, (res) => {
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

  test('serves the React dashboard shell at the root path', async () => {
    const res = await request('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('sweech dashboard');
  });
});
