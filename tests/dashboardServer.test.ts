import http from 'node:http';
import net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDashboardRequestHandler } from '../src/dashboardServer';

const mockList = jest.fn();
const mockById = jest.fn();
const mockClose = jest.fn();
const mockSummarizeNow = jest.fn();
const mockSummarizerClose = jest.fn();
const mockLaunchTerminal = jest.fn();
const mockGetProfiles = jest.fn();
const mockListWorkspaces = jest.fn();
const mockEditWorkspace = jest.fn();
const mockGetKnownAccounts = jest.fn();
const mockGetAccountInfo = jest.fn();
const mockBuildCostTable = jest.fn();
const mockAuditProfiles = jest.fn();
const mockFixCliTypeOnProfile = jest.fn();
const mockFixProviderOnProfile = jest.fn();
const mockGetActiveCooldowns = jest.fn();
const mockClearCooldown = jest.fn();
const mockFindProjectPin = jest.fn();
const mockWriteProjectPin = jest.fn();
const mockRemoveProjectPin = jest.fn();
const mockRecommendRoute = jest.fn();
const mockReadBillingFile = jest.fn();
const mockProbeDaemonHealthz = jest.fn();
const mockListPlugins = jest.fn();
const mockInstallPlugin = jest.fn();
const mockUninstallPlugin = jest.fn();
const mockGetAllTemplates = jest.fn();
const mockLoadCustomTemplates = jest.fn();
const mockSaveCustomTemplate = jest.fn();
const mockDeleteCustomTemplate = jest.fn();

