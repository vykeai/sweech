const { test, expect } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let fixture;

test.beforeAll(async () => {
  process.env.PROJECT_SCREENSHOT_DIR = process.env.PROJECT_SCREENSHOT_DIR || path.join(os.homedir(), 'Desktop', 'screenshots', 'sweech');
  fs.mkdirSync(process.env.PROJECT_SCREENSHOT_DIR, { recursive: true });
  fixture = await startDashboardPanelsFixture();
});

test.afterAll(async () => {
  if (fixture) await fixture.close();
});

test('workspaces accounts and cost panels render real dashboard state', async ({ page }) => {
  const screenshotDir = process.env.PROJECT_SCREENSHOT_DIR;
  await page.setViewportSize({ width: 1440, height: 1100 });
  await setupDashboardPanelRoutes(page);
  await page.route('**/dashboard/audit/fix', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, action: 'fix_provider', profile: 'codex-wrong', result: { changed: true } }) });
  });
  await page.route('**/dashboard/failover/cooldowns/claude-pro', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, commandName: 'claude-pro' }) });
  });
  await page.route('**/dashboard/routing/pin', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, source: '/repo/sweech/.sweech.json', projectRoot: '/repo/sweech', pin: { profile: 'codex-pole', cliType: 'codex' } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, source: '/repo/sweech/.sweech.json', projectRoot: '/repo/sweech' }) });
  });
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('workspace-card-claude-main')).toBeVisible();
  await expect(page.getByTestId('workspace-status-claude-main')).toHaveText('Active');
  await expect(page.getByText('claude-shared')).toBeVisible();
  await expect(page.getByTestId('account-card-claude-pro')).toBeVisible();
  await expect(page.getByTestId('token-status-claude-pro')).toHaveText('Token ok');
  await expect(page.getByTestId('usage-bar-claude-pro-5h')).toContainText('42 5h');
  await expect(page.getByTestId('usage-bar-claude-pro-7d')).toContainText('320 7d');
  await expect(page.getByTestId('cost-sparkline-provider-mix')).toBeVisible();
  await expect(page.getByTestId('cost-provider-anthropic')).toContainText('$2.00');
  await expect(page.getByTestId('audit-finding-codex-wrong-provider_misconfig')).toBeVisible();
  await expect(page.getByTestId('audit-fix-codex-wrong-provider_misconfig')).toHaveText('Fix provider');
  await expect(page.getByTestId('cooldown-row-claude-pro')).toContainText('limit_reached');
  await expect(page.getByTestId('cooldown-clear-claude-pro')).toBeVisible();
  await expect(page.getByTestId('routing-pin-active')).toContainText('claude-main');
  await expect(page.getByTestId('routing-pin-map-repo-sweech')).toContainText('claude-main');
  await expect(page.getByTestId('routing-candidate-claude-main')).toBeVisible();
  await expect(page.getByTestId('routing-pin-set-codex-pole')).toBeVisible();
  await expect(page.getByTestId('routing-pin-unset')).toBeVisible();
  await expect(page.getByTestId('billing-calendar')).toBeVisible();
  await expect(page.getByTestId('billing-day-2026-05-21')).toBeVisible();
  await expect(page.getByTestId('billing-entry-anthropic-lu-example-com')).toContainText('today');
  await expect(page.getByTestId('doctor-check-daemon-health')).toContainText('ready');
  await expect(page.getByTestId('logs-tail')).toBeVisible();
  await expect(page.getByTestId('plugin-row-sweech-plugin-export')).toContainText('enabled');
  await expect(page.getByTestId('template-row-claude-pro')).toContainText('built-in');
  await expect(page.getByTestId('template-row-local-fast')).toContainText('custom');
  await expect(page.getByTestId('federation-peer-studio-mini')).toContainText('dashboard-v1');
  await expect(page.getByTestId('settings-summary-row')).toContainText('studio-main');
  await page.getByTestId('settings-open').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('General')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Summaries' })).toBeVisible();
  await page.getByLabel('Preferred terminal').selectOption('kitty');
  await page.screenshot({
    path: path.join(screenshotDir, 'T-DASH-014-settings-drawer-desktop.png'),
    fullPage: false,
  });
  const settingsPatchPromise = page.waitForRequest((request) => request.url().endsWith('/dashboard/settings') && request.method() === 'PATCH');
  await page.getByTestId('settings-save').click();
  const settingsPatch = await settingsPatchPromise;
  expect(JSON.parse(settingsPatch.postData())).toMatchObject({ terminal: { preferred: 'kitty' } });
  await page.getByTestId('workspace-card-claude-main').click();
  await expect(page.getByRole('dialog', { name: 'Edit claude-main' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Model', exact: true })).toHaveValue('claude-sonnet-4-5');
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await page.screenshot({
    path: path.join(screenshotDir, 'T-DASH-011-workspace-edit-dialog.png'),
    fullPage: false,
  });
  await page.getByLabel('Close workspace editor').click();

  const layout = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflow = Array.from(document.querySelectorAll('body *')).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.right > viewportWidth + 1 || rect.left < -1;
    });
    return {
      workspaceCards: document.querySelectorAll('.workspace-card').length,
      accountCards: document.querySelectorAll('.account-card').length,
      costBars: document.querySelectorAll('.cost-sparkline span').length,
      auditRows: document.querySelectorAll('.audit-row').length,
      cooldownRows: document.querySelectorAll('.cooldown-row').length,
      opsRows: document.querySelectorAll('.ops-row').length,
      logRows: document.querySelectorAll('.log-row').length,
      billingDays: document.querySelectorAll('.billing-day').length,
      overflowCount: overflow.length,
    };
  });
  expect(layout).toMatchObject({ workspaceCards: 2, accountCards: 2, costBars: 7, auditRows: 1, cooldownRows: 1, opsRows: 9, billingDays: 30, overflowCount: 0 });
  expect(layout.logRows).toBeGreaterThan(0);

  await page.getByTestId('workspace-card-claude-main').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(screenshotDir, 'T-DASH-013-doctor-logs-plugins-templates-desktop.png'),
    fullPage: true,
  });
  await page.getByTestId('audit-fix-codex-wrong-provider_misconfig').click();
  await expect(page.getByTestId('audit-finding-codex-wrong-provider_misconfig')).toHaveCount(0);
  await page.getByTestId('cooldown-clear-claude-pro').click();
  await expect(page.getByTestId('cooldown-row-claude-pro')).toHaveCount(0);
  const pinSetRequestPromise = page.waitForRequest((request) => request.url().endsWith('/dashboard/routing/pin') && request.method() === 'POST');
  await page.getByTestId('routing-pin-set-codex-pole').click();
  const pinSetRequest = await pinSetRequestPromise;
  expect(JSON.parse(pinSetRequest.postData())).toMatchObject({ profile: 'codex-pole', cliType: 'codex', cwd: '/repo/sweech' });
  const pinUnsetRequestPromise = page.waitForRequest((request) => request.url().endsWith('/dashboard/routing/pin') && request.method() === 'DELETE');
  await page.getByTestId('routing-pin-unset').click();
  await pinUnsetRequestPromise;
  const cloneRequestPromise = page.waitForRequest((request) => request.url().endsWith('/dashboard/templates') && request.method() === 'POST');
  await page.getByTestId('template-clone-claude-pro').click();
  const cloneRequest = await cloneRequestPromise;
  expect(JSON.parse(cloneRequest.postData())).toMatchObject({ name: 'claude-pro-custom', cliType: 'claude', provider: 'anthropic' });
});

