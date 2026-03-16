/**
 * sweech -> fed client — outbound federation requests to peer machines
 *
 * Loads peer config from ~/.sweech/fed-peers.json and provides functions to:
 *   - Fetch /fed/info, /fed/runs, /fed/widget, /healthz from each peer
 *   - Aggregate runs from all peers + local into a unified view
 *   - Manage the peers list (add/remove)
 *
 * All HTTP requests use node:http / node:https with a 5-second timeout.
 * If a peer has a shared secret, requests include Authorization: Bearer <secret>.
 * Network failures return null — callers decide how to handle missing data.
 */

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import { ConfigManager } from './config'
import { getAccountInfo, getKnownAccounts } from './subscriptions'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FedPeer {
  name: string
  host: string
  port: number
  secret?: string
}

export interface MergedAccount {
  machine: string
  name: string
  slug: string
  cliType: string
  plan?: string
  messages5h: number
  messages7d: number
  hoursUntilWeeklyReset?: number
  lastActive?: string
}

export interface PeerStatus {
  name: string
  status: 'ok' | 'error'
  latencyMs: number
}

export interface AggregatedView {
  accounts: MergedAccount[]
  peers: PeerStatus[]
}

// ── Config paths ──────────────────────────────────────────────────────────────

const FED_PEERS_FILE = path.join(os.homedir(), '.sweech', 'fed-peers.json')

// ── Peer config management ────────────────────────────────────────────────────

export function loadFedPeers(): FedPeer[] {
  try {
    const raw = fs.readFileSync(FED_PEERS_FILE, 'utf-8')
    return JSON.parse(raw) as FedPeer[]
  } catch {
    return []
  }
}

export function saveFedPeers(peers: FedPeer[]): void {
  fs.mkdirSync(path.dirname(FED_PEERS_FILE), { recursive: true })
  fs.writeFileSync(FED_PEERS_FILE, JSON.stringify(peers, null, 2))
}

export function addPeer(peer: FedPeer): void {
  const peers = loadFedPeers()
  const existing = peers.findIndex(p => p.name === peer.name)
  if (existing !== -1) {
    peers[existing] = peer
  } else {
    peers.push(peer)
  }
  saveFedPeers(peers)
}

export function removePeer(name: string): void {
  const peers = loadFedPeers().filter(p => p.name !== name)
  saveFedPeers(peers)
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 5_000

function fetchJson(peer: FedPeer, urlPath: string): Promise<unknown | null> {
  return new Promise(resolve => {
    const protocol = peer.port === 443 ? https : http
    const headers: Record<string, string> = { 'Accept': 'application/json' }
    if (peer.secret) {
      headers['Authorization'] = `Bearer ${peer.secret}`
    }

    const req = protocol.request(
      {
        hostname: peer.host,
        port: peer.port,
        path: urlPath,
        method: 'GET',
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      res => {
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve(null)
          }
        })
      },
    )

    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => {
      resolve(null)
    })

    req.end()
  })
}

// ── Peer fetch functions ──────────────────────────────────────────────────────

export async function fetchPeerInfo(peer: FedPeer): Promise<unknown | null> {
  return fetchJson(peer, '/fed/info')
}

export async function fetchPeerRuns(peer: FedPeer): Promise<unknown | null> {
  return fetchJson(peer, '/fed/runs')
}

export async function fetchPeerWidget(peer: FedPeer): Promise<unknown | null> {
  return fetchJson(peer, '/fed/widget')
}

export async function fetchPeerHealth(peer: FedPeer): Promise<{ ok: boolean; latencyMs: number } | null> {
  const start = Date.now()
  const result = await fetchJson(peer, '/healthz')
  const latencyMs = Date.now() - start
  if (result === null) return null
  const body = result as Record<string, unknown>
  return { ok: body.status === 'ok', latencyMs }
}

// ── Aggregation ───────────────────────────────────────────────────────────────

function getMachineName(): string {
  return os.hostname().replace(/\.local$/, '').toLowerCase()
}

export async function aggregateAllPeers(): Promise<AggregatedView> {
  const peers = loadFedPeers()
  const machineName = getMachineName()

  // Fetch local accounts
  const config = new ConfigManager()
  const profiles = config.getProfiles()
  const localAccounts = await getAccountInfo(getKnownAccounts(profiles))

  const mergedAccounts: MergedAccount[] = localAccounts.map(a => ({
    machine: machineName,
    name: a.name,
    slug: a.commandName,
    cliType: a.cliType,
    plan: a.meta.plan,
    messages5h: a.messages5h,
    messages7d: a.messages7d,
    hoursUntilWeeklyReset: a.hoursUntilWeeklyReset,
    lastActive: a.lastActive,
  }))

  const peerStatuses: PeerStatus[] = []

  // Fetch from all peers in parallel
  const results = await Promise.all(
    peers.map(async peer => {
      const start = Date.now()
      const runs = await fetchPeerRuns(peer)
      const latencyMs = Date.now() - start

      if (runs === null || !Array.isArray(runs)) {
        return {
          peer,
          status: 'error' as const,
          latencyMs,
          accounts: [] as MergedAccount[],
        }
      }

      const accounts: MergedAccount[] = runs.map((r: Record<string, unknown>) => ({
        machine: peer.name,
        name: (r.name as string) ?? '',
        slug: (r.slug as string) ?? '',
        cliType: (r.cliType as string) ?? 'claude',
        plan: r.plan as string | undefined,
        messages5h: (r.messages5h as number) ?? 0,
        messages7d: (r.messages7d as number) ?? 0,
        hoursUntilWeeklyReset: r.hoursUntilWeeklyReset as number | undefined,
        lastActive: r.lastActive as string | undefined,
      }))

      return { peer, status: 'ok' as const, latencyMs, accounts }
    }),
  )

  for (const r of results) {
    peerStatuses.push({ name: r.peer.name, status: r.status, latencyMs: r.latencyMs })
    mergedAccounts.push(...r.accounts)
  }

  return { accounts: mergedAccounts, peers: peerStatuses }
}