jest.mock('../src/sessionsDb', () => ({
  SessionsDb: jest.fn().mockImplementation(() => ({
    list: mockList,
    byId: mockById,
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

jest.mock('../src/terminalLauncher', () => ({
  launchTerminal: (...args: unknown[]) => mockLaunchTerminal(...args),
}));

jest.mock('../src/config', () => ({
  ConfigManager: jest.fn().mockImplementation(() => ({
    getProfiles: mockGetProfiles,
    getProfileDir: (commandName: string) => `/profiles/${commandName}`,
    getLogsDir: () => '/tmp/sweech-dashboard-test-logs',
  })),
}));

jest.mock('../src/workspaceCrud', () => ({
  listWorkspaces: (...args: unknown[]) => mockListWorkspaces(...args),
  editWorkspace: (...args: unknown[]) => mockEditWorkspace(...args),
}));

jest.mock('../src/subscriptions', () => ({
  getKnownAccounts: (...args: unknown[]) => mockGetKnownAccounts(...args),
  getAccountInfo: (...args: unknown[]) => mockGetAccountInfo(...args),
}));

jest.mock('../src/costCommand', () => ({
  buildCostTable: (...args: unknown[]) => mockBuildCostTable(...args),
}));

jest.mock('../src/profileAudit', () => ({
  auditProfiles: (...args: unknown[]) => mockAuditProfiles(...args),
  fixCliTypeOnProfile: (...args: unknown[]) => mockFixCliTypeOnProfile(...args),
  fixProviderOnProfile: (...args: unknown[]) => mockFixProviderOnProfile(...args),
}));

jest.mock('../src/failover', () => ({
  peekActiveCooldowns: (...args: unknown[]) => mockGetActiveCooldowns(...args),
  clearCooldown: (...args: unknown[]) => mockClearCooldown(...args),
}));

jest.mock('../src/projectConfig', () => ({
  findProjectPin: (...args: unknown[]) => mockFindProjectPin(...args),
  writeProjectPin: (...args: unknown[]) => mockWriteProjectPin(...args),
  removeProjectPin: (...args: unknown[]) => mockRemoveProjectPin(...args),
}));

jest.mock('../src/accountSelector', () => ({
  recommendRoute: (...args: unknown[]) => mockRecommendRoute(...args),
}));

jest.mock('../src/billing', () => {
  const actual = jest.requireActual('../src/billing');
  return {
    ...actual,
    readBillingFile: (...args: unknown[]) => mockReadBillingFile(...args),
  };
});

jest.mock('../src/daemonHealthz', () => ({
  probeDaemonHealthz: (...args: unknown[]) => mockProbeDaemonHealthz(...args),
}));

jest.mock('../src/plugins', () => ({
  installPlugin: (...args: unknown[]) => mockInstallPlugin(...args),
  listPlugins: (...args: unknown[]) => mockListPlugins(...args),
  uninstallPlugin: (...args: unknown[]) => mockUninstallPlugin(...args),
}));

jest.mock('../src/templates', () => ({
  BUILT_IN_TEMPLATES: [{ name: 'claude-pro' }],
  getAllTemplates: (...args: unknown[]) => mockGetAllTemplates(...args),
  loadCustomTemplates: (...args: unknown[]) => mockLoadCustomTemplates(...args),
  saveCustomTemplate: (...args: unknown[]) => mockSaveCustomTemplate(...args),
  deleteCustomTemplate: (...args: unknown[]) => mockDeleteCustomTemplate(...args),
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
    const session = {
      id: 's1',
      workspace: 'sweech',
      cwd: '/repo/sweech',
      cwdBasename: 'sweech',
      machine: os.hostname(),
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
    };
    mockList.mockReturnValue([
      {
        ...session,
      },
    ]);
    mockById.mockReturnValue(session);
    mockLaunchTerminal.mockResolvedValue({ ok: true, command: 'open', args: ['ghostty://run?...'] });
    mockGetProfiles.mockReturnValue([{ name: 'Sweech Main', commandName: 'sweech', cliType: 'claude', provider: 'anthropic', model: 'claude-sonnet-4-5' }]);
    mockEditWorkspace.mockReturnValue({
      commandName: 'sweech',
      model: 'claude-opus-4-5',
      baseUrl: 'https://api.example.test',
      apiKey: 'sk-test-should-not-leak',
      oauth: { accessToken: 'secret-token' },
      envOverrides: { ANTHROPIC_AUTH_TOKEN: 'secret-env' },
    });
    mockListWorkspaces.mockReturnValue([{
      commandName: 'sweech',
      cliType: 'claude',
      provider: 'anthropic',
      disabled: false,
      hidden: false,
      profileDir: '/profiles/sweech',
      profileDirExists: true,
    }]);
    mockGetKnownAccounts.mockReturnValue([{ name: 'Sweech Main', commandName: 'sweech', cliType: 'claude', provider: 'anthropic' }]);
    mockGetAccountInfo.mockResolvedValue([{
      name: 'Sweech Main',
      commandName: 'sweech',
      cliType: 'claude',
      provider: 'anthropic',
      meta: { plan: 'Max 5x' },
      messages5h: 12,
      messages7d: 88,
      lastActive: '2026-05-21T09:30:00.000Z',
      hoursUntilWeeklyReset: 24,
      tokenStatus: 'valid',
      live: { capturedAt: Date.UTC(2026, 4, 21, 9, 30), buckets: [{ session: { utilization: 0.24 }, weekly: { utilization: 0.44 } }] },
    }]);
    mockBuildCostTable.mockResolvedValue({
      generatedAt: '2026-05-21T09:30:00.000Z',
      rows: [{
        profile: 'sweech',
        cliType: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        spent7dUsd: 1.25,
        estCostPerCallUsd: 0.0375,
        lastUseTs: Date.UTC(2026, 4, 21, 9, 30),
      }, {
        profile: 'codex',
        cliType: 'codex',
        provider: 'openai',
        model: 'gpt-5-mini',
        spent7dUsd: 0.5,
        estCostPerCallUsd: 0.009,
        lastUseTs: Date.UTC(2026, 4, 20, 9, 30),
      }],
    });
    mockAuditProfiles.mockResolvedValue({
      generatedAt: '2026-05-21T09:30:00.000Z',
      scanned: 2,
      summary: { total_issues: 2 },
      findings: [{
        profile: 'codex-wrong',
        cliType: 'codex',
        provider: 'openai',
        severity: 'warn',
        kind: 'provider_misconfig',
        detail: 'Codex profile routes to http://user:secret@127.0.0.1:9058/v1?api_key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890.',
        evidence: { expectedProvider: 'ollama' },
        suggestion: 'fix_provider',
      }, {
        profile: 'claude-wrong',
        cliType: 'codex',
        provider: 'anthropic',
        severity: 'critical',
        kind: 'cli_type_mismatch',
        detail: 'Wrapper will exec the wrong CLI binary.',
        evidence: { expectedCliType: 'claude' },
        suggestion: 'fix_cli_type',
      }],
    });
    mockFixCliTypeOnProfile.mockReturnValue({ changed: true, from: 'codex', to: 'claude' });
    mockFixProviderOnProfile.mockReturnValue({ changed: true, from: 'openai', to: 'ollama' });
    mockGetActiveCooldowns.mockReturnValue([{
      commandName: 'claude-pro',
      reason: 'limit_reached',
      recordedAt: Date.UTC(2026, 4, 21, 9, 0),
      expiresAt: Date.now() + 15 * 60_000,
    }]);
    mockClearCooldown.mockReturnValue(true);
    mockFindProjectPin.mockReturnValue({
      source: '/repo/sweech/.sweech.json',
      projectRoot: '/repo/sweech',
      pin: { profile: 'sweech', cliType: 'claude', maxTier: 'max' },
    });
    mockWriteProjectPin.mockReturnValue('/Users/luke/dev/onlytools/sweech/.sweech.json');
    mockRemoveProjectPin.mockReturnValue(true);
    mockRecommendRoute.mockResolvedValue({
      generatedAt: '2026-05-21T09:30:00.000Z',
      selected: {
        account: { commandName: 'sweech' },
        route: {
          commandName: 'sweech',
          cliType: 'claude',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          health: { status: 'healthy' },
          launch: { status: 'available' },
          quota: { status: 'ok' },
        },
        score: 98.24,
        reasons: [],
      },
      rejected: [{ account: { commandName: 'codex' } }],
      candidates: [{
        account: { commandName: 'sweech' },
        route: {
          commandName: 'sweech',
          cliType: 'claude',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          health: { status: 'healthy' },
          launch: { status: 'available' },
          quota: { status: 'ok' },
        },
        score: 98.24,
        reasons: [],
      }],
      pinApplied: {
        source: '/repo/sweech/.sweech.json',
        projectRoot: '/repo/sweech',
        pin: { profile: 'sweech', cliType: 'claude', maxTier: 'max' },
      },
    });
    mockReadBillingFile.mockReturnValue({
      schemaVersion: 'sweech.billing.v1',
      entries: {
        'anthropic:luke@example.com': {
          vendor: 'anthropic',
          email: 'luke@example.com',
          billingDay: 21,
          updatedAt: '2026-05-20T12:00:00.000Z',
        },
      },
    });
    mockProbeDaemonHealthz.mockResolvedValue({ status: 'ok', message: 'ready (v0.4.0, uptime 12s)', version: '0.4.0', uptime: 12, state: 'ready' });
    mockListPlugins.mockReturnValue([
      { name: 'sweech-plugin-export', version: '1.2.3', enabled: true },
      { name: 'sweech-plugin-disabled', version: '0.1.0', enabled: false },
    ]);
    mockInstallPlugin.mockResolvedValue(undefined);
    mockUninstallPlugin.mockResolvedValue(undefined);
    mockGetAllTemplates.mockReturnValue([
      { name: 'claude-pro', description: 'Claude Pro', cliType: 'claude', provider: 'anthropic', tags: ['claude'] },
      { name: 'local-fast', description: 'Local Fast', cliType: 'codex', provider: 'ollama', model: 'llama3', baseUrl: 'http://127.0.0.1:11434', tags: ['local'] },
    ]);
    mockLoadCustomTemplates.mockReturnValue([
      { name: 'local-fast', description: 'Local Fast', cliType: 'codex', provider: 'ollama', model: 'llama3', baseUrl: 'http://127.0.0.1:11434', tags: ['local'] },
    ]);
    mockDeleteCustomTemplate.mockReturnValue(true);
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
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: path.startsWith('/dashboard/') ? { Origin: `http://127.0.0.1:${port}` } : {} }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  function requestWithBody(path: string, method: string, body: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Origin: `http://127.0.0.1:${port}`,
          'Content-Type': 'application/json',
        },
      }, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: responseBody, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  test('serves dashboard state from the sessions database', async () => {
    const res = await request('/dashboard/state');
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(body.machine).toEqual(expect.any(String));
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ id: 's1', status: 'live', workspace: 'sweech' });
    expect(body.workspaces[0]).toMatchObject({ commandName: 'sweech', name: 'Sweech Main', provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(body.workspaces[0].lastUsed).toBe('2026-05-21T09:30:00.000Z');
    expect(body.workspaces[0].profileDir).toBeUndefined();
    expect(body.accounts[0]).toMatchObject({ commandName: 'sweech', plan: 'Max 5x', tokenStatus: 'valid', messages5h: 12, messages7d: 88, utilization5h: 0.24 });
    expect(body.cost).toMatchObject({ spent7dUsd: 1.75, estCostPerCallUsd: 0.009 });
    expect(body.cost.providers[0]).toMatchObject({ provider: 'anthropic', profiles: 1 });
    expect(body.cost.rows).toBeUndefined();
    expect(body.federation).toMatchObject({ enabled: true, peers: [] });
    expect(body.settings).toMatchObject({ terminal: { preferred: 'auto' }, tmux: { enabled: true } });
    expect(body.audit).toMatchObject({ scanned: 2, totalIssues: 2, fixable: 2 });
    expect(body.audit.findings[0]).toMatchObject({ profile: 'codex-wrong', fixAction: 'fix_provider', expectedProvider: 'ollama' });
    expect(body.audit.findings[0].detail).toContain('[REDACTED]');
    expect(body.audit.findings[0].detail).not.toContain('secret');
    expect(body.audit.findings[0].detail).not.toContain('sk-proj');
    expect(body.audit.findings[0].evidence).toBeUndefined();
    expect(body.failover.cooldowns[0]).toMatchObject({ commandName: 'claude-pro', reason: 'limit_reached' });
    expect(body.routing).toMatchObject({ searchRoot: process.cwd(), rejectedCount: 1, pin: { profile: 'sweech', cliType: 'claude' } });
    expect(body.routing.pins[0]).toMatchObject({ workspace: 'sweech', cwd: '/repo/sweech', pinned: true, profile: 'sweech' });
    expect(body.routing.selected).toMatchObject({ commandName: 'sweech', launchStatus: 'available' });
    expect(body.billing.entries[0]).toMatchObject({ vendor: 'anthropic', email: 'lu***@example.com', billingDay: 21 });
    expect(body.billing.days).toHaveLength(30);
    expect(body.doctor).toMatchObject({ status: 'ok', checks: expect.arrayContaining([expect.objectContaining({ name: 'Daemon health', status: 'ok' })]) });
    expect(body.logs).toMatchObject({ lines: [] });
    expect(body.plugins).toMatchObject({ total: 2, enabled: 1 });
    expect(body.templates).toMatchObject({ total: 2, custom: 1 });
    expect(body.templates.templates[0]).toMatchObject({ name: 'local-fast', builtIn: false });
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockGetAccountInfo).toHaveBeenCalledWith(expect.any(Array), { liveCacheOnly: true, timeoutMs: 500 });
    expect(mockRecommendRoute).toHaveBeenCalledWith({}, expect.any(Array), expect.objectContaining({
      source: '/repo/sweech/.sweech.json',
    }), { logPinAudit: false });
  });

  test('serves federation peers from the dashboard peer provider', async () => {
    const handler = createDashboardRequestHandler({
      assetsDir: tmp,
      catchAllAssets: true,
      peerProvider: () => [{
        hostname: 'studio-mini',
        url: 'http://studio-mini.local:7043',
        lastSeen: Date.UTC(2026, 4, 21, 9, 30),
        capabilities: ['dashboard', 'dashboard-v1'],
        status: 'online',
        sessionCount: 3,
      }],
    });
    const peerServer = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve, reject) => peerServer.listen(0, '127.0.0.1', () => resolve()).on('error', reject));
    const address = peerServer.address();
    if (!address || typeof address === 'string') throw new Error('peer server did not expose a port');
    const peerPort = address.port;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: peerPort, path: '/dashboard/federation', headers: { Origin: `http://127.0.0.1:${peerPort}` } }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }).on('error', reject);
    });
    await new Promise<void>((resolve) => peerServer.close(() => resolve()));

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).peers[0]).toMatchObject({ hostname: 'studio-mini', status: 'online', sessionCount: 3, capabilities: ['dashboard', 'dashboard-v1'] });
  });

  test('settings route returns defaults and persists partial patches in the sidecar file', async () => {
    const settingsFile = path.join(tmp, 'dashboard-settings.json');
    const handler = createDashboardRequestHandler({ assetsDir: tmp, catchAllAssets: true, settingsPath: settingsFile });
    const settingsServer = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve, reject) => settingsServer.listen(0, '127.0.0.1', () => resolve()).on('error', reject));
    const address = settingsServer.address();
    if (!address || typeof address === 'string') throw new Error('settings server did not expose a port');
    const settingsPort = address.port;
    const send = (method: string, body?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: settingsPort,
        path: '/dashboard/settings',
        method,
        headers: { Origin: `http://127.0.0.1:${settingsPort}`, 'Content-Type': 'application/json' },
      }, (response) => {
        let responseBody = '';
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
      });
      req.on('error', reject);
      req.end(body ?? '');
    });

    const initial = await send('GET');
    const patched = await send('PATCH', JSON.stringify({ terminal: { preferred: 'kitty' }, tmux: { enabled: false }, refresh: { sessionsMs: 1500 } }));
    const invalid = await send('PATCH', JSON.stringify({ terminal: { preferred: 'bad-terminal' } }));
    await new Promise<void>((resolve) => settingsServer.close(() => resolve()));

    expect(initial.status).toBe(200);
    expect(JSON.parse(initial.body)).toMatchObject({ terminal: { preferred: 'auto' } });
    expect(patched.status).toBe(200);
    expect(JSON.parse(patched.body)).toMatchObject({ terminal: { preferred: 'kitty' }, tmux: { enabled: false }, refresh: { sessionsMs: 1500 } });
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))).toMatchObject({ terminal: { preferred: 'kitty' } });
    expect(invalid.status).toBe(400);
  });

  test('dashboard account utilization prefers the All models bucket', async () => {
    mockGetAccountInfo.mockResolvedValueOnce([{
      name: 'Codex',
      commandName: 'codex',
      cliType: 'codex',
      provider: 'openai',
      meta: {},
      messages5h: 0,
      messages7d: 0,
      tokenStatus: undefined,
      live: {
        capturedAt: Date.UTC(2026, 4, 21, 9, 30),
        buckets: [
          { label: 'GPT-5.3-Codex-Spark', session: { utilization: 0 }, weekly: { utilization: 0 } },
          { label: 'All models', session: { utilization: 0.34 }, weekly: { utilization: 0.44 } },
        ],
      },
    }]);

    const res = await request('/dashboard/state');
    const body = JSON.parse(res.body);

    expect(res.status).toBe(200);
    expect(body.accounts[0]).toMatchObject({ commandName: 'codex', utilization5h: 0.34, utilization7d: 0.44 });
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

  test('POST /dashboard/sessions/:id/restore opens terminal attach command', async () => {
    const res = await requestWithBody('/dashboard/sessions/s1/restore', 'POST', '{}');
    const body = JSON.parse(res.body);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockById).toHaveBeenCalledWith('s1');
    expect(mockLaunchTerminal).toHaveBeenCalledWith({
      terminal: 'ghostty',
      command: ['tmux', 'attach', '-t', 'sweech-s1'],
      cwd: '/repo/sweech',
      title: 'sweech sweech',
    });
  });

  test('PATCH /dashboard/workspaces/:name edits workspace settings', async () => {
    const res = await requestWithBody('/dashboard/workspaces/sweech', 'PATCH', JSON.stringify({
      model: 'claude-opus-4-5',
      baseUrl: 'https://api.example.test',
    }));
    const body = JSON.parse(res.body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, profile: { commandName: 'sweech', model: 'claude-opus-4-5' } });
    expect(body.profile.apiKey).toBeUndefined();
    expect(body.profile.oauth).toBeUndefined();
    expect(body.profile.envOverrides).toBeUndefined();
    expect(mockEditWorkspace).toHaveBeenCalledWith('sweech', {
      model: 'claude-opus-4-5',
      baseUrl: 'https://api.example.test',
    });
  });

  test('PATCH /dashboard/workspaces/:name preserves blank strings to clear overrides', async () => {
    const res = await requestWithBody('/dashboard/workspaces/sweech', 'PATCH', JSON.stringify({
      model: '',
      baseUrl: '',
      smallFastModel: '',
    }));

    expect(res.status).toBe(200);
    expect(mockEditWorkspace).toHaveBeenCalledWith('sweech', {
      model: '',
      baseUrl: '',
      smallFastModel: '',
    });
  });

  test('POST /dashboard/audit/fix revalidates finding and applies provider fix', async () => {
    const res = await requestWithBody('/dashboard/audit/fix', 'POST', JSON.stringify({
      profile: 'codex-wrong',
      action: 'fix_provider',
    }));
    const body = JSON.parse(res.body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, action: 'fix_provider', profile: 'codex-wrong' });
    expect(mockFixProviderOnProfile).toHaveBeenCalledWith(expect.anything(), 'codex-wrong', 'ollama');
  });

  test('POST /dashboard/audit/fix rejects stale or unsupported findings', async () => {
    const stale = await requestWithBody('/dashboard/audit/fix', 'POST', JSON.stringify({
      profile: 'missing',
      action: 'fix_provider',
    }));
    const unsupported = await requestWithBody('/dashboard/audit/fix', 'POST', JSON.stringify({
      profile: 'codex-wrong',
      action: 'delete_everything',
    }));

    expect(stale.status).toBe(422);
    expect(JSON.parse(stale.body)).toMatchObject({ ok: false, reason: 'matching-finding-not-found' });
    expect(unsupported.status).toBe(400);
  });

  test('POST /dashboard/audit/fix reports no-op fixer results as not ok', async () => {
    mockFixCliTypeOnProfile.mockReturnValueOnce({ changed: false, reason: 'disk-conflict' });

    const res = await requestWithBody('/dashboard/audit/fix', 'POST', JSON.stringify({
      profile: 'claude-wrong',
      action: 'fix_cli_type',
    }));

    expect(res.status).toBe(422);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, reason: 'disk-conflict' });
  });

  test('DELETE /dashboard/failover/cooldowns/:name clears cooldowns', async () => {
    const res = await request('/dashboard/failover/cooldowns/claude-pro', 'DELETE');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, commandName: 'claude-pro' });
    expect(mockClearCooldown).toHaveBeenCalledWith('claude-pro');
  });

  test('POST /dashboard/routing/pin writes a project pin from the dashboard', async () => {
    const res = await requestWithBody('/dashboard/routing/pin', 'POST', JSON.stringify({
      profile: 'codex',
      cliType: 'codex',
      model: 'gpt-5-mini',
      cwd: '/repo/sweech',
    }));
    const body = JSON.parse(res.body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, pin: { profile: 'codex', cliType: 'codex', model: 'gpt-5-mini' } });
    expect(mockWriteProjectPin).toHaveBeenCalledWith('/repo/sweech', { profile: 'codex', cliType: 'codex', model: 'gpt-5-mini' });
  });

  test('DELETE /dashboard/routing/pin removes the active project pin root', async () => {
    const res = await request('/dashboard/routing/pin', 'DELETE');
    const body = JSON.parse(res.body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, source: '/repo/sweech/.sweech.json', projectRoot: '/repo/sweech' });
    expect(mockRemoveProjectPin).toHaveBeenCalledWith('/repo/sweech');
  });

  test('GET /dashboard/doctor returns hybrid structural and network checks', async () => {
    mockListWorkspaces.mockReturnValueOnce([{
      commandName: 'missing',
      cliType: 'claude',
      provider: 'anthropic',
      disabled: true,
      hidden: false,
      profileDir: '/profiles/missing',
      profileDirExists: false,
    }]);
    mockProbeDaemonHealthz.mockResolvedValueOnce({ status: 'unreachable', message: 'daemon not running on port 8765' });

    const res = await request('/dashboard/doctor');
    const body = JSON.parse(res.body);

    expect(res.status).toBe(200);
    expect(body.status).toBe('warn');
    expect(body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Workspace directories', status: 'warn', category: 'structural' }),
      expect.objectContaining({ name: 'Daemon health', status: 'warn', category: 'network' }),
    ]));
    expect(body.nextNetworkRefreshAt).toEqual(expect.any(String));
  });

  test('dashboard template routes save and delete custom templates', async () => {
    const create = await requestWithBody('/dashboard/templates', 'POST', JSON.stringify({
      name: 'local-new',
      description: 'Local fast model',
      cliType: 'codex',
      provider: 'ollama',
      model: 'llama3',
      tags: ['local', 'fast'],
    }));
    const remove = await request('/dashboard/templates/local-fast', 'DELETE');

    expect(create.status).toBe(200);
    expect(JSON.parse(create.body)).toMatchObject({ ok: true, template: { name: 'local-new', builtIn: false } });
    expect(mockSaveCustomTemplate).toHaveBeenCalledWith(expect.objectContaining({ name: 'local-new', cliType: 'codex', provider: 'ollama' }));
    expect(remove.status).toBe(200);
    expect(JSON.parse(remove.body)).toMatchObject({ ok: true, name: 'local-fast' });
    expect(mockDeleteCustomTemplate).toHaveBeenCalledWith('local-fast');
  });

  test('dashboard plugin routes install and remove npm packages', async () => {
    const install = await requestWithBody('/dashboard/plugins', 'POST', JSON.stringify({ package: '@vykeai/sweech-plugin-test' }));
    const remove = await request('/dashboard/plugins/%40vykeai%2Fsweech-plugin-test', 'DELETE');

    expect(install.status).toBe(200);
    expect(JSON.parse(install.body)).toMatchObject({ total: 2, enabled: 1 });
    expect(mockInstallPlugin).toHaveBeenCalledWith('@vykeai/sweech-plugin-test');
    expect(remove.status).toBe(200);
    expect(mockUninstallPlugin).toHaveBeenCalledWith('@vykeai/sweech-plugin-test');
  });

  test('dashboard plugin install validates package names', async () => {
    const res = await requestWithBody('/dashboard/plugins', 'POST', JSON.stringify({ package: 'https://example.test/plugin.tgz' }));

    expect(res.status).toBe(400);
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  test('dashboard plugin install only accepts sweech plugin packages', async () => {
    const res = await requestWithBody('/dashboard/plugins', 'POST', JSON.stringify({ package: 'left-pad' }));

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Only sweech plugin packages');
    expect(mockInstallPlugin).not.toHaveBeenCalled();
  });

  test('dashboard template create rejects accidental overwrites', async () => {
    const res = await requestWithBody('/dashboard/templates', 'POST', JSON.stringify({
      name: 'local-fast',
      cliType: 'codex',
      provider: 'ollama',
    }));

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Template already exists', name: 'local-fast' });
    expect(mockSaveCustomTemplate).not.toHaveBeenCalled();
  });

  test('dashboard template create validates required fields', async () => {
    const res = await requestWithBody('/dashboard/templates', 'POST', JSON.stringify({ name: '../bad' }));

    expect(res.status).toBe(400);
    expect(mockSaveCustomTemplate).not.toHaveBeenCalled();
  });

  test('restore route rejects unsupported terminals', async () => {
    const res = await requestWithBody('/dashboard/sessions/s1/restore', 'POST', JSON.stringify({ terminal: 'not-a-terminal' }));

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('Unsupported terminal');
  });

  test('restore route rejects browser-unsafe missing origin requests', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/dashboard/sessions/s1/restore',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end('{}');
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain('localhost origin');
    expect(mockLaunchTerminal).not.toHaveBeenCalled();
  });

  test('mutating audit and cooldown routes reject missing browser origin', async () => {
    const fixCallsBefore = mockFixProviderOnProfile.mock.calls.length;
    const audit = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/dashboard/audit/fix',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ profile: 'codex-wrong', action: 'fix_provider' }));
    });
    const cooldown = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/dashboard/failover/cooldowns/claude-pro',
        method: 'DELETE',
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
    const routing = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/dashboard/routing/pin',
        method: 'DELETE',
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

    expect(audit.status).toBe(403);
    expect(cooldown.status).toBe(403);
    expect(routing.status).toBe(403);
    expect(mockFixProviderOnProfile).toHaveBeenCalledTimes(fixCallsBefore);
    expect(mockRemoveProjectPin).not.toHaveBeenCalled();
  });

  test('restore route rejects mismatched localhost origins', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/dashboard/sessions/s1/restore',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: 'http://localhost:9999',
          'Content-Type': 'application/json',
        },
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end('{}');
    });

    expect(res.status).toBe(403);
    expect(mockLaunchTerminal).not.toHaveBeenCalled();
  });

  test('dashboard mutating routes reject mismatched localhost origins', async () => {
    const routes = [
      { path: '/dashboard/audit/fix', method: 'POST', body: JSON.stringify({ profile: 'codex-wrong', action: 'fix_provider' }) },
      { path: '/dashboard/failover/cooldowns/claude-pro', method: 'DELETE', body: '' },
      { path: '/dashboard/plugins', method: 'POST', body: JSON.stringify({ package: 'sweech-plugin-test' }) },
      { path: '/dashboard/plugins/sweech-plugin-test', method: 'DELETE', body: '' },
      { path: '/dashboard/routing/pin', method: 'DELETE', body: '' },
      { path: '/dashboard/templates', method: 'POST', body: JSON.stringify({ name: 'local-new', cliType: 'codex', provider: 'ollama' }) },
      { path: '/dashboard/templates/local-fast', method: 'DELETE', body: '' },
      { path: '/dashboard/settings', method: 'PATCH', body: JSON.stringify({ terminal: { preferred: 'kitty' } }) },
    ];
    for (const route of routes) {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: route.path,
          method: route.method,
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: 'http://localhost:9999',
            'Content-Type': 'application/json',
          },
        }, (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end(route.body);
      });
      expect(res.status).toBe(403);
    }
  });

  test('restore route requires JSON content type and non-empty body', async () => {
    const wrongContent = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/dashboard/sessions/s1/restore',
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${port}` },
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end('');
    });
    const emptyJson = await requestWithBody('/dashboard/sessions/s1/restore', 'POST', '');

    expect(wrongContent.status).toBe(415);
    expect(emptyJson.status).toBe(400);
    expect(mockLaunchTerminal).not.toHaveBeenCalled();
  });

  test('restore route rejects closed sessions', async () => {
    const closed = { ...mockById(), status: 'closed' };
    mockById.mockReturnValueOnce(closed);

    const res = await requestWithBody('/dashboard/sessions/s1/restore', 'POST', '{}');

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain('Closed dashboard sessions');
    expect(mockLaunchTerminal).not.toHaveBeenCalled();
  });

  test('restore route rejects non-local sessions', async () => {
    const remote = { ...mockById(), machine: 'remote-mini' };
    mockById.mockReturnValueOnce(remote);

    const res = await requestWithBody('/dashboard/sessions/s1/restore', 'POST', '{}');

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain('Remote dashboard sessions');
    expect(mockLaunchTerminal).not.toHaveBeenCalled();
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
