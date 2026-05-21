import http from 'node:http';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionsDb, type DashboardSession, type DashboardSessionStatus, type ListDashboardSessionsFilter } from './sessionsDb';
import { SessionSummarizer } from './sessionSummarizer';

export type DashboardEventName =
  | 'session.changed'
  | 'audit.flagged'
  | 'doctor.tick'
  | 'peer.online'
  | 'peer.offline'
  | 'cost.tick'
  | 'summary.updated';

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
  sessions: DashboardSession[];
}

export interface DashboardRequestHandlerOptions {
  assetsDir?: string;
  heartbeatMs?: number;
  sessionPollMs?: number;
  maxSseClients?: number;
  catchAllAssets?: boolean;
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
]);

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_SESSION_POLL_MS = 2_000;
const DEFAULT_MAX_SSE_CLIENTS = 50;
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
    if (!isLocalDashboardHost(req.headers.host) || !isAllowedDashboardOrigin(req.headers.origin, req.headers['sec-fetch-site'], url.pathname)) {
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

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendDashboardJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    if (url.pathname === '/dashboard/state') {
      try {
        sendDashboardJson(res, 200, await collectDashboardState());
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
        sendDashboardJson(res, 200, await collectDashboardSessions(url));
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
      sendDashboardEvents(req, res, { heartbeatMs, sessionPollMs, maxSseClients });
      return true;
    }

    serveDashboardAsset(req, res, assetsDir, url.pathname);
    return true;
  };
}

export async function collectDashboardState(): Promise<DashboardState> {
  return collectDashboardSessions();
}

export async function summarizeDashboardSession(sessionId: string) {
  const summarizer = new SessionSummarizer();
  try {
    return await summarizer.summarizeNow(sessionId, 'viewport');
  } finally {
    summarizer.close();
  }
}

export async function collectDashboardSessions(url?: URL): Promise<DashboardState> {
  const db = new SessionsDb();
  try {
    return {
      generatedAt: new Date().toISOString(),
      sessions: db.list(dashboardSessionsFilterFromUrl(url)),
    };
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
    detail: error instanceof Error ? error.message : String(error),
  };
}

function sendDashboardEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { heartbeatMs: number; sessionPollMs: number; maxSseClients: number }
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
    void emitSessionChanges(res, since).then((latest) => {
      since = Math.max(since, latest);
    }).catch((error) => {
      writeDashboardComment(res, `dashboard state unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  emitSessions();

  const unsubscribe = dashboardEventHub.subscribe((event) => {
    writeDashboardEvent(res, event);
  });
  const sessionTimer = setInterval(emitSessions, options.sessionPollMs);
  const heartbeatTimer = setInterval(() => {
    safeWrite(res, `event: heartbeat\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  }, options.heartbeatMs);
  sessionTimer.unref();
  heartbeatTimer.unref();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(sessionTimer);
    clearInterval(heartbeatTimer);
    unsubscribe();
    req.off('close', cleanup);
    res.off('error', cleanup);
    activeSseClients = Math.max(0, activeSseClients - 1);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

async function emitSessionChanges(res: http.ServerResponse, since: number): Promise<number> {
  let latest = since;
  const state = await collectDashboardState();
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

function isAllowedDashboardOrigin(origin: string | undefined, fetchSite: string | string[] | undefined, pathname: string): boolean {
  if (!origin) {
    const site = Array.isArray(fetchSite) ? fetchSite[0] : fetchSite;
    if (site === 'same-origin' || site === 'none') return true;
    return pathname !== '/dashboard/state'
      && pathname !== '/dashboard/sessions'
      && !/^\/dashboard\/sessions\/[^/]+\/summary$/.test(pathname)
      && pathname !== '/dashboard/events';
  }
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && isLocalDashboardHost(parsed.host);
  } catch {
    return false;
  }
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
