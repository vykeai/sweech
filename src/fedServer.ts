/**
 * sweech → fed integration server
 *
 * Exposes the fed contract endpoints so sweech appears in the fed dashboard:
 *   GET /fed/info    — machine metadata
 *   GET /fed/runs    — account list (sidebar/status)
 *   GET /fed/widget  — claude-usage widget with 5h + 7d window data
 *
 * Start with: sweech serve [--port PORT]
 * Default fed port: 7854 (matches ~/.fed/config.json)
 */

import http from 'node:http'
import os from 'node:os'
import * as fs from 'fs'
import * as path from 'path'
import { ConfigManager } from './config'
import { getAccountInfo } from './subscriptions'

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

export function createSweechFedServer(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
      res.end()
      return
    }

    if (pathname === '/fed/info') {
      const profiles = getProfiles()
      sendJson(res, 200, {
        machine: getMachineName(),
        service: 'sweech',
        version: packageJson.version,
        fedPort: port,
        platform: process.platform,
        uptime: process.uptime(),
        hostname: os.hostname(),
        accountCount: profiles.length,
        capabilities: ['claude-usage'],
      })
      return
    }

    if (pathname === '/fed/runs') {
      const profiles = getProfiles()
      const accounts = await getAccountInfo(profiles.map(p => ({ name: p.name, commandName: p.commandName })))
      sendJson(res, 200, accounts.map(a => ({
        name: a.name,
        slug: a.commandName,
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
      const accounts = await getAccountInfo(profiles.map(p => ({ name: p.name, commandName: p.commandName })))
      sendJson(res, 200, {
        type: 'claude-usage',
        title: 'sweech',
        emoji: '🍭',
        data: {
          accounts: accounts.map(a => ({
            name: a.name,
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