test('dashboard data panels remain usable on mobile width', async ({ page }) => {
  const screenshotDir = process.env.PROJECT_SCREENSHOT_DIR;
  await page.setViewportSize({ width: 390, height: 1000 });
  await setupDashboardPanelRoutes(page);
  await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('workspace-card-claude-main').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('workspace-card-claude-main')).toBeVisible();
  await expect(page.getByTestId('account-card-claude-pro')).toBeVisible();
  await expect(page.getByTestId('cost-sparkline-provider-mix')).toBeVisible();
  await expect(page.getByTestId('audit-finding-codex-wrong-provider_misconfig')).toBeVisible();
  await expect(page.getByTestId('billing-calendar')).toBeVisible();
  await expect(page.getByTestId('doctor-check-daemon-health')).toBeVisible();
  await expect(page.getByTestId('logs-tail')).toBeVisible();
  await page.getByTestId('logs-event-filter').selectOption('audit.orphan_env_cleared');
  await expect(page.getByTestId('logs-tail')).toContainText('audit.orphan_env_cleared');
  await expect(page.getByTestId('logs-tail')).not.toContainText('dashboard.started');
  const pluginInstallRequestPromise = page.waitForRequest((request) => request.url().endsWith('/dashboard/plugins') && request.method() === 'POST');
  await page.getByTestId('plugin-package-input').fill('@vykeai/sweech-plugin-test');
  await page.getByTestId('plugin-install').click();
  const pluginInstallRequest = await pluginInstallRequestPromise;
  expect(JSON.parse(pluginInstallRequest.postData())).toMatchObject({ package: '@vykeai/sweech-plugin-test' });
  await expect(page.getByTestId('plugin-row-sweech-plugin-export')).toBeVisible();
  await expect(page.getByTestId('template-row-claude-pro')).toBeVisible();
  await expect(page.getByTestId('federation-peer-studio-mini')).toBeVisible();
  await page.getByTestId('settings-open').scrollIntoViewIfNeeded();
  await page.getByTestId('settings-open').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.screenshot({
    path: path.join(screenshotDir, 'T-DASH-014-settings-drawer-mobile.png'),
    fullPage: false,
  });
  await page.getByLabel('Close settings drawer').click();
  await page.getByTestId('setup-wizard-open').scrollIntoViewIfNeeded();
  await page.getByTestId('setup-wizard-open').click();
  await expect(page.getByRole('dialog', { name: 'Setup Wizard' })).toBeVisible();
  await page.getByTestId('setup-wizard-next').click();
  await expect(page.getByTestId('setup-step-provider')).toBeVisible();
  await page.getByTestId('setup-wizard-next').click();
  await expect(page.getByTestId('setup-step-workspace')).toBeVisible();
  await page.getByTestId('setup-wizard-next').click();
  await expect(page.getByTestId('setup-step-done')).toBeVisible();
  await page.screenshot({
    path: path.join(screenshotDir, 'T-DASH-014-setup-wizard-mobile.png'),
    fullPage: false,
  });
  await page.getByTestId('setup-wizard-finish').click();
  await page.getByLabel('Template name').fill('dashboard-custom');
  await page.getByLabel('Template description').fill('Dashboard custom template');
  await page.getByLabel('Template provider').fill('openrouter');
  const createTemplateRequestPromise = page.waitForRequest((request) => request.url().endsWith('/dashboard/templates') && request.method() === 'POST');
  await page.getByTestId('template-save').click();
  const createTemplateRequest = await createTemplateRequestPromise;
  expect(JSON.parse(createTemplateRequest.postData())).toMatchObject({ name: 'dashboard-custom', provider: 'openrouter', overwrite: false });
  await page.getByTestId('template-edit-local-fast').click();
  await page.getByLabel('Template provider').fill('ollama-local');
  const updateTemplateRequestPromise = page.waitForRequest((request) => request.url().endsWith('/dashboard/templates') && request.method() === 'POST');
  await page.getByTestId('template-save').click();
  const updateTemplateRequest = await updateTemplateRequestPromise;
  expect(JSON.parse(updateTemplateRequest.postData())).toMatchObject({ name: 'local-fast', provider: 'ollama-local', overwrite: true });

  const overflowCount = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll('body *')).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.right > viewportWidth + 1 || rect.left < -1;
    }).length;
  });
  expect(overflowCount).toBe(0);

  await page.screenshot({
    path: path.join(screenshotDir, 'T-DASH-013-doctor-logs-plugins-templates-mobile.png'),
    fullPage: true,
  });
});

