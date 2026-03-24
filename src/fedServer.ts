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
import os from 'node:os'
import * as fs from 'fs'
import * as path from 'path'
import { ConfigManager } from './config'
import { getAccountInfo, getKnownAccounts } from './subscriptions'
import { suggestBestAccount } from './accountSelector'

const packageJsonPath = path.join(__dirname, '../package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { version: string }

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  })
  res.end(data)
}

function getMachineName(): string {
  return os.hostname().replace(/\.local$/, '').toLowerCase()
}

function getProfiles() {
  return new ConfigManager().getProfiles()
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

export function createSweechFedServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

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
        capabilities: ['account-usage', 'claude-usage'],
      })
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
      sendJson(res, 200, {
        type: 'account-usage',
        title: 'sweech',
        emoji: '🍭',
        data: {
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
        if (a.live?.utilization7d !== undefined && a.live.utilization7d >= 0.9) {
          alerts.push({ type: 'usage', severity: 'warning', account: a.name, message: `Weekly usage at ${Math.round(a.live.utilization7d * 100)}%` })
        }
        // Expiry alert
        if (a.live?.reset7dAt) {
          const hoursLeft = (a.live.reset7dAt - Date.now() / 1000) / 3600
          const remaining = 1 - (a.live.utilization7d ?? 0)
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

    sendJson(res, 404, { error: 'Not found' })
  })

  return server
}

export async function startSweechFedServer(port: number): Promise<http.Server> {
  const server = createSweechFedServer(port)
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '0.0.0.0', resolve)
  })
  return server
}

/**
 * Start server with graceful shutdown on SIGTERM/SIGINT.
 * Used by `sweech serve`.
 */
export async function startSweechFedServerWithShutdown(port: number): Promise<http.Server> {
  const server = await startSweechFedServer(port)

  const shutdown = () => {
    console.error('[sweech serve] shutting down...')
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
