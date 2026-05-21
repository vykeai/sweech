import http from 'node:http';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readBillingFile, nextBillingDate, daysUntilNextBill, type BillingEntry } from './billing';
import { ConfigManager } from './config';
import { buildCostTable, type CostTable } from './costCommand';
import { probeDaemonHealthz, type DaemonHealthzProbe } from './daemonHealthz';
import { clearCooldown, peekActiveCooldowns, type CooldownEntry } from './failover';
import { pickPrimaryBucket } from './liveUsage';
import { findProjectPin, removeProjectPin, writeProjectPin, type ProjectPin } from './projectConfig';
import { auditProfiles, fixCliTypeOnProfile, fixProviderOnProfile, type AuditFinding, type AuditReport } from './profileAudit';
import { installPlugin, listPlugins, uninstallPlugin, type PluginManifest } from './plugins';
import { recommendRoute, type RouteCandidate, type RouteRecommendationResponse } from './accountSelector';
import { scrubSecrets } from './scrubSecrets';
import { SessionsDb, type DashboardSession, type DashboardSessionStatus, type ListDashboardSessionsFilter } from './sessionsDb';
import { SessionSummarizer } from './sessionSummarizer';
import { getAccountInfo, getKnownAccounts, type AccountInfo } from './subscriptions';
import { BUILT_IN_TEMPLATES, deleteCustomTemplate, getAllTemplates, loadCustomTemplates, saveCustomTemplate, type ProfileTemplate } from './templates';
import { launchTerminal, type TerminalName } from './terminalLauncher';
import { editWorkspace, listWorkspaces, type WorkspaceEditOptions, type WorkspaceStatusRow } from './workspaceCrud';

export type DashboardEventName =
  | 'session.changed'
  | 'audit.flagged'
  | 'doctor.tick'
  | 'peer.online'
  | 'peer.offline'
  | 'cost.tick'
  | 'summary.updated'
  | 'log.appended';

const DASHBOARD_SESSION_STATUSES = new Set<DashboardSessionStatus>([
  'live',
  'tmux-detached',
  'crash-recoverable',
  'closed',
]);

export interface DashboardEvent<TPayload = unknown> {
  type: DashboardEventName;
  data: TPayload;
}

export interface DashboardState {
  generatedAt: string;
  machine: string;
  sessions: DashboardSession[];
  workspaces: DashboardWorkspace[];
  accounts: DashboardAccount[];
  cost: DashboardCostState;
  audit: DashboardAuditState;
  failover: DashboardFailoverState;
  routing: DashboardRoutingState;
  billing: DashboardBillingState;
  doctor: DashboardDoctorState;
  logs: DashboardLogsState;
  plugins: DashboardPluginsState;
  templates: DashboardTemplatesState;
}

export interface DashboardRequestHandlerOptions {
  assetsDir?: string;
  heartbeatMs?: number;
  sessionPollMs?: number;
  maxSseClients?: number;
  catchAllAssets?: boolean;
  sessionsDbPath?: string;
  terminalLauncher?: typeof launchTerminal;
  stateProvider?: () => Promise<DashboardState>;
}

export interface DashboardWorkspace extends Omit<WorkspaceStatusRow, 'profileDir'> {
  name: string;
  sharedWith?: string;
  lastUsed?: string | null;
  model?: string;
  baseUrl?: string;
  smallFastModel?: string;
}

export interface DashboardAccount {
  name: string;
  commandName: string;
  cliType: string;
  provider?: string;
  plan?: string;
  tokenStatus?: string;
  messages5h?: number | null;
  messages7d?: number | null;
  lastActive?: string;
  freshnessAt?: number | null;
  utilization5h?: number | null;
  utilization7d?: number | null;
  resetLabel?: string | null;
}

export interface DashboardCostState {
  generatedAt: string;
  spent7dUsd: number;
  estCostPerCallUsd: number;
  providers: Array<{ provider: string; spent7dUsd: number; estCostPerCallUsd: number; profiles: number }>;
  sparkline: number[];
}

export interface DashboardAuditState {
  generatedAt: string;
  scanned: number;
  totalIssues: number;
  fixable: number;
  findings: DashboardAuditFinding[];
}

export interface DashboardAuditFinding {
  profile: string;
  cliType: string;
  provider: string;
  severity: AuditFinding['severity'];
  kind: AuditFinding['kind'];
  detail: string;
  fixAction: 'fix_cli_type' | 'fix_provider' | 'clear_orphan_env' | null;
  expectedProvider?: string;
  orphanEnvKeys?: string[];
}

export interface DashboardFailoverState {
  generatedAt: string;
  cooldowns: DashboardCooldown[];
}

export interface DashboardCooldown {
  commandName: string;
  reason: string;
  recordedAt: string;
  expiresAt: string;
  minutesRemaining: number;
}

export interface DashboardRoutingState {
  generatedAt: string;
  searchRoot: string;
  selected: DashboardRouteCandidate | null;
  rejectedCount: number;
  pin: { source: string; projectRoot: string; profile?: string; cliType?: string; maxTier?: string; model?: string } | null;
  pins: DashboardProjectPinMapping[];
  candidates: DashboardRouteCandidate[];
}

export interface DashboardProjectPinMapping {
  workspace: string;
  cwd: string;
  cwdBasename?: string;
  pinned: boolean;
  source: string | null;
  projectRoot: string | null;
  profile?: string;
  cliType?: string;
  maxTier?: string;
  model?: string;
}

export interface DashboardRouteCandidate {
  commandName: string;
  cliType: string;
  provider: string;
  model: string | null;
  status: string;
  score: number;
  reasons: string[];
  launchStatus: string;
  quotaStatus: string | null;
}

export interface DashboardBillingState {
  generatedAt: string;
  days: Array<{ date: string; count: number; entries: DashboardBillingEntry[] }>;
  entries: DashboardBillingEntry[];
}

export interface DashboardBillingEntry {
  vendor: string;
  email: string;
  billingDay: number | null;
  nextBillingAt: string | null;
  daysUntilNextBill: number | null;
}

export interface DashboardDoctorState {
  generatedAt: string;
  status: 'ok' | 'warn' | 'error';
  checks: DashboardDoctorCheck[];
  nextNetworkRefreshAt: string;
}

export interface DashboardDoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  category: 'structural' | 'network';
}

export interface DashboardLogsState {
  generatedAt: string;
  file: string;
  lines: DashboardLogLine[];
}

export interface DashboardLogLine {
  index: number;
  at?: string;
  event?: string;
  profile?: string;
  message: string;
  severity: 'info' | 'warn' | 'error';
}

export interface DashboardPluginsState {
  generatedAt: string;
  total: number;
  enabled: number;
  plugins: DashboardPlugin[];
}

export interface DashboardPlugin {
  name: string;
  version: string;
  enabled: boolean;
}

export interface DashboardTemplatesState {
  generatedAt: string;
  total: number;
  custom: number;
  templates: DashboardTemplate[];
}

export interface DashboardTemplate extends ProfileTemplate {
  builtIn: boolean;
}

type DashboardEventListener = (event: DashboardEvent) => void;

const DASHBOARD_EVENT_NAMES = new Set<DashboardEventName>([
  'session.changed',
  'audit.flagged',
  'doctor.tick',
  'peer.online',
  'peer.offline',
  'cost.tick',
  'summary.updated',
  'log.appended',
]);

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_SESSION_POLL_MS = 2_000;
const DEFAULT_MAX_SSE_CLIENTS = 50;
const DASHBOARD_LOG_TAIL_BYTES = 128 * 1024;
let activeSseClients = 0;

class DashboardEventHub {
  private readonly emitter = new EventEmitter();

