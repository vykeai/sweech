/**
 * sweech → fed integration server
 *
 * Exposes the fed contract endpoints so sweech appears in the fed dashboard:
 *   GET /healthz     — health check
 *   GET /fed/info    — machine metadata
 *   GET /fed/runs    — account list (sidebar/status)
 *   GET /fed/widget  — account-usage widget with 5h + 7d window data
 *
 * Start with: sweech serve [--port PORT]
 * Default fed port: 7854 (matches ~/.fed/config.json)
 */

import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import * as fs from 'fs'
import * as path from 'path'
import { timingSafeEqual } from 'node:crypto'
import { ConfigManager } from './config'
import { getAccountInfo, getKnownAccounts } from './subscriptions'
import { recommendRoute, suggestBestAccount, type RouteRecommendationRequest } from './accountSelector'
import { summarizeAccountsForTelemetry } from './usage'
import { readAuditLog } from './auditLog'
import { LogRotator, getServeLogPath } from './logRotator'
import { scrubSecrets } from './scrubSecrets'
import { createDashboardRequestHandler, hasActiveDashboardClients } from './dashboardServer'
import { loadFedPeers, type FedPeer } from './fedClient'
import { loadDaemonSecret, signDaemonRequest, SWEECH_AUTH_HEADER, SWEECH_TS_HEADER } from './daemonAuth'
import { SessionsDb, type DashboardSession, type UpdateDashboardSessionSummaryInput } from './sessionsDb'
import { launchTerminal, type TerminalName } from './terminalLauncher'
// `tokenRefresh` (via `oauth`) transitively pulls in `inquirer`, which is
// an ESM-only package that jest can't load when test suites simply import
// fedServer. The daemon-only callsite below uses a lazy require so the
// transitive ESM load is deferred until `sweech serve` actually runs.

const packageJsonPath = path.join(__dirname, '../package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version: string }
const DASHBOARD_CAPABILITY = 'dashboard-v1'
const FED_DASHBOARD_AUTH_SKEW_MS = 5 * 60_000
const FED_DASHBOARD_BODY_LIMIT_BYTES = 256 * 1024
const DASHBOARD_PEER_POLL_MS = 10_000

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(data)
}

function getMachineName(): string {
  return os.hostname().replace(/\.local$/, '').toLowerCase()
}

function getProfiles() {
  return new ConfigManager().getProfiles()
}

function parseRequiredCapabilities(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((capability) => capability.trim())
    .filter(Boolean)
}

function routeRequestFromQuery(url: URL): RouteRecommendationRequest {
  return {
    taskType: url.searchParams.get('taskType') ?? undefined,
    repo: url.searchParams.get('repo') ?? undefined,
    requiredCapabilities: parseRequiredCapabilities(url.searchParams.get('requiredCapabilities')),
    cliType: url.searchParams.get('cliType') ?? undefined,
    preferredProvider: url.searchParams.get('preferredProvider') ?? undefined,
    preferredModel: url.searchParams.get('preferredModel') ?? undefined,
    preferredProfile: url.searchParams.get('preferredProfile') ?? undefined,
  }
}

type TerminalLauncher = typeof launchTerminal

export interface DashboardPeerCacheEntry {
  hostname: string
  url: string
  lastSeen: number
  capabilities: string[]
  status: 'online' | 'offline'
  sessionCount?: number
}

export class DashboardPeerCache {
  private readonly peers = new Map<string, DashboardPeerCacheEntry>()

  upsert(entry: DashboardPeerCacheEntry): void {
    this.peers.set(entry.hostname, entry)
  }

  markOffline(hostname: string, url: string, capabilities: string[] = []): void {
    const existing = this.peers.get(hostname)
    this.peers.set(hostname, {
      hostname,
      url,
      capabilities: existing?.capabilities ?? capabilities,
      lastSeen: existing?.lastSeen ?? Date.now(),
      status: 'offline',
      sessionCount: existing?.sessionCount,
    })
  }