async function startDashboardPanelsFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-dashboard-panels-'));
  const { createDashboardRequestHandler } = require('../../dist/dashboardServer');
  const handler = createDashboardRequestHandler({
    assetsDir: path.join(process.cwd(), 'dist/dashboard'),
    catchAllAssets: true,
    sessionsDbPath: path.join(tmpDir, 'sessions.sqlite'),
    stateProvider: async () => dashboardStateFixture(),
  });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not expose a port');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function setupDashboardPanelRoutes(page) {
  await page.route('**/dashboard/doctor', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardStateFixture().doctor) });
  });
  await page.route('**/dashboard/templates', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, template: dashboardStateFixture().templates.templates[2] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardStateFixture().templates) });
  });
  await page.route('**/dashboard/plugins', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardStateFixture().plugins) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardStateFixture().plugins) });
  });
  await page.route('**/dashboard/federation', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardStateFixture().federation) });
  });
  await page.route('**/dashboard/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      const patch = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...dashboardStateFixture().settings, ...patch, tmux: { ...dashboardStateFixture().settings.tmux, ...(patch.tmux || {}) }, terminal: { ...dashboardStateFixture().settings.terminal, ...(patch.terminal || {}) } }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dashboardStateFixture().settings) });
  });
}

function dashboardStateFixture() {
  const now = Date.UTC(2026, 4, 21, 12);
  return {
    generatedAt: new Date(now).toISOString(),
    machine: os.hostname(),
    sessions: [],
    workspaces: [
      {
        name: 'Claude Main',
        commandName: 'claude-main',
        cliType: 'claude',
        provider: 'anthropic',
        disabled: false,
        hidden: false,
        sharedWith: 'claude-shared',
        lastUsed: '2026-05-21T09:00:00.000Z',
        profileDirExists: true,
        model: 'claude-sonnet-4-5',
      },
      {
        name: 'Codex Pole',
        commandName: 'codex-pole',
        cliType: 'codex',
        provider: 'openai',
        disabled: true,
        hidden: false,
        sharedWith: null,
        lastUsed: null,
        profileDirExists: true,
        model: 'gpt-5',
      },
    ],
    accounts: [
      {
        name: 'Claude Pro',
        commandName: 'claude-pro',
        cliType: 'claude',
        provider: 'anthropic',
        plan: 'Max 20x',
        tokenStatus: 'valid',
        messages5h: 42,
        messages7d: 320,
        lastActive: '2026-05-21T11:50:00.000Z',
        freshnessAt: now,
        utilization5h: 0.42,
        utilization7d: 0.64,
        resetLabel: '18h',
      },
      {
        name: 'Codex Team',
        commandName: 'codex-team',
        cliType: 'codex',
        provider: 'openai',
        plan: 'Team',
        tokenStatus: 'managed',
        messages5h: 8,
        messages7d: 77,
        lastActive: '2026-05-21T10:00:00.000Z',
        freshnessAt: now - 45 * 60_000,
        utilization5h: 0.18,
        utilization7d: 0.22,
        resetLabel: '4h',
      },
    ],
    cost: {
      generatedAt: new Date(now).toISOString(),
      spent7dUsd: 2.5,
      estCostPerCallUsd: 0.05,
      sparkline: [4, 8, 13, 18, 22, 28, 32],
      providers: [
        { provider: 'anthropic', spent7dUsd: 2, estCostPerCallUsd: 0.04, profiles: 2 },
        { provider: 'openai', spent7dUsd: 0.5, estCostPerCallUsd: 0.01, profiles: 1 },
      ],
    },
    audit: {
      generatedAt: new Date(now).toISOString(),
      scanned: 2,
      totalIssues: 1,
      fixable: 1,
      findings: [{
        profile: 'codex-wrong',
        cliType: 'codex',
        provider: 'openai',
        severity: 'warn',
        kind: 'provider_misconfig',
        detail: 'Codex profile routes to a local backend but is still tagged as OpenAI.',
        fixAction: 'fix_provider',
        expectedProvider: 'ollama',
      }],
    },
    failover: {
      generatedAt: new Date(now).toISOString(),
      cooldowns: [{
        commandName: 'claude-pro',
        reason: 'limit_reached',
        recordedAt: '2026-05-21T11:30:00.000Z',
        expiresAt: '2026-05-21T12:45:00.000Z',
        minutesRemaining: 45,
      }],
    },
    routing: {
      generatedAt: new Date(now).toISOString(),
      searchRoot: '/repo/sweech',
      selected: {
        commandName: 'claude-main',
        cliType: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        status: 'healthy',
        score: 98.2,
        reasons: [],
        launchStatus: 'available',
        quotaStatus: 'allowed',
      },
      rejectedCount: 1,
      pin: {
        source: '/repo/sweech/.sweech.json',
        projectRoot: '/repo/sweech',
        profile: 'claude-main',
        cliType: 'claude',
        maxTier: 'max',
      },
      pins: [{
        workspace: 'claude-main',
        cwd: '/repo/sweech',
        cwdBasename: 'sweech',
        pinned: true,
        source: '/repo/sweech/.sweech.json',
        projectRoot: '/repo/sweech',
        profile: 'claude-main',
        cliType: 'claude',
        maxTier: 'max',
      }],
      candidates: [{
        commandName: 'claude-main',
        cliType: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        status: 'healthy',
        score: 98.2,
        reasons: [],
        launchStatus: 'available',
        quotaStatus: 'allowed',
      }, {
        commandName: 'codex-pole',
        cliType: 'codex',
        provider: 'openai',
        model: 'gpt-5',
        status: 'degraded',
        score: 41,
        reasons: ['not-selected:lower-score'],
        launchStatus: 'available',
        quotaStatus: 'allowed_warning',
      }],
    },
    billing: {
      generatedAt: new Date(now).toISOString(),
      days: Array.from({ length: 30 }, (_, index) => {
        const millis = Date.UTC(2026, 4, 21 + index);
        const date = new Date(millis).toISOString().slice(0, 10);
        return {
          date,
          count: date === '2026-05-21' ? 1 : 0,
          entries: [],
        };
      }),
      entries: [{
        vendor: 'anthropic',
        email: 'lu***@example.com',
        billingDay: 21,
        nextBillingAt: '2026-05-21',
        daysUntilNextBill: 0,
      }],
    },
    doctor: {
      generatedAt: new Date(now).toISOString(),
      status: 'ok',
      nextNetworkRefreshAt: new Date(now + 60_000).toISOString(),
      checks: [
        { name: 'Profiles', status: 'ok', detail: '2 configured', category: 'structural' },
        { name: 'Daemon health', status: 'ok', detail: 'ready (v0.4.0, uptime 12s)', category: 'network' },
      ],
    },
    logs: {
      generatedAt: new Date(now).toISOString(),
      file: '/Users/luke/.sweech/logs/lifecycle.jsonl',
      lines: [
        { index: 1, at: '2026-05-21T11:55:00.000Z', event: 'dashboard.started', profile: 'claude-main', message: 'dashboard.started: ready', severity: 'info' },
        { index: 2, at: '2026-05-21T11:56:00.000Z', event: 'audit.orphan_env_cleared', profile: 'codex-wrong', message: 'audit.orphan_env_cleared: ANTHROPIC_AUTH_TOKEN removed', severity: 'warn' },
      ],
    },
    plugins: {
      generatedAt: new Date(now).toISOString(),
      total: 2,
      enabled: 1,
      plugins: [
        { name: 'sweech-plugin-export', version: '1.2.3', enabled: true },
        { name: 'sweech-plugin-disabled', version: '0.1.0', enabled: false },
      ],
    },
    templates: {
      generatedAt: new Date(now).toISOString(),
      total: 3,
      custom: 1,
      templates: [
        { name: 'claude-pro', description: 'Claude with Pro subscription defaults', cliType: 'claude', provider: 'anthropic', tags: ['claude', 'pro'], builtIn: true },
        { name: 'codex-pro', description: 'Codex with ChatGPT Pro subscription', cliType: 'codex', provider: 'openai', tags: ['codex'], builtIn: true },
        { name: 'local-fast', description: 'Local fast model', cliType: 'codex', provider: 'ollama', model: 'llama3', baseUrl: 'http://127.0.0.1:11434', tags: ['local'], builtIn: false },
      ],
    },
    federation: {
      generatedAt: new Date(now).toISOString(),
      enabled: true,
      peers: [{
        hostname: 'studio-mini',
        url: 'http://studio-mini.local:7043',
        lastSeen: '2026-05-21T11:58:00.000Z',
        capabilities: ['dashboard', 'dashboard-v1'],
        status: 'online',
        sessionCount: 3,
      }],
    },
    settings: {
      generatedAt: new Date(now).toISOString(),
      general: { machine: 'studio-main' },
      tmux: { enabled: true, namingScheme: 'workspace-cwd', suffix: 'sweech' },
      terminal: { preferred: 'auto' },
      summaries: { enabled: true, providerOrder: ['anthropic', 'openai'], budgetPerSummaryUsd: 0.15, budgetPerDayUsd: 5, model: 'auto' },
      federation: { enabled: true, discoveryMethod: 'peers-file' },
      retention: { autoWipe: false, wipeOlderThanDays: 30 },
      refresh: { sessionsMs: 2000, peersMs: 30000, doctorNetworkMs: 60000 },
    },
  };
}