  publish<TPayload>(type: DashboardEventName, data: TPayload): void {
    this.emitter.emit('event', { type, data } satisfies DashboardEvent<TPayload>);
  }

  subscribe(listener: DashboardEventListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}

export const dashboardEventHub = new DashboardEventHub();

export function publishDashboardEvent<TPayload>(type: DashboardEventName, data: TPayload): void {
  dashboardEventHub.publish(type, data);
}

export function defaultDashboardAssetsDir(): string {
  return path.join(__dirname, 'dashboard');
}

export function isDashboardRequestPath(pathname: string): boolean {
  return pathname === '/'
    || pathname === '/dashboard'
    || pathname.startsWith('/dashboard/')
    || pathname === '/assets'
    || pathname.startsWith('/assets/');
}

export function isLocalDashboardClient(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}

export function hasActiveDashboardClients(): boolean {
  return activeSseClients > 0;
}

export function createDashboardRequestHandler(options: DashboardRequestHandlerOptions = {}) {
  const assetsDir = options.assetsDir ?? defaultDashboardAssetsDir();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const sessionPollMs = options.sessionPollMs ?? DEFAULT_SESSION_POLL_MS;
  const maxSseClients = options.maxSseClients ?? DEFAULT_MAX_SSE_CLIENTS;
  const catchAllAssets = options.catchAllAssets ?? false;

  return async function handleDashboardRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendDashboardJson(res, 400, { error: 'Bad request target' });
      return true;
    }

    if (!catchAllAssets && !isDashboardRequestPath(url.pathname)) return false;

    if (!isLocalDashboardClient(req.socket.remoteAddress)) {
      sendDashboardJson(res, 403, { error: 'Dashboard is only available from localhost' });
      return true;
    }
    if (!isLocalDashboardHost(req.headers.host) || !isAllowedDashboardOrigin(req.headers.host, req.headers.origin, req.headers['sec-fetch-site'], url.pathname)) {
      sendDashboardJson(res, 403, { error: 'Dashboard requests must use a localhost origin' });
      return true;
    }