  list(): DashboardPeerCacheEntry[] {
    return [...this.peers.values()].sort((a, b) => a.hostname.localeCompare(b.hostname))
  }
}

export interface DashboardPeerPollingOptions {
  cache: DashboardPeerCache
  isDashboardOpen?: () => boolean
  intervalMs?: number
  secretPath?: string
  peersProvider?: () => FedPeer[]
}

export function startDashboardPeerPolling(options: DashboardPeerPollingOptions): () => void {
  const intervalMs = options.intervalMs ?? DASHBOARD_PEER_POLL_MS
  const isDashboardOpen = options.isDashboardOpen ?? (() => true)
  const peersProvider = options.peersProvider ?? loadFedPeers
  let stopped = false

  const tick = async () => {
    if (stopped || !isDashboardOpen()) return
    const secret = await loadDaemonSecret(options.secretPath)
    if (!secret) return
    await Promise.all(peersProvider().map((peer) => refreshDashboardPeer(peer, secret, options.cache)))
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref()
  void tick()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding window per IP
// ---------------------------------------------------------------------------
interface RateLimitEntry {
  timestamps: number[]
}

const rateLimitStore = new Map<string, RateLimitEntry>()
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60   // 60 req/min per IP

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  let entry = rateLimitStore.get(ip)
  if (!entry) {
    entry = { timestamps: [] }
    rateLimitStore.set(ip, entry)
  }

  // Prune expired timestamps
  entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS)
  if (entry.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return true
  }
  entry.timestamps.push(now)
  return false
}

class FedDashboardRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

interface FedDashboardAuthResult {
  ok: boolean
  status: number
  error?: string
}

async function verifyFedDashboardRequest(
  req: http.IncomingMessage,
  url: URL,
  body: string,
  secretPath?: string,
): Promise<FedDashboardAuthResult> {
  const secret = await loadDaemonSecret(secretPath)
  if (!secret) return { ok: false, status: 503, error: 'Federation daemon secret is unavailable' }

  const ts = req.headers[SWEECH_TS_HEADER.toLowerCase()]
  const signature = req.headers[SWEECH_AUTH_HEADER.toLowerCase()]
  const tsValue = Array.isArray(ts) ? ts[0] : ts
  const signatureValue = Array.isArray(signature) ? signature[0] : signature
  if (!tsValue || !signatureValue) return { ok: false, status: 401, error: 'Missing federation HMAC headers' }

  const tsMs = Number.parseInt(tsValue, 10)
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > FED_DASHBOARD_AUTH_SKEW_MS) {
    return { ok: false, status: 401, error: 'Expired federation HMAC timestamp' }
  }

  const pathWithQuery = `${url.pathname}${url.search}`
  const expected = signDaemonRequest(secret, req.method ?? 'GET', pathWithQuery, body, tsMs)[SWEECH_AUTH_HEADER]
  if (!constantTimeEqualHex(signatureValue, expected)) {
    return { ok: false, status: 401, error: 'Invalid federation HMAC signature' }
  }
  return { ok: true, status: 200 }
}

function constantTimeEqualHex(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]+$/i.test(actual) || actual.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

function readRequestBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    let data = ''
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      data += chunk
      if (data.length > FED_DASHBOARD_BODY_LIMIT_BYTES) {
        tooLarge = true
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('close', () => {
      if (tooLarge) {
        sendJson(res, 413, { error: 'Federation request body too large' })
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function parseJsonObject(body: string): Record<string, unknown> {
  try {
    const parsed = body ? JSON.parse(body) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new FedDashboardRequestError(400, 'JSON object body is required')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof FedDashboardRequestError) throw error
    throw new FedDashboardRequestError(400, 'Invalid JSON body')
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberField(payload: Record<string, unknown>, key: string): number | null | undefined {
  const value = payload[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseTerminalName(value: string | undefined): TerminalName | undefined {
  if (!value) return undefined
  if (value === 'ghostty' || value === 'iterm2' || value === 'terminal' || value === 'alacritty' || value === 'kitty' || value === 'wezterm') {
    return value
  }
  throw new FedDashboardRequestError(400, `Unsupported terminal: ${value}`)
}

function collectFederatedDashboardState(dbPath?: string): { generatedAt: string; sessions: DashboardSession[] } {
  const db = new SessionsDb(dbPath)
  try {
    return {
      generatedAt: new Date().toISOString(),
      sessions: db.list(),
    }
  } finally {
    db.close()
  }
}

async function restoreDashboardSession(sessionId: string, terminal: TerminalName, terminalLauncher: TerminalLauncher, dbPath?: string): Promise<{ ok: boolean; session: DashboardSession; launch?: unknown; reason?: string }> {
  const db = new SessionsDb(dbPath)
  try {
    const session = db.byId(sessionId)
    if (!session) throw new FedDashboardRequestError(404, 'Dashboard session not found')
    const command: [string, ...string[]] = session.tmuxName
      ? ['tmux', 'attach', '-t', session.tmuxName]
      : [session.workspace, '--continue']
    const launch = await terminalLauncher({
      terminal,
      command,
      cwd: session.cwd,
      title: `sweech ${session.workspace}`,
    })
    return launch.ok
      ? { ok: true, session, launch }
      : { ok: false, session, reason: launch.reason, launch }
  } finally {
    db.close()
  }
}

function updateFederatedDashboardSummary(sessionId: string, payload: Record<string, unknown>, dbPath?: string): DashboardSession | null {
  const summaryBullets = payload.summaryBullets ?? payload.summary_bullets
  if (summaryBullets !== undefined && summaryBullets !== null && !Array.isArray(summaryBullets) && typeof summaryBullets !== 'string') {
    throw new FedDashboardRequestError(400, 'summaryBullets must be an array, string, or null')
  }

  const input: UpdateDashboardSessionSummaryInput = {
    summaryOne: stringField(payload, 'summaryOne') ?? stringField(payload, 'summary_one') ?? null,
    summaryBullets: summaryBullets as string[] | string | null | undefined,
    summaryProvider: stringField(payload, 'summaryProvider') ?? stringField(payload, 'summary_provider') ?? null,
    summaryModel: stringField(payload, 'summaryModel') ?? stringField(payload, 'summary_model') ?? null,
    summaryCostUsd: numberField(payload, 'summaryCostUsd') ?? numberField(payload, 'summary_cost_usd') ?? null,
    summaryAt: numberField(payload, 'summaryAt') ?? numberField(payload, 'summary_at') ?? Date.now(),
    summaryMsgAt: numberField(payload, 'summaryMsgAt') ?? numberField(payload, 'summary_msg_at') ?? numberField(payload, 'messageCount') ?? undefined,
    messageCount: numberField(payload, 'messageCount') ?? numberField(payload, 'message_count') ?? undefined,
  }

  const db = new SessionsDb(dbPath)
  try {
    return db.updateSummary(sessionId, input)
  } finally {
    db.close()
  }
}

async function refreshDashboardPeer(peer: FedPeer, secret: string, cache: DashboardPeerCache): Promise<void> {
  const protocol = peer.port === 443 ? https : http
  const pathWithQuery = '/fed/dashboard/state'
  const headers = {
    Accept: 'application/json',
    ...signDaemonRequest(peer.secret ?? secret, 'GET', pathWithQuery, ''),
  }
  const url = `${peer.port === 443 ? 'https' : 'http'}://${peer.host}:${peer.port}`

  await new Promise<void>((resolve) => {
    const req = protocol.request({
      hostname: peer.host,
      port: peer.port,
      path: pathWithQuery,
      method: 'GET',
      headers,
      timeout: 3000,
    }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          cache.markOffline(peer.name, url)
          resolve()
          return
        }
        try {
          const parsed = JSON.parse(data) as { hostname?: string; machine?: string; capabilities?: unknown; sessions?: unknown[] }
          const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities.filter((item): item is string => typeof item === 'string') : [DASHBOARD_CAPABILITY]
          cache.upsert({
            hostname: parsed.hostname ?? parsed.machine ?? peer.name,
            url,
            lastSeen: Date.now(),
            capabilities,
            status: 'online',
            sessionCount: Array.isArray(parsed.sessions) ? parsed.sessions.length : undefined,
          })
        } catch {
          cache.markOffline(peer.name, url)
        }
        resolve()
      })
    })
    req.on('timeout', () => {
      req.destroy()
      cache.markOffline(peer.name, url)
      resolve()
    })
    req.on('error', () => {
      cache.markOffline(peer.name, url)
      resolve()
    })
    req.end()
  })
}

// Periodic cleanup of stale entries
const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitStore) {
    entry.timestamps = entry.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS)
    if (entry.timestamps.length === 0) rateLimitStore.delete(ip)
  }
}, 60_000)
rateLimitCleanupInterval.unref()

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const startTime = Date.now()