    const summaryMatch = url.pathname.match(/^\/dashboard\/sessions\/([^/]+)\/summary$/);
    if (summaryMatch) {
      if (req.method !== 'POST') {
        sendDashboardJson(res, 405, { error: 'Method not allowed' });
        return true;
      }
      try {
        const summary = await summarizeDashboardSession(decodeURIComponent(summaryMatch[1]));
        if (!summary) {
          sendDashboardJson(res, 202, { status: 'skipped', reason: 'session not ready for summary' });
          return true;
        }
        sendDashboardJson(res, 200, { status: 'ok', summary });
      } catch (error) {
        sendDashboardJson(res, 500, {
          error: 'Dashboard summary unavailable',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    const restoreMatch = url.pathname.match(/^\/dashboard\/sessions\/([^/]+)\/restore$/);
    if (restoreMatch) {
      if (req.method !== 'POST') {
        sendDashboardJson(res, 405, { error: 'Method not allowed' });
        return true;
      }
      if (!isJsonRequest(req.headers['content-type'])) {
        sendDashboardJson(res, 415, { error: 'Content-Type must be application/json' });
        return true;
      }
      const body = await readDashboardBody(req, res);
      if (body === null) return true;
      if (!body.trim()) {
        sendDashboardJson(res, 400, { error: 'JSON body is required' });
        return true;
      }
      try {
        const payload = parseDashboardJsonObject(body);
        const result = await restoreLocalDashboardSession(
          decodeURIComponent(restoreMatch[1]),
          parseTerminalName(optionalString(payload.terminal)),
          options.terminalLauncher ?? launchTerminal,
          options.sessionsDbPath,
        );
        sendDashboardJson(res, result.ok ? 200 : 422, result);
      } catch (error) {
        if (error instanceof DashboardRequestError) {
          sendDashboardJson(res, error.status, { error: error.message });
          return true;
        }
        sendDashboardJson(res, 500, {
          error: 'Dashboard session restore failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    const workspaceEditMatch = url.pathname.match(/^\/dashboard\/workspaces\/([^/]+)$/);
    if (workspaceEditMatch) {
      if (req.method !== 'PATCH') {
        sendDashboardJson(res, 405, { error: 'Method not allowed' });
        return true;
      }
      if (!isJsonRequest(req.headers['content-type'])) {
        sendDashboardJson(res, 415, { error: 'Content-Type must be application/json' });
        return true;
      }
      const body = await readDashboardBody(req, res);
      if (body === null) return true;
      try {
        const payload = parseDashboardJsonObject(body);
        const profile = editWorkspaceFromDashboard(decodeURIComponent(workspaceEditMatch[1]), payload);
        sendDashboardJson(res, 200, { ok: true, profile: dashboardEditableWorkspace(profile) });
      } catch (error) {
        if (error instanceof DashboardRequestError) {
          sendDashboardJson(res, error.status, { error: error.message });
          return true;
        }
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    if (url.pathname === '/dashboard/audit/fix') {
      if (req.method !== 'POST') {
        sendDashboardJson(res, 405, { error: 'Method not allowed' });
        return true;
      }
      if (!isJsonRequest(req.headers['content-type'])) {
        sendDashboardJson(res, 415, { error: 'Content-Type must be application/json' });
        return true;
      }
      const body = await readDashboardBody(req, res);
      if (body === null) return true;
      try {
        const payload = parseDashboardJsonObject(body);
        const result = await fixDashboardAuditFinding(payload);
        sendDashboardJson(res, result.ok ? 200 : 422, result);
      } catch (error) {
        if (error instanceof DashboardRequestError) {
          sendDashboardJson(res, error.status, { error: error.message });
          return true;
        }
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    const cooldownClearMatch = url.pathname.match(/^\/dashboard\/failover\/cooldowns\/([^/]+)$/);
    if (cooldownClearMatch) {
      if (req.method !== 'DELETE') {
        sendDashboardJson(res, 405, { error: 'Method not allowed' });
        return true;
      }
      try {
        const commandName = decodeURIComponent(cooldownClearMatch[1]);
        const cleared = clearCooldown(commandName);
        sendDashboardJson(res, cleared ? 200 : 404, { ok: cleared, commandName });
      } catch (error) {
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    if (url.pathname === '/dashboard/routing/pin') {
      if (req.method === 'POST') {
        if (!isJsonRequest(req.headers['content-type'])) {
          sendDashboardJson(res, 415, { error: 'Content-Type must be application/json' });
          return true;
        }
        const body = await readDashboardBody(req, res);
        if (body === null) return true;
        try {
          const payload = parseDashboardJsonObject(body);
          sendDashboardJson(res, 200, pinDashboardRoute(payload));
        } catch (error) {
          if (error instanceof DashboardRequestError) {
            sendDashboardJson(res, error.status, { error: error.message });
            return true;
          }
          sendDashboardJson(res, 500, dashboardErrorBody(error));
        }
        return true;
      }
      if (req.method === 'DELETE') {
        try {
          sendDashboardJson(res, 200, unpinDashboardRoute());
        } catch (error) {
          if (error instanceof DashboardRequestError) {
            sendDashboardJson(res, error.status, { error: error.message });
            return true;
          }
          sendDashboardJson(res, 500, dashboardErrorBody(error));
        }
        return true;
      }
      sendDashboardJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    if (url.pathname === '/dashboard/templates' && req.method === 'POST') {
      if (!isJsonRequest(req.headers['content-type'])) {
        sendDashboardJson(res, 415, { error: 'Content-Type must be application/json' });
        return true;
      }
      const body = await readDashboardBody(req, res);
      if (body === null) return true;
      try {
        const payload = parseDashboardJsonObject(body);
        const template = dashboardTemplateFromPayload(payload);
        const exists = getAllTemplates().some((candidate) => candidate.name === template.name);
        if (exists && payload.overwrite !== true) {
          sendDashboardJson(res, 409, { error: 'Template already exists', name: template.name });
          return true;
        }
        saveCustomTemplate(template);
        sendDashboardJson(res, 200, { ok: true, template: dashboardTemplateFromTemplate(template, false) });
      } catch (error) {
        if (error instanceof DashboardRequestError) {
          sendDashboardJson(res, error.status, { error: error.message });
          return true;
        }
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    if (url.pathname === '/dashboard/plugins' && req.method === 'POST') {
      if (!isJsonRequest(req.headers['content-type'])) {
        sendDashboardJson(res, 415, { error: 'Content-Type must be application/json' });
        return true;
      }
      const body = await readDashboardBody(req, res);
      if (body === null) return true;
      try {
        const payload = parseDashboardJsonObject(body);
        const npmPackage = validateDashboardPackageName(payload.package);
        await installPlugin(npmPackage);
        sendDashboardJson(res, 200, collectDashboardPlugins());
      } catch (error) {
        if (error instanceof DashboardRequestError) {
          sendDashboardJson(res, error.status, { error: error.message });
          return true;
        }
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    const pluginDeleteMatch = url.pathname.match(/^\/dashboard\/plugins\/(.+)$/);
    if (pluginDeleteMatch) {
      if (req.method !== 'DELETE') {
        sendDashboardJson(res, 405, { error: 'Method not allowed' });
        return true;
      }
      try {
        const name = validateDashboardPackageName(decodeURIComponent(pluginDeleteMatch[1]));
        await uninstallPlugin(name);
        sendDashboardJson(res, 200, collectDashboardPlugins());
      } catch (error) {
        if (error instanceof DashboardRequestError) {
          sendDashboardJson(res, error.status, { error: error.message });
          return true;
        }
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    const templateDeleteMatch = url.pathname.match(/^\/dashboard\/templates\/([^/]+)$/);
    if (templateDeleteMatch) {
      if (req.method !== 'DELETE') {
        sendDashboardJson(res, 405, { error: 'Method not allowed' });
        return true;
      }
      try {
        const name = decodeURIComponent(templateDeleteMatch[1]);
        const removed = deleteCustomTemplate(name);
        sendDashboardJson(res, removed ? 200 : 404, { ok: removed, name, reason: removed ? undefined : 'custom-template-not-found' });
      } catch (error) {
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendDashboardJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    if (url.pathname === '/dashboard/state') {
      try {
        sendDashboardJson(res, 200, options.stateProvider ? await options.stateProvider() : await collectDashboardState(options.sessionsDbPath));
      } catch (error) {
        if (error instanceof DashboardRequestError) {
          sendDashboardJson(res, error.status, { error: error.message });
          return true;
        }
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    if (url.pathname === '/dashboard/sessions') {
      try {
        sendDashboardJson(res, 200, await collectDashboardSessions(url, options.sessionsDbPath));
      } catch (error) {
        if (error instanceof DashboardRequestError) {
          sendDashboardJson(res, error.status, { error: error.message });
          return true;
        }
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    if (url.pathname === '/dashboard/events') {
      sendDashboardEvents(req, res, { heartbeatMs, sessionPollMs, maxSseClients, sessionsDbPath: options.sessionsDbPath });
      return true;
    }

    if (url.pathname === '/dashboard/doctor') {
      try {
        sendDashboardJson(res, 200, await collectDashboardDoctorState());
      } catch (error) {
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    if (url.pathname === '/dashboard/logs') {
      try {
        sendDashboardJson(res, 200, collectDashboardLogs());
      } catch (error) {
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    if (url.pathname === '/dashboard/plugins') {
      try {
        sendDashboardJson(res, 200, collectDashboardPlugins());
      } catch (error) {
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    if (url.pathname === '/dashboard/templates') {
      try {
        sendDashboardJson(res, 200, collectDashboardTemplates());
      } catch (error) {
        sendDashboardJson(res, 500, dashboardErrorBody(error));
      }
      return true;
    }

    serveDashboardAsset(req, res, assetsDir, url.pathname);
    return true;
  };
}

export async function collectDashboardState(dbPath?: string): Promise<DashboardState> {
  const [sessionsState, auxiliaryState] = await Promise.all([
    collectDashboardSessions(undefined, dbPath),
    collectDashboardAuxiliaryState(),
  ]);
  return {
    ...sessionsState,
    ...auxiliaryState,
    routing: {
      ...auxiliaryState.routing,
      pins: collectDashboardProjectPins(sessionsState.sessions),
    },
  };
}

export async function summarizeDashboardSession(sessionId: string) {
  const summarizer = new SessionSummarizer();
  try {
    return await summarizer.summarizeNow(sessionId, 'viewport');
  } finally {
    summarizer.close();
  }
}

export async function collectDashboardSessions(url?: URL, dbPath?: string): Promise<DashboardState> {
  const db = new SessionsDb(dbPath);
  try {
    return {
      generatedAt: new Date().toISOString(),
      machine: os.hostname(),
      sessions: db.list(dashboardSessionsFilterFromUrl(url)),
      workspaces: [],
      accounts: [],
      cost: emptyDashboardCostState(),
      audit: emptyDashboardAuditState(),
      failover: emptyDashboardFailoverState(),
      routing: emptyDashboardRoutingState(),
      billing: emptyDashboardBillingState(),
      doctor: emptyDashboardDoctorState(),
      logs: emptyDashboardLogsState(),
      plugins: emptyDashboardPluginsState(),
      templates: emptyDashboardTemplatesState(),
    };
  } finally {
    db.close();
  }
}

async function collectDashboardAuxiliaryState(): Promise<Pick<DashboardState, 'workspaces' | 'accounts' | 'cost' | 'audit' | 'failover' | 'routing' | 'billing' | 'doctor' | 'logs' | 'plugins' | 'templates'>> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const accountRefs = getKnownAccounts(profiles, { includeInactive: true });
  const [accounts, costTable, auditReport, route, doctor] = await Promise.all([
    getAccountInfo(accountRefs, { liveCacheOnly: true, timeoutMs: 500 }).catch(() => [] as AccountInfo[]),
    buildCostTable().catch(() => null),
    auditProfiles({ config }).catch(() => null),
    collectDashboardRouting(profiles).catch(() => null),
    collectDashboardDoctorState(config).catch(() => emptyDashboardDoctorState()),
  ]);
  const lastUseByProfile = new Map<string, string>();
  for (const row of costTable?.rows ?? []) {
    if (row.lastUseTs) lastUseByProfile.set(row.profile, new Date(row.lastUseTs).toISOString());
  }
  const workspaces = listWorkspaces(config).map((workspace) => {
    const profile = profiles.find((candidate) => candidate.commandName === workspace.commandName);
    return {
      commandName: workspace.commandName,
      cliType: workspace.cliType,
      provider: workspace.provider,
      disabled: workspace.disabled,
      hidden: workspace.hidden,
      profileDirExists: workspace.profileDirExists,
      name: profile?.name ?? workspace.commandName,
      sharedWith: profile?.sharedWith,
      lastUsed: lastUseByProfile.get(workspace.commandName) ?? null,
      model: profile?.model,
      baseUrl: profile?.baseUrl,
      smallFastModel: profile?.smallFastModel,
    };
  });

  return {
    workspaces,
    accounts: accounts.map(dashboardAccountFromInfo),
    cost: dashboardCostFromTable(costTable),
    audit: dashboardAuditFromReport(auditReport),
    failover: dashboardFailoverFromCooldowns(peekActiveCooldowns()),
    routing: dashboardRoutingFromRecommendation(route),
    billing: dashboardBillingFromEntries(Object.values(readBillingFile().entries)),
    doctor,
    logs: collectDashboardLogs(config),
    plugins: collectDashboardPlugins(),
    templates: collectDashboardTemplates(),
  };
}

function dashboardAccountFromInfo(account: AccountInfo): DashboardAccount {
  const primaryBucket = pickPrimaryBucket(account.live);
  const session = primaryBucket?.session?.utilization;
  const weekly = primaryBucket?.weekly?.utilization;
  return {
    name: account.name,
    commandName: account.commandName,
    cliType: account.cliType,
    provider: account.provider,
    plan: account.meta.plan,
    tokenStatus: account.tokenStatus,
    messages5h: account.messages5h,
    messages7d: account.messages7d,
    lastActive: account.lastActive,
    freshnessAt: account.live?.capturedAt ?? account.tokenRefreshedAt ?? null,
    utilization5h: typeof session === 'number' ? session : null,
    utilization7d: typeof weekly === 'number' ? weekly : null,
    resetLabel: account.hoursUntilWeeklyReset === undefined ? null : `${Math.max(0, Math.round(account.hoursUntilWeeklyReset))}h`,
  };
}

function dashboardCostFromTable(table: CostTable | null): DashboardCostState {
  if (!table) return emptyDashboardCostState();
  const providers = new Map<string, { provider: string; spent7dUsd: number; estCostPerCallUsd: number; profiles: number }>();
  for (const row of table.rows) {
    const provider = row.provider || 'unknown';
    const slot = providers.get(provider) ?? { provider, spent7dUsd: 0, estCostPerCallUsd: 0, profiles: 0 };
    slot.spent7dUsd += row.spent7dUsd;
    slot.estCostPerCallUsd += row.estCostPerCallUsd ?? 0;
    slot.profiles += 1;
    providers.set(provider, slot);
  }
  const spent7dUsd = table.rows.reduce((sum, row) => sum + row.spent7dUsd, 0);
  const perCallEstimates = table.rows
    .map((row) => row.estCostPerCallUsd)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const estCostPerCallUsd = perCallEstimates.length > 0 ? Math.min(...perCallEstimates) : 0;
  return {
    generatedAt: table.generatedAt,
    spent7dUsd,
    estCostPerCallUsd,
    providers: [...providers.values()].sort((a, b) => b.spent7dUsd - a.spent7dUsd || b.estCostPerCallUsd - a.estCostPerCallUsd),
    sparkline: dashboardCostSparkline([...providers.values()].map((provider) => provider.spent7dUsd)),
  };
}

function emptyDashboardCostState(): DashboardCostState {
  return {
    generatedAt: new Date().toISOString(),
    spent7dUsd: 0,
    estCostPerCallUsd: 0,
    providers: [],
    sparkline: dashboardCostSparkline([]),
  };
}

function dashboardCostSparkline(values: number[]): number[] {
  const buckets = values.length > 0 ? values.slice(0, 7) : [0, 0, 0, 0, 0, 0, 0];
  while (buckets.length < 7) buckets.unshift(0);
  const max = Math.max(...buckets, 0.01);
  return buckets.map((value) => Math.max(4, Math.round((value / max) * 32)));
}

function dashboardAuditFromReport(report: AuditReport | null): DashboardAuditState {
  if (!report) return emptyDashboardAuditState();
  const findings = report.findings.map(dashboardAuditFindingFromFinding);
  return {
    generatedAt: report.generatedAt,
    scanned: report.scanned,
    totalIssues: report.summary.total_issues,
    fixable: findings.filter((finding) => finding.fixAction !== null).length,
    findings,
  };
}

function dashboardAuditFindingFromFinding(finding: AuditFinding): DashboardAuditFinding {
  const expectedProvider = typeof finding.evidence.expectedProvider === 'string'
    ? finding.evidence.expectedProvider
    : typeof finding.evidence.configuredProvider === 'string'
      ? undefined
      : undefined;
  const orphanEnvKeys = Array.isArray(finding.evidence.orphanProviderEnvs)
    ? finding.evidence.orphanProviderEnvs.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    profile: finding.profile,
    cliType: finding.cliType,
    provider: finding.provider,
    severity: finding.severity,
    kind: finding.kind,
    detail: redactDashboardText(finding.detail),
    fixAction: finding.suggestion === 'fix_cli_type'
      ? 'fix_cli_type'
      : finding.suggestion === 'fix_provider'
        ? 'fix_provider'
        : finding.kind === 'orphan_credentials' && orphanEnvKeys.length > 0
          ? 'clear_orphan_env'
          : null,
    expectedProvider: typeof finding.evidence.expectedProvider === 'string' ? finding.evidence.expectedProvider : expectedProvider,
    orphanEnvKeys,
  };
}

function emptyDashboardAuditState(): DashboardAuditState {
  return { generatedAt: new Date().toISOString(), scanned: 0, totalIssues: 0, fixable: 0, findings: [] };
}

function dashboardFailoverFromCooldowns(cooldowns: CooldownEntry[], now = Date.now()): DashboardFailoverState {
  return {
    generatedAt: new Date(now).toISOString(),
    cooldowns: cooldowns
      .map((entry) => ({
        commandName: entry.commandName,
        reason: entry.reason,
        recordedAt: new Date(entry.recordedAt).toISOString(),
        expiresAt: new Date(entry.expiresAt).toISOString(),
        minutesRemaining: Math.max(0, Math.ceil((entry.expiresAt - now) / 60_000)),
      }))
      .sort((a, b) => a.minutesRemaining - b.minutesRemaining || a.commandName.localeCompare(b.commandName)),
  };
}

function emptyDashboardFailoverState(): DashboardFailoverState {
  return { generatedAt: new Date().toISOString(), cooldowns: [] };
}

async function collectDashboardRouting(profiles: ReturnType<ConfigManager['getProfiles']>): Promise<RouteRecommendationResponse> {
  const pin = findProjectPin();
  return recommendRoute({}, profiles, pin, { logPinAudit: false });
}

function dashboardRoutingFromRecommendation(route: RouteRecommendationResponse | null): DashboardRoutingState {
  if (!route) return emptyDashboardRoutingState();
  const candidates = route.candidates.slice(0, 5).map(dashboardRouteCandidateFromCandidate);
  return {
    generatedAt: route.generatedAt,
    searchRoot: process.cwd(),
    selected: route.selected ? dashboardRouteCandidateFromCandidate(route.selected) : null,
    rejectedCount: route.rejected.length,
    pin: route.pinApplied ? {
      source: route.pinApplied.source,
      projectRoot: route.pinApplied.projectRoot,
      profile: route.pinApplied.pin.profile,
      cliType: route.pinApplied.pin.cliType,
      maxTier: route.pinApplied.pin.maxTier,
      model: route.pinApplied.pin.model,
    } : null,
    pins: [],
    candidates,
  };
}

function dashboardRouteCandidateFromCandidate(candidate: RouteCandidate): DashboardRouteCandidate {
  return {
    commandName: candidate.route.commandName,
    cliType: candidate.route.cliType,
    provider: candidate.route.provider,
    model: candidate.route.model,
    status: candidate.route.health.status,
    score: Number.isFinite(candidate.score) ? Math.round(candidate.score * 10) / 10 : 0,
    reasons: candidate.reasons.slice(0, 4),
    launchStatus: candidate.route.launch.status,
    quotaStatus: candidate.route.quota.status,
  };
}

function emptyDashboardRoutingState(): DashboardRoutingState {
  return { generatedAt: new Date().toISOString(), searchRoot: process.cwd(), selected: null, rejectedCount: 0, pin: null, pins: [], candidates: [] };
}

function collectDashboardProjectPins(sessions: DashboardSession[]): DashboardProjectPinMapping[] {
  const byCwd = new Map<string, Pick<DashboardSession, 'workspace' | 'cwd' | 'cwdBasename'>>();
  for (const session of sessions) {
    if (!session.cwd || byCwd.has(session.cwd)) continue;
    byCwd.set(session.cwd, session);
  }
  if (byCwd.size === 0) {
    const cwd = process.cwd();
    byCwd.set(cwd, { workspace: path.basename(cwd), cwd, cwdBasename: path.basename(cwd) });
  }
  return Array.from(byCwd.values())
    .sort((a, b) => a.workspace.localeCompare(b.workspace) || a.cwd.localeCompare(b.cwd))
    .slice(0, 12)
    .map((session) => {
      const resolved = findProjectPin(session.cwd);
      return {
        workspace: session.workspace,
        cwd: session.cwd,
        cwdBasename: session.cwdBasename,
        pinned: Boolean(resolved),
        source: resolved?.source ?? null,
        projectRoot: resolved?.projectRoot ?? null,
        profile: resolved?.pin.profile,
        cliType: resolved?.pin.cliType,
        maxTier: resolved?.pin.maxTier,
        model: resolved?.pin.model,
      };
    });
}

function dashboardBillingFromEntries(entries: BillingEntry[], now = Date.now()): DashboardBillingState {
  const mapped = entries
    .map((entry) => ({
      vendor: entry.vendor,
      email: maskEmail(entry.email),
      billingDay: entry.billingDay,
      nextBillingAt: nextBillingDate(entry, now),
      daysUntilNextBill: daysUntilNextBill(entry, now),
    }))
    .sort((a, b) => (a.daysUntilNextBill ?? 9999) - (b.daysUntilNextBill ?? 9999) || a.vendor.localeCompare(b.vendor));
  const start = startOfUtcDay(now);
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(start + index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dayEntries = mapped.filter((entry) => entry.nextBillingAt === date);
    return { date, count: dayEntries.length, entries: dayEntries };
  });
  return { generatedAt: new Date(now).toISOString(), days, entries: mapped };
}

function emptyDashboardBillingState(): DashboardBillingState {
  return dashboardBillingFromEntries([]);
}

async function collectDashboardDoctorState(config = new ConfigManager(), now = Date.now()): Promise<DashboardDoctorState> {
  const checks: DashboardDoctorCheck[] = [];
  const profiles = config.getProfiles();
  const workspaces = listWorkspaces(config);
  const missingDirs = workspaces.filter((workspace) => workspace.profileDirExists === false);
  const disabled = workspaces.filter((workspace) => workspace.disabled || workspace.hidden);

  checks.push({
    name: 'Profiles',
    status: profiles.length > 0 ? 'ok' : 'warn',
    detail: profiles.length > 0 ? `${profiles.length} configured` : 'No profiles configured',
    category: 'structural',
  });
  checks.push({
    name: 'Workspace directories',
    status: missingDirs.length > 0 ? 'warn' : 'ok',
    detail: missingDirs.length > 0 ? `${missingDirs.length} missing profile directories` : `${workspaces.length} checked`,
    category: 'structural',
  });
  checks.push({
    name: 'Inactive workspaces',
    status: disabled.length > 0 ? 'warn' : 'ok',
    detail: disabled.length > 0 ? `${disabled.length} disabled or hidden` : 'All visible workspaces active',
    category: 'structural',
  });

  const healthz = await probeDaemonHealthz({ timeoutMs: 1500 });
  checks.push(doctorCheckFromHealthz(healthz));

  const status = worstDashboardDoctorStatus(checks);
  return {
    generatedAt: new Date(now).toISOString(),
    status,
    checks,
    nextNetworkRefreshAt: new Date(now + 60_000).toISOString(),
  };
}

function doctorCheckFromHealthz(healthz: DaemonHealthzProbe): DashboardDoctorCheck {
  if (healthz.status === 'ok') {
    return { name: 'Daemon health', status: 'ok', detail: healthz.message, category: 'network' };
  }
  if (healthz.status === 'unreachable') {
    return { name: 'Daemon health', status: 'warn', detail: healthz.message, category: 'network' };
  }
  return { name: 'Daemon health', status: 'error', detail: healthz.message, category: 'network' };
}

function worstDashboardDoctorStatus(checks: DashboardDoctorCheck[]): DashboardDoctorState['status'] {
  if (checks.some((check) => check.status === 'error')) return 'error';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}

function emptyDashboardDoctorState(): DashboardDoctorState {
  return {
    generatedAt: new Date().toISOString(),
    status: 'ok',
    checks: [],
    nextNetworkRefreshAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function collectDashboardLogs(config = new ConfigManager(), limit = 40): DashboardLogsState {
  const file = path.join(dashboardLogsDir(config), 'lifecycle.jsonl');
  const { lines: rawLines, startIndex } = tailTextFile(file, limit);
  return {
    generatedAt: new Date().toISOString(),
    file,
    lines: rawLines.map((line, offset) => dashboardLogLineFromJsonl(line, startIndex + offset)),
  };
}

function emptyDashboardLogsState(): DashboardLogsState {
  return { generatedAt: new Date().toISOString(), file: path.join(os.homedir(), '.sweech', 'logs', 'lifecycle.jsonl'), lines: [] };
}

function dashboardLogsDir(config: ConfigManager): string {
  const maybeConfig = config as ConfigManager & { getLogsDir?: () => string };
  return typeof maybeConfig.getLogsDir === 'function'
    ? maybeConfig.getLogsDir()
    : path.join(os.homedir(), '.sweech', 'logs');
}

function tailTextFile(file: string, limit: number): { lines: string[]; startIndex: number } {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const start = Math.max(0, stat.size - DASHBOARD_LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const raw = buffer.toString('utf-8');
      const linesBeforeWindow = start === 0 ? 0 : countNewlinesBefore(file, start);
      const splitLines = raw.split(/\r?\n/);
      const completeLines = (start === 0 ? splitLines : splitLines.slice(1)).filter(Boolean);
      const completeStartIndex = start === 0 ? 0 : linesBeforeWindow + 1;
      const startIndex = Math.max(completeStartIndex, completeStartIndex + completeLines.length - limit);
      return { lines: completeLines.slice(-limit), startIndex };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], startIndex: 0 };
  }
}

function countNewlinesBefore(file: string, end: number): number {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const chunkSize = 64 * 1024;
      const buffer = Buffer.alloc(Math.min(chunkSize, end));
      let position = 0;
      let count = 0;
      while (position < end) {
        const length = Math.min(buffer.length, end - position);
        const read = fs.readSync(fd, buffer, 0, length, position);
        if (read <= 0) break;
        for (let index = 0; index < read; index += 1) {
          if (buffer[index] === 10) count += 1;
        }
        position += read;
      }
      return count;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

function validateDashboardPackageName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new DashboardRequestError(400, 'Package name is required');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 214) {
    throw new DashboardRequestError(400, 'Package name is invalid');
  }
  const scoped = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._~^*+-]+)?$/;
  const unscoped = /^[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._~^*+-]+)?$/;
  if (!scoped.test(trimmed) && !unscoped.test(trimmed)) {
    throw new DashboardRequestError(400, 'Package name is invalid');
  }
  const bareName = trimmed.startsWith('@')
    ? trimmed.replace(/@([^/]+\/[^@]+).*/, '@$1')
    : trimmed.replace(/@.+$/, '');
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?sweech-plugin-[a-z0-9._-]+$/.test(bareName)) {
    throw new DashboardRequestError(400, 'Only sweech plugin packages can be installed from the dashboard');
  }
  return trimmed;
}

function dashboardLogLineFromJsonl(line: string, index: number): DashboardLogLine {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const event = typeof parsed.event === 'string' ? parsed.event : undefined;
    const profile = typeof parsed.profile === 'string' ? parsed.profile : undefined;
    const at = typeof parsed.at === 'string'
      ? parsed.at
      : typeof parsed.timestamp === 'string'
        ? parsed.timestamp
        : typeof parsed.ts === 'string'
          ? parsed.ts
          : undefined;
    const severity = logSeverityFromEvent(event, parsed);
    return {
      index,
      at,
      event,
      profile,
      message: redactDashboardText(logMessageFromParsed(event, parsed)),
      severity,
    };
  } catch {
    return {
      index,
      message: redactDashboardText(line.slice(0, 500)),
      severity: 'info',
    };
  }
}

function logSeverityFromEvent(event: string | undefined, parsed: Record<string, unknown>): DashboardLogLine['severity'] {
  const severity = typeof parsed.severity === 'string' ? parsed.severity.toLowerCase() : '';
  const text = `${event ?? ''} ${typeof parsed.error === 'string' ? parsed.error : ''} ${typeof parsed.reason === 'string' ? parsed.reason : ''}`.toLowerCase();
  if (severity === 'error' || text.includes('error') || text.includes('failed')) return 'error';
  if (severity === 'warn' || text.includes('warn') || text.includes('missing') || text.includes('blocked')) return 'warn';
  return 'info';
}

function logMessageFromParsed(event: string | undefined, parsed: Record<string, unknown>): string {
  const preferred = ['message', 'reason', 'status', 'action']
    .map((key) => parsed[key])
    .find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  if (preferred) return event ? `${event}: ${preferred}` : preferred;
  return event ?? JSON.stringify(parsed);
}

function collectDashboardPlugins(manifest: PluginManifest = { plugins: listPlugins() }): DashboardPluginsState {
  const plugins = manifest.plugins
    .map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      enabled: Boolean(plugin.enabled),
    }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  return {
    generatedAt: new Date().toISOString(),
    total: plugins.length,
    enabled: plugins.filter((plugin) => plugin.enabled).length,
    plugins,
  };
}

function emptyDashboardPluginsState(): DashboardPluginsState {
  return { generatedAt: new Date().toISOString(), total: 0, enabled: 0, plugins: [] };
}

function collectDashboardTemplates(): DashboardTemplatesState {
  const builtInNames = new Set(BUILT_IN_TEMPLATES.map((template) => template.name));
  const customNames = new Set(loadCustomTemplates().map((template) => template.name));
  const templates = getAllTemplates()
    .map((template) => dashboardTemplateFromTemplate(template, builtInNames.has(template.name) && !customNames.has(template.name)))
    .sort((a, b) => Number(a.builtIn) - Number(b.builtIn) || a.name.localeCompare(b.name));
  return {
    generatedAt: new Date().toISOString(),
    total: templates.length,
    custom: templates.filter((template) => !template.builtIn).length,
    templates,
  };
}

function emptyDashboardTemplatesState(): DashboardTemplatesState {
  return { generatedAt: new Date().toISOString(), total: 0, custom: 0, templates: [] };
}

function dashboardTemplateFromTemplate(template: ProfileTemplate, builtIn: boolean): DashboardTemplate {
  return {
    name: template.name,
    description: template.description,
    cliType: template.cliType,
    provider: template.provider,
    model: template.model,
    baseUrl: template.baseUrl,
    tags: Array.isArray(template.tags) ? template.tags.slice(0, 12) : [],
    builtIn,
  };
}

function dashboardTemplateFromPayload(payload: Record<string, unknown>): ProfileTemplate {
  const name = optionalString(payload.name);
  const cliType = optionalString(payload.cliType);
  const provider = optionalString(payload.provider);
  if (!name) throw new DashboardRequestError(400, 'template name is required');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(name)) throw new DashboardRequestError(400, 'template name must be 2-64 URL-safe characters');
  if (!cliType) throw new DashboardRequestError(400, 'template cliType is required');
  if (!provider) throw new DashboardRequestError(400, 'template provider is required');
  return {
    name,
    description: optionalString(payload.description) ?? `Custom template: ${name}`,
    cliType,
    provider,
    model: optionalString(payload.model),
    baseUrl: optionalString(payload.baseUrl),
    tags: arrayOfStrings(payload.tags).slice(0, 12),
  };
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
}

function startOfUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function redactDashboardText(value: string): string {
  return scrubSecrets(value)
    .replace(/https?:\/\/([^/\s:@?#]+):([^@\s/?#]+)@/gi, 'https://[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|key|token|access_token|refresh_token|code|client_secret)=)[^&\s]+/gi, '$1[REDACTED]');
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${local.length > 2 ? '***' : '*'}@${domain}`;
}

function editWorkspaceFromDashboard(commandName: string, payload: Record<string, unknown>) {
  const patch: WorkspaceEditOptions = {};
  const model = editableString(payload.model);
  const baseUrl = editableString(payload.baseUrl);
  const smallFastModel = editableString(payload.smallFastModel);
  if (model !== undefined) patch.model = model;
  if (baseUrl !== undefined) patch.baseUrl = baseUrl;
  if (smallFastModel !== undefined) patch.smallFastModel = smallFastModel;

  if (payload.envOverrides !== undefined) {
    if (!payload.envOverrides || typeof payload.envOverrides !== 'object' || Array.isArray(payload.envOverrides)) {
      throw new DashboardRequestError(400, 'envOverrides must be an object');
    }
    const envOverrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload.envOverrides)) {
      const envKey = key.trim();
      if (!envKey || typeof value !== 'string') {
        throw new DashboardRequestError(400, 'envOverrides values must be strings');
      }
      envOverrides[envKey] = value;
    }
    if (Object.keys(envOverrides).length > 0) patch.envOverrides = envOverrides;
  }

  if (Object.keys(patch).length === 0) {
    throw new DashboardRequestError(400, 'At least one editable workspace field is required');
  }
  return editWorkspace(commandName, patch);
}

function editableString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function dashboardEditableWorkspace(profile: { commandName: string; model?: string; baseUrl?: string; smallFastModel?: string }): Pick<DashboardWorkspace, 'commandName' | 'model' | 'baseUrl' | 'smallFastModel'> {
  return {
    commandName: profile.commandName,
    model: profile.model,
    baseUrl: profile.baseUrl,
    smallFastModel: profile.smallFastModel,
  };
}

async function fixDashboardAuditFinding(payload: Record<string, unknown>): Promise<{ ok: boolean; action?: string; profile?: string; result?: unknown; reason?: string }> {
  const profile = optionalString(payload.profile);
  const action = optionalString(payload.action);
  if (!profile) throw new DashboardRequestError(400, 'profile is required');
  if (action !== 'fix_cli_type' && action !== 'fix_provider' && action !== 'clear_orphan_env') {
    throw new DashboardRequestError(400, 'unsupported audit fix action');
  }

  const config = new ConfigManager();
  const report = await auditProfiles({ config });
  const finding = report.findings
    .map(dashboardAuditFindingFromFinding)
    .find((candidate) => candidate.profile === profile && candidate.fixAction === action);
  if (!finding) return { ok: false, action, profile, reason: 'matching-finding-not-found' };

  if (action === 'fix_cli_type') {
    return dashboardFixResult(action, profile, fixCliTypeOnProfile(config, profile));
  }
  if (action === 'fix_provider') {
    const expectedProvider = finding.expectedProvider;
    if (!expectedProvider) return { ok: false, action, profile, reason: 'expected-provider-missing' };
    return dashboardFixResult(action, profile, fixProviderOnProfile(config, profile, expectedProvider));
  }
  return dashboardFixResult(action, profile, clearOrphanEnvForProfile(config, profile, finding.orphanEnvKeys ?? []));
}

function dashboardFixResult(action: string, profile: string, result: { changed?: boolean; reason?: string } & Record<string, unknown>) {
  return result.changed === false
    ? { ok: false, action, profile, reason: result.reason ?? 'not-changed', result }
    : { ok: true, action, profile, result };
}

function clearOrphanEnvForProfile(config: ConfigManager, commandName: string, envKeys: string[]): { changed: boolean; removed: string[]; reason?: string } {
  const allowedKeys = envKeys.map((key) => key.trim()).filter(Boolean);
  if (allowedKeys.length === 0) return { changed: false, removed: [], reason: 'no-env-keys' };
  const profiles = config.getProfiles();
  const target = profiles.find((profile) => profile.commandName === commandName);
  if (!target) return { changed: false, removed: [], reason: 'profile-not-found' };

  const removed = new Set<string>();
  const nextProfile = { ...target };
  if (nextProfile.envOverrides) {
    const nextEnv = { ...nextProfile.envOverrides };
    for (const key of allowedKeys) {
      if (key in nextEnv) {
        delete nextEnv[key];
        removed.add(key);
      }
    }
    if (Object.keys(nextEnv).length > 0) nextProfile.envOverrides = nextEnv;
    else delete nextProfile.envOverrides;
  }

  const settingsPath = path.join(config.getProfileDir(commandName), 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { env?: Record<string, unknown> } & Record<string, unknown>;
    if (settings.env && typeof settings.env === 'object') {
      const nextSettingsEnv = { ...settings.env };
      const settingsRemoved: string[] = [];
      for (const key of allowedKeys) {
        if (key in nextSettingsEnv) {
          delete nextSettingsEnv[key];
          settingsRemoved.push(key);
        }
      }
      if (settingsRemoved.length > 0) {
        settings.env = nextSettingsEnv;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
        for (const key of settingsRemoved) removed.add(key);
      }
    }
  } catch (error) {
    if (fs.existsSync(settingsPath)) {
      return { changed: false, removed: [], reason: `settings-write-failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    // Missing or malformed settings.json is already an audit finding; config
    // envOverrides cleanup can still succeed independently.
  }

  if (removed.size === 0) return { changed: false, removed: [], reason: 'env-keys-not-present' };
  config.writeProfiles(profiles.map((profile) => profile.commandName === commandName ? nextProfile : profile));
  config.logLifecycle({
    event: 'audit.orphan_env_cleared',
    profile: commandName,
    removed: Array.from(removed).sort(),
  });
  return { changed: true, removed: Array.from(removed).sort() };
}

function pinDashboardRoute(payload: Record<string, unknown>): { ok: true; source: string; projectRoot: string; pin: ProjectPin } {
  const pin: ProjectPin = {};
  const profile = optionalString(payload.profile);
  const cliType = optionalString(payload.cliType);
  const maxTier = optionalString(payload.maxTier);
  const model = optionalString(payload.model);
  const cwd = optionalString(payload.cwd) ?? process.cwd();
  if (profile) pin.profile = profile;
  if (cliType) {
    if (cliType !== 'claude' && cliType !== 'codex' && cliType !== 'kimi') throw new DashboardRequestError(400, 'cliType must be claude, codex, or kimi');
    pin.cliType = cliType;
  }
  if (maxTier) {
    if (maxTier !== 'free' && maxTier !== 'pro' && maxTier !== 'max' && maxTier !== 'team' && maxTier !== 'enterprise') {
      throw new DashboardRequestError(400, 'maxTier must be free, pro, max, team, or enterprise');
    }
    pin.maxTier = maxTier;
  }
  if (model) pin.model = model;
  if (Object.keys(pin).length === 0) throw new DashboardRequestError(400, 'At least one routing pin field is required');

  const source = writeProjectPin(cwd, pin);
  return { ok: true, source, projectRoot: path.dirname(source), pin };
}

function unpinDashboardRoute(): { ok: boolean; source: string; projectRoot: string; reason?: string } {
  const active = findProjectPin();
  const projectRoot = active?.projectRoot ?? process.cwd();
  const removed = removeProjectPin(projectRoot);
  return {
    ok: removed,
    source: path.join(projectRoot, '.sweech.json'),
    projectRoot,
    ...(removed ? {} : { reason: 'pin-not-found' }),
  };
}

async function restoreLocalDashboardSession(
  sessionId: string,
  requestedTerminal: TerminalName | undefined,
  terminalLauncher: typeof launchTerminal,
  dbPath?: string,
): Promise<{ ok: boolean; session: DashboardSession; launch?: unknown; reason?: string }> {
  const db = new SessionsDb(dbPath);
  try {
    const session = db.byId(sessionId);
    if (!session) throw new DashboardRequestError(404, 'Dashboard session not found');
    if (session.machine !== os.hostname()) throw new DashboardRequestError(409, 'Remote dashboard sessions must be restored through federation');
    if (session.status === 'closed') throw new DashboardRequestError(409, 'Closed dashboard sessions cannot be restored');
    const terminal = requestedTerminal ?? terminalFromSession(session) ?? 'ghostty';
    const command: [string, ...string[]] = session.tmuxName
      ? ['tmux', 'attach', '-t', session.tmuxName]
      : [session.workspace, '--continue'];
    const launch = await terminalLauncher({
      terminal,
      command,
      cwd: session.cwd,
      title: `sweech ${session.workspace}`,
    });
    return launch.ok
      ? { ok: true, session, launch }
      : { ok: false, session, reason: launch.reason, launch };
  } finally {
    db.close();
  }
}

function dashboardSessionsFilterFromUrl(url?: URL): ListDashboardSessionsFilter {
  const status = parseStatusFilter(url?.searchParams.get('status'));
  const limitParam = url?.searchParams.get('limit');
  const offsetParam = url?.searchParams.get('offset');
  return {
    machine: optionalParam(url?.searchParams.get('machine')),
    workspace: optionalParam(url?.searchParams.get('workspace')),
    q: optionalParam(url?.searchParams.get('q')),
    status,
    limit: limitParam ? parsePositiveInt(limitParam, 200) : 200,
    offset: offsetParam ? parsePositiveInt(offsetParam, 0) : 0,
  };
}

function parseStatusFilter(value: string | null | undefined): DashboardSessionStatus | DashboardSessionStatus[] | undefined {
  const statuses = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean) as DashboardSessionStatus[];
  if (statuses.length === 0) return undefined;
  const invalid = statuses.find((status) => !DASHBOARD_SESSION_STATUSES.has(status));
  if (invalid) throw new DashboardRequestError(400, `Invalid dashboard session status: ${invalid}`);
  return statuses.length === 1 ? statuses[0] : statuses;
}

function optionalParam(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function terminalFromSession(session: DashboardSession): TerminalName | undefined {
  const value = session.terminalApp?.trim().toLowerCase();
  if (!value) return undefined;
  if (value.includes('ghostty')) return 'ghostty';
  if (value.includes('iterm')) return 'iterm2';
  if (value.includes('terminal')) return 'terminal';
  if (value.includes('alacritty')) return 'alacritty';
  if (value.includes('kitty')) return 'kitty';
  if (value.includes('wezterm')) return 'wezterm';
  return undefined;
}

function parseTerminalName(value: string | undefined): TerminalName | undefined {
  if (!value) return undefined;
  if (value === 'ghostty' || value === 'iterm2' || value === 'terminal' || value === 'alacritty' || value === 'kitty' || value === 'wezterm') {
    return value;
  }
  throw new DashboardRequestError(400, `Unsupported terminal: ${value}`);
}

function isJsonRequest(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof value === 'string' && value.toLowerCase().split(';', 1)[0].trim() === 'application/json';
}

async function readDashboardBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 64 * 1024) {
      sendDashboardJson(res, 413, { error: 'Request body too large' });
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseDashboardJsonObject(body: string): Record<string, unknown> {
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DashboardRequestError(400, 'JSON body must be an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DashboardRequestError) throw error;
    throw new DashboardRequestError(400, 'Invalid JSON body');
  }
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

class DashboardRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendDashboardJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
  });
  res.end(JSON.stringify(body));
}

function dashboardErrorBody(error: unknown): { error: string; detail: string } {
  return {
    error: 'Dashboard state unavailable',
    detail: redactDashboardText(error instanceof Error ? error.message : String(error)),
  };
}

function sendDashboardEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { heartbeatMs: number; sessionPollMs: number; maxSseClients: number; sessionsDbPath?: string }
): void {
  if (req.method === 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  if (activeSseClients >= options.maxSseClients) {
    sendDashboardJson(res, 429, { error: 'Too many dashboard event streams' });
    return;
  }
  activeSseClients++;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  let since = 0;
  const emitSessions = () => {
    void emitSessionChanges(res, since, options.sessionsDbPath).then((latest) => {
      since = Math.max(since, latest);
    }).catch((error) => {
      writeDashboardComment(res, `dashboard state unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  emitSessions();
  let latestLogIndex = 0;
  const emitLogs = () => {
    try {
      const logs = collectDashboardLogs();
      const fresh = logs.lines.filter((line) => line.index >= latestLogIndex);
      if (logs.lines.length > 0) latestLogIndex = Math.max(...logs.lines.map((line) => line.index)) + 1;
      if (fresh.length > 0) {
        writeDashboardEvent(res, {
          type: 'log.appended',
          data: { lines: fresh, generatedAt: logs.generatedAt },
        });
      }
    } catch (error) {
      writeDashboardComment(res, `dashboard logs unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  emitLogs();

  const unsubscribe = dashboardEventHub.subscribe((event) => {
    writeDashboardEvent(res, event);
  });
  const sessionTimer = setInterval(emitSessions, options.sessionPollMs);
  const logTimer = setInterval(emitLogs, Math.max(options.sessionPollMs, 3000));
  const heartbeatTimer = setInterval(() => {
    safeWrite(res, `event: heartbeat\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  }, options.heartbeatMs);
  sessionTimer.unref();
  logTimer.unref();
  heartbeatTimer.unref();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(sessionTimer);
    clearInterval(logTimer);
    clearInterval(heartbeatTimer);
    unsubscribe();
    req.off('close', cleanup);
    res.off('error', cleanup);
    activeSseClients = Math.max(0, activeSseClients - 1);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

async function emitSessionChanges(res: http.ServerResponse, since: number, dbPath?: string): Promise<number> {
  let latest = since;
  const state = await collectDashboardSessions(undefined, dbPath);
  for (const session of state.sessions) {
    if (session.lastActiveAt <= since) continue;
    latest = Math.max(latest, session.lastActiveAt);
    writeDashboardEvent(res, {
      type: 'session.changed',
      data: { session },
    });
  }
  return latest;
}

function writeDashboardEvent(res: http.ServerResponse, event: DashboardEvent): void {
  if (!DASHBOARD_EVENT_NAMES.has(event.type)) return;
  const data = safeJson(event.data);
  if (!data) {
    writeDashboardComment(res, `dropped unserializable ${event.type} event`);
    return;
  }
  safeWrite(res, `event: ${event.type}\ndata: ${data}\n\n`);
}

function writeDashboardComment(res: http.ServerResponse, message: string): void {
  safeWrite(res, `: ${message.replace(/\r?\n/g, ' ')}\n\n`);
}

function safeWrite(res: http.ServerResponse, chunk: string): void {
  if (res.writableEnded || res.destroyed) return;
  if (!res.write(chunk)) res.destroy(new Error('dashboard SSE client backpressure limit reached'));
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function serveDashboardAsset(req: http.IncomingMessage, res: http.ServerResponse, assetsDir: string, pathname: string): void {
  let relative: string;
  try {
    if (pathname === '/dashboard' || pathname === '/dashboard/') {
      relative = 'index.html';
    } else if (pathname.startsWith('/dashboard/')) {
      relative = decodeURIComponent(pathname.slice('/dashboard/'.length));
    } else {
      relative = decodeURIComponent(pathname.replace(/^\/+/, ''));
    }
  } catch {
    sendDashboardJson(res, 400, { error: 'Bad path encoding' });
    return;
  }

  const root = path.resolve(assetsDir);
  const requestedPath = path.resolve(root, relative);
  const filePath = requestedPath === root || requestedPath.startsWith(root + path.sep)
    ? requestedPath
    : path.join(root, 'index.html');
  const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(root, 'index.html');
  const safeFinalPath = resolveSafeDashboardFile(root, finalPath);
  if (!safeFinalPath) {
    sendDashboardJson(res, 403, { error: 'Dashboard asset outside static root' });
    return;
  }

  fs.readFile(safeFinalPath, (error, data) => {
    if (error) {
      sendDashboardJson(res, 503, { error: 'Dashboard assets not built. Run npm run build.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentTypeFor(safeFinalPath),
      'Cache-Control': safeFinalPath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  });
}

function resolveSafeDashboardFile(root: string, filePath: string): string | null {
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(filePath);
    return realFile === realRoot || realFile.startsWith(realRoot + path.sep) ? realFile : null;
  } catch {
    return filePath === path.join(root, 'index.html') ? filePath : null;
  }
}

function isLocalDashboardHost(host: string | undefined): boolean {
  if (!host) return true;
  const normalized = host.toLowerCase();
  return normalized === 'localhost'
    || normalized.startsWith('localhost:')
    || normalized === '127.0.0.1'
    || normalized.startsWith('127.0.0.1:')
    || normalized === '[::1]'
    || normalized.startsWith('[::1]:');
}

function isAllowedDashboardOrigin(host: string | undefined, origin: string | undefined, fetchSite: string | string[] | undefined, pathname: string): boolean {
  if (!origin) {
    const site = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;
    if (site === 'same-origin' || site === 'none') return true;
    return pathname !== '/dashboard/state'
      && pathname !== '/dashboard/sessions'
      && !isUnsafeDashboardPath(pathname)
      && !/^\/dashboard\/sessions\/[^/]+\/summary$/.test(pathname)
      && !/^\/dashboard\/sessions\/[^/]+\/restore$/.test(pathname)
      && pathname !== '/dashboard/events';
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || !isLocalDashboardHost(parsed.host)) return false;
    if (isUnsafeDashboardPath(pathname)) return Boolean(host && parsed.host.toLowerCase() === host.toLowerCase());
    return true;
  } catch {
    return false;
  }
}

function isUnsafeDashboardPath(pathname: string): boolean {
  return /^\/dashboard\/sessions\/[^/]+\/(summary|restore)$/.test(pathname)
    || pathname === '/dashboard/audit/fix'
    || pathname === '/dashboard/plugins'
    || /^\/dashboard\/plugins\/.+$/.test(pathname)
    || pathname === '/dashboard/templates'
    || /^\/dashboard\/templates\/[^/]+$/.test(pathname)
    || pathname === '/dashboard/routing/pin'
    || /^\/dashboard\/failover\/cooldowns\/[^/]+$/.test(pathname)
    || /^\/dashboard\/workspaces\/[^/]+$/.test(pathname);
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