export interface SweechFedServerCreateOptions {
  daemonSecretPath?: string
  sessionsDbPath?: string
  terminalLauncher?: TerminalLauncher
  dashboardPeerCache?: DashboardPeerCache
}

export function createSweechFedServer(port: number, options: SweechFedServerCreateOptions = {}): http.Server {
  const handleDashboardRequest = createDashboardRequestHandler()
  const peerCache = options.dashboardPeerCache ?? new DashboardPeerCache()
  const server = http.createServer(async (req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      sendJson(res, 400, { error: 'Bad request target' })
      return
    }
    const pathname = url.pathname

    if (await handleDashboardRequest(req, res)) {
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
      res.end()
      return
    }

    // Health check — no rate limit
    if (pathname === '/healthz') {
      sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        version: packageJson.version,
        timestamp: new Date().toISOString(),
      })
      return
    }

    // Rate limit all other endpoints
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (isRateLimited(ip)) {
      sendJson(res, 429, { error: 'Too many requests', retryAfterMs: RATE_LIMIT_WINDOW_MS })
      return
    }

    if (pathname === '/fed/info') {
      const profiles = getProfiles()
      const allAccounts = getKnownAccounts(profiles)
      sendJson(res, 200, {
        machine: getMachineName(),
        service: 'sweech',
        version: packageJson.version,
        fedPort: port,
        platform: process.platform,
        uptime: process.uptime(),
        hostname: os.hostname(),
        accountCount: allAccounts.length,
        caps: DASHBOARD_CAPABILITY,
        txt: { caps: DASHBOARD_CAPABILITY },
        capabilities: ['account-usage', 'account-recommendation', 'route-recommendation', 'account-alerts', 'dashboard', DASHBOARD_CAPABILITY],
      })
      return
    }

    if (pathname === '/fed/dashboard/state') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' })
        return
      }
      const auth = await verifyFedDashboardRequest(req, url, '', options.daemonSecretPath)
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error })
        return
      }
      try {
        const profiles = getProfiles()
        const accounts = await getAccountInfo(getKnownAccounts(profiles))
        const dashboardState = collectFederatedDashboardState(options.sessionsDbPath)
        sendJson(res, 200, {
          ...dashboardState,
          machine: getMachineName(),
          hostname: os.hostname(),
          capabilities: ['dashboard', DASHBOARD_CAPABILITY],
          status: {
            uptime: process.uptime(),
            version: packageJson.version,
            accountCount: accounts.length,
          },
          accounts: accounts.map(a => ({
            name: a.name,
            slug: a.commandName,
            cliType: a.cliType,
            plan: a.meta.plan,
            messages5h: a.messages5h,
            messages7d: a.messages7d,
            hoursUntilWeeklyReset: a.hoursUntilWeeklyReset,
            lastActive: a.lastActive,
            live: a.live,
          })),
          peers: peerCache.list(),
        })
      } catch (error) {
        sendJson(res, 500, { error: 'Dashboard federation state unavailable', detail: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (pathname === '/fed/dashboard/restore') {
      const body = await readRequestBody(req, res)
      if (body === null) return
      const auth = await verifyFedDashboardRequest(req, url, body, options.daemonSecretPath)
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error })
        return
      }
      try {
        const payload = parseJsonObject(body)
        const sessionId = stringField(payload, 'sessionId') ?? stringField(payload, 'id')
        if (!sessionId) {
          sendJson(res, 400, { error: 'sessionId is required' })
          return
        }
        const terminal = parseTerminalName(stringField(payload, 'terminal')) ?? 'ghostty'
        const result = await restoreDashboardSession(sessionId, terminal, options.terminalLauncher ?? launchTerminal, options.sessionsDbPath)
        sendJson(res, result.ok ? 200 : 422, result)
      } catch (error) {
        if (error instanceof FedDashboardRequestError) {
          sendJson(res, error.status, { error: error.message })
          return
        }
        sendJson(res, 500, { error: 'Dashboard session restore failed', detail: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (pathname === '/fed/dashboard/summary') {
      const body = await readRequestBody(req, res)
      if (body === null) return
      const auth = await verifyFedDashboardRequest(req, url, body, options.daemonSecretPath)
      if (!auth.ok) {
        sendJson(res, auth.status, { error: auth.error })
        return
      }
      try {
        const payload = parseJsonObject(body)
        const sessionId = stringField(payload, 'sessionId') ?? stringField(payload, 'id')
        if (!sessionId) {
          sendJson(res, 400, { error: 'sessionId is required' })
          return
        }
        const updated = updateFederatedDashboardSummary(sessionId, payload, options.sessionsDbPath)
        if (!updated) {
          sendJson(res, 404, { error: 'Dashboard session not found' })
          return
        }
        sendJson(res, 200, { ok: true, session: updated })
      } catch (error) {
        if (error instanceof FedDashboardRequestError) {
          sendJson(res, error.status, { error: error.message })
          return
        }
        sendJson(res, 500, { error: 'Dashboard summary update failed', detail: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (pathname === '/fed/billing') {
      // Per-account billing snapshot for SweechBar's Vault tab. Sourced
      // from ~/.sweech/billing.json (populated only by `sweech billing
      // set` — manual user entry, no email scanning).
      // Next-bill date + days-until are RECOMPUTED at request time
      // against today's calendar; never read from stored fields.
      try {
        const { readBillingFile, daysUntilNextBill, nextBillingDate } = require('./billing') as typeof import('./billing');
        const file = readBillingFile();
        const entries = Object.values(file.entries)
          .filter(e => e.billingDay != null)
          .map(e => ({
            vendor: e.vendor,
            email: e.email,
            billingDay: e.billingDay,
            nextBillingDate: nextBillingDate(e),
            daysUntilNextBill: daysUntilNextBill(e),
            updatedAt: e.updatedAt,
            note: e.note ?? null,
          }))
        sendJson(res, 200, {
          schemaVersion: 'sweech.billing.v1',
          producer: 'sweech',
          entries,
        })
      } catch (err) {
        sendJson(res, 200, {
          schemaVersion: 'sweech.billing.v1',
          producer: 'sweech',
          entries: [],
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }

    if (pathname === '/fed/runs') {
      const profiles = getProfiles()
      const accounts = await getAccountInfo(getKnownAccounts(profiles))
      sendJson(res, 200, accounts.map(a => ({
        name: a.name,
        slug: a.commandName,
        cliType: a.cliType,
        plan: a.meta.plan,
        messages5h: a.messages5h,
        messages7d: a.messages7d,
        hoursUntilWeeklyReset: a.hoursUntilWeeklyReset,
        lastActive: a.lastActive,
      })))
      return
    }

    if (pathname === '/fed/widget') {
      const profiles = getProfiles()
      const accounts = await getAccountInfo(getKnownAccounts(profiles))
      const summary = summarizeAccountsForTelemetry(accounts)
      sendJson(res, 200, {
        type: 'account-usage',
        title: 'sweech',
        emoji: '🍭',
        data: {
          summary,
          accounts: accounts.map(a => ({
            name: a.name,
            cliType: a.cliType,
            plan: a.meta.plan,
            limits: a.meta.limits,
            messages5h: a.messages5h,
            messages7d: a.messages7d,
            minutesUntilFirstCapacity: a.minutesUntilFirstCapacity,
            weeklyResetAt: a.weeklyResetAt,
            hoursUntilWeeklyReset: a.hoursUntilWeeklyReset,
            lastActive: a.lastActive,
            live: a.live,
          })),
        },
      })
      return
    }

    if (pathname === '/fed/recommendation') {
      const cliType = url.searchParams.get('cliType') ?? undefined
      const recommendation = await suggestBestAccount(cliType ?? undefined, getProfiles())
      sendJson(res, 200, recommendation ?? null)
      return
    }

    if (pathname === '/fed/route-recommendation') {
      // Federation endpoint has no client-cwd context, so project pins
      // (`.sweech.json`) are NOT applied here — pin resolution is a
      // client-side responsibility (CLI/SweechBar). Intentionally
      // 2-arg call; don't "fix" this by adding `findProjectPin()`.
      const recommendation = await recommendRoute(routeRequestFromQuery(url), getProfiles())
      sendJson(res, 200, recommendation)
      return
    }

    if (pathname === '/fed/alerts') {
      const profiles = getProfiles()
      const accounts = await getAccountInfo(getKnownAccounts(profiles))
      const alerts: Array<{ type: string; severity: string; account: string; message: string }> = []

      for (const a of accounts) {
        if (a.needsReauth) {
          alerts.push({ type: 'auth', severity: 'error', account: a.name, message: 'Needs re-authentication' })
        }
        if (a.live?.status === 'limit_reached') {
          alerts.push({ type: 'limit', severity: 'warning', account: a.name, message: '5h rate limit reached' })
        }
        const weekly = a.live?.buckets?.[0]?.weekly
        if (weekly?.utilization !== undefined && weekly.utilization >= 0.9) {
          alerts.push({ type: 'usage', severity: 'warning', account: a.name, message: `Weekly usage at ${Math.round(weekly.utilization * 100)}%` })
        }
        // Expiry alert
        if (weekly?.resetsAt) {
          const hoursLeft = (weekly.resetsAt - Date.now() / 1000) / 3600
          const remaining = 1 - (weekly.utilization ?? 0)
          if (hoursLeft > 0 && hoursLeft < 24 && remaining > 0.2) {
            alerts.push({ type: 'expiry', severity: 'info', account: a.name, message: `${Math.round(remaining * 100)}% expiring in ${Math.round(hoursLeft)}h` })
          }
        }
      }

      sendJson(res, 200, { alerts, timestamp: new Date().toISOString() })
      return
    }

    if (pathname === '/fed/status') {
      const profiles = getProfiles()
      const accounts = await getAccountInfo(getKnownAccounts(profiles))
      const total = accounts.length
      const available = accounts.filter(a => !a.needsReauth && a.live?.status !== 'limit_reached').length
      const limited = accounts.filter(a => a.live?.status === 'limit_reached').length
      const needsAuth = accounts.filter(a => a.needsReauth).length
      sendJson(res, 200, {
        total,
        available,
        limited,
        needsAuth,
        uptime: process.uptime(),
        version: packageJson.version,
      })
      return
    }

    if (pathname === '/fed/audit') {
      const limitParam = url.searchParams.get('limit')
      const actionParam = url.searchParams.get('action') ?? undefined
      const limit = limitParam ? parseInt(limitParam, 10) : undefined
      const entries = readAuditLog({
        limit: (limit && limit > 0) ? limit : undefined,
        action: actionParam,
      })
      sendJson(res, 200, { entries, total: entries.length, timestamp: new Date().toISOString() })
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  })

  const stopDashboardPeerPolling = startDashboardPeerPolling({
    cache: peerCache,
    isDashboardOpen: hasActiveDashboardClients,
    secretPath: options.daemonSecretPath,
  })
  server.on('close', stopDashboardPeerPolling)

  return server
}

export interface SweechFedServerOptions {
  host?: string;
}

export async function startSweechFedServer(port: number, options: SweechFedServerOptions = {}): Promise<http.Server> {
  const server = createSweechFedServer(port)
  const host = options.host ?? '0.0.0.0'
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, resolve)
  })
  return server
}

/**
 * Start server with graceful shutdown on SIGTERM/SIGINT.
 * Used by `sweech serve`.
 *
 * T-054: also starts a LogRotator against ~/Library/Logs/sweech-serve.log
 * (or whatever SWEECH_LOG_PATH points to). The launchd plist redirects
 * stdout/stderr to that file; without rotation it grows unbounded. The
 * rotator runs immediately on start, then hourly, capped at 5 historical
 * files. Timer is unref'd, so it never blocks shutdown.
 */
export async function startSweechFedServerWithShutdown(port: number, options: SweechFedServerOptions = {}): Promise<http.Server> {
  const server = await startSweechFedServer(port, options)

  let logRotator: LogRotator | null = null
  try {
    logRotator = new LogRotator({ logPath: getServeLogPath() })
    logRotator.start()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[sweech serve] failed to start log rotator: ${message}\n`)
    logRotator = null
  }

  // T-LU-006 wiring: start the OAuth token-refresh loop alongside the log
  // rotator. Without this, refreshExpiringTokens() never fires in production
  // — tokens silently expire even though the 24h window + audit log are
  // implemented. We pass the current profile list from disk; if a new
  // profile is added later the daemon restart picks it up (the loop
  // captures the list by reference so config edits during a long-running
  // daemon don't propagate, which is a known limitation accepted as a
  // restart-on-add policy for now).
  // T-LU-003 wiring: register the failover listener BEFORE the token-refresh
  // loop kicks off so the very first probe's limit_reached event is captured.
  // The listener writes ~/.sweech/failover-cooldowns.json + audit + webhook;
  // see src/failover.ts. lazy-required for the same reason as tokenRefresh.
  let stopFailoverListener: (() => void) | null = null
  try {
    const { startFailoverListener } = require('./failover') as typeof import('./failover')
    stopFailoverListener = startFailoverListener()
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err))
    process.stderr.write(`[sweech serve] failed to start failover listener: ${message}\n`)
    stopFailoverListener = null
  }

  let stopTokenRefresh: (() => void) | null = null
  try {
    const profiles = new ConfigManager().getProfiles()
    const { startTokenRefreshLoop } = require('./tokenRefresh') as typeof import('./tokenRefresh')
    stopTokenRefresh = startTokenRefreshLoop(profiles)
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err))
    process.stderr.write(`[sweech serve] failed to start token-refresh loop: ${message}\n`)
    stopTokenRefresh = null
  }

  const shutdown = () => {
    console.error('[sweech serve] shutting down...')
    // Order matters: silence the event bus FIRST (so a final
    // token-refresh probe or response handler that fires limit_reached
    // during teardown doesn't trigger a disk write while we're already
    // closing). Then stop the refresh timer, then close the server.
    stopFailoverListener?.()
    stopFailoverListener = null
    stopTokenRefresh?.()
    stopTokenRefresh = null
    logRotator?.stop()
    logRotator = null
    server.close(() => {
      process.exit(0)
    })
    // Force exit after 5s if connections don't drain
    setTimeout(() => process.exit(0), 5000).unref()
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return server
}
