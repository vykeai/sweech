/**
 * Per-provider quota / balance probes.
 *
 * Each third-party vendor exposes consumption differently. Results are
 * cached at ~/.sweech/provider-quotas.json with a 5-minute TTL so the
 * SweechBar 30s poll doesn't hammer vendor APIs. Each probe runs with
 * a 5s timeout — vendor downtime never blocks the UI.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { atomicWriteFileSync } from './atomicWrite'

export interface ProviderQuotaInfo {
  provider: string
  capturedAt: number
  /**
   * Mirror of `capturedAt` — the dashboard reads `fetchedAt` uniformly across
   * every sweech on-disk source. Backfilled on read for legacy entries.
   * See src/freshness.ts.
   */
  fetchedAt?: number
  balanceUsd?: number
  credits?: number
  rateLimit?: {
    used?: number
    limit?: number
    resetsAt?: number
    units?: 'tokens' | 'requests' | 'credits'
    window?: 'minute' | 'hour' | 'day' | 'month'
  }
  note?: string
  error?: string
}

const CACHE_FILE = path.join(os.homedir(), '.sweech', 'provider-quotas.json')
const CACHE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000

interface CacheStore { [provider: string]: ProviderQuotaInfo }

function cacheFileMtimeMs(): number | null {
  try { return fs.statSync(CACHE_FILE).mtimeMs } catch { return null }
}

function readCache(): CacheStore {
  let raw: CacheStore
  try { raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) } catch { return {} }
  // Backfill `fetchedAt` from `capturedAt` (or file mtime as last resort) so
  // the dashboard's FreshnessStamp lookup never returns 'never' for a legacy
  // entry that actually has a known capture time.
  const mtime = cacheFileMtimeMs()
  const out: CacheStore = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') { out[k] = v; continue }
    if (typeof v.fetchedAt === 'number' && Number.isFinite(v.fetchedAt)) { out[k] = v; continue }
    const back = typeof v.capturedAt === 'number' && Number.isFinite(v.capturedAt) ? v.capturedAt : mtime
    out[k] = back === null ? v : { ...v, fetchedAt: back }
  }
  return out
}

function writeCache(store: CacheStore): void {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true, mode: 0o700 })
  atomicWriteFileSync(CACHE_FILE, JSON.stringify(store, null, 2))
  try { fs.chmodSync(CACHE_FILE, 0o600) } catch {}
}

export function getCachedQuota(provider: string): ProviderQuotaInfo | null {
  const entry = readCache()[provider]
  if (!entry) return null
  if (Date.now() - entry.capturedAt > CACHE_TTL_MS) return null
  return entry
}

function setCachedQuota(info: ProviderQuotaInfo): void {
  // Stamp `fetchedAt` alongside `capturedAt` on every write so consumers
  // can rely on the field never being absent on freshly-written entries.
  const stamped: ProviderQuotaInfo = {
    ...info,
    fetchedAt: typeof info.fetchedAt === 'number' && Number.isFinite(info.fetchedAt)
      ? info.fetchedAt
      : info.capturedAt,
  }
  const store = readCache()
  store[stamped.provider] = stamped
  writeCache(store)
}

function withTimeout<T>(promise: Promise<T>, ms = FETCH_TIMEOUT_MS): Promise<T | null> {
  return Promise.race<T | null>([
    promise,
    new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
  ])
}

function numHdr(v: string | null | undefined): number | undefined {
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function parseResetTs(v: string): number | undefined {
  const asNum = Number(v)
  if (Number.isFinite(asNum) && asNum > 0) return asNum * 1000
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

// ── OpenRouter ──────────────────────────────────────────────────────────────

async function probeOpenRouter(apiKey: string): Promise<ProviderQuotaInfo> {
  const info: ProviderQuotaInfo = { provider: 'openrouter', capturedAt: Date.now() }
  try {
    // Two parallel calls: /auth/key for usage + key-level limit,
    // /credits for purchased credit balance.
    const [keyRes, credRes] = await Promise.all([
      withTimeout(fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${apiKey}` } })),
      withTimeout(fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${apiKey}` } })),
    ])
    if (!keyRes || !keyRes.ok) { info.error = `HTTP ${keyRes?.status ?? 'timeout'}`; return info }
    const data = await keyRes.json() as any
    const d = data.data ?? data
    const usage = typeof d.usage === 'number' ? d.usage : 0

    // Purchased credits — only meaningful when total_credits > 0.
    if (credRes && credRes.ok) {
      const cred = (await credRes.json() as any).data ?? {}
      const total = Number(cred.total_credits ?? 0)
      const spent = Number(cred.total_usage ?? usage)
      if (total > 0) info.balanceUsd = Math.max(0, total - spent)
    }

    // Key-level hard limit if set (some org keys have one).
    if (typeof d.limit === 'number' && d.limit > 0) {
      if (info.balanceUsd === undefined) info.balanceUsd = Math.max(0, d.limit - usage)
      info.rateLimit = { used: usage, limit: d.limit, units: 'credits', window: 'month' }
    }
    if (info.balanceUsd === undefined) info.note = `spent $${usage.toFixed(4)}`
  } catch (err) {
    info.error = (err instanceof Error ? err.message : String(err)).slice(0, 200)
  }
  return info
}

// ── Groq ────────────────────────────────────────────────────────────────────

async function probeGroq(apiKey: string, model: string): Promise<ProviderQuotaInfo> {
  const info: ProviderQuotaInfo = { provider: 'groq', capturedAt: Date.now() }
  try {
    // Groq's rate-limit headers only ship on inference endpoints, not
    // /models. Send a 1-token chat completion — the headers come back
    // even on a near-empty response.
    const res = await withTimeout(fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    }))
    if (!res) { info.error = 'timeout'; return info }
    const get = (n: string) => res.headers.get(n)
    const limitTok = numHdr(get('x-ratelimit-limit-tokens'))
    const remTok = numHdr(get('x-ratelimit-remaining-tokens'))
    const limitReq = numHdr(get('x-ratelimit-limit-requests'))
    const remReq = numHdr(get('x-ratelimit-remaining-requests'))
    const resetTok = get('x-ratelimit-reset-tokens')
    const resetReq = get('x-ratelimit-reset-requests')
    if (limitTok !== undefined && remTok !== undefined) {
      info.rateLimit = {
        limit: limitTok, used: limitTok - remTok,
        units: 'tokens',
        resetsAt: resetTok ? parseGroqReset(resetTok) : undefined,
      }
    } else if (limitReq !== undefined && remReq !== undefined) {
      info.rateLimit = {
        limit: limitReq, used: limitReq - remReq,
        units: 'requests',
        resetsAt: resetReq ? parseGroqReset(resetReq) : undefined,
      }
    }
    if (!res.ok && !info.rateLimit) info.error = `HTTP ${res.status}`
  } catch (err) {
    info.error = (err instanceof Error ? err.message : String(err)).slice(0, 200)
  }
  return info
}

function parseGroqReset(v: string): number | undefined {
  const m = /^(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(v.trim())
  if (!m) return undefined
  const mins = Number(m[1] ?? 0)
  const secs = Number(m[2] ?? 0)
  if (!Number.isFinite(mins + secs)) return undefined
  return Date.now() + (mins * 60 + secs) * 1000
}

// ── Public probe entry ──────────────────────────────────────────────────────

export interface ProbeContext {
  provider: string
  apiKey: string
  baseUrl?: string
  model?: string
}

/// Providers that don't publish a usage API — verified empirically.
/// Auth still works but `/v1/messages` and equivalent endpoints return
/// no rate-limit headers, and no balance endpoint is documented.
/// We surface them with a dashboard hint so the SweechBar tile isn't
/// blank or misleading.
const DASHBOARD_ONLY: Record<string, string> = {
  glm: 'check usage at z.ai/manage/usage',
  'kimi-coding': 'check usage at platform.moonshot.cn',
  dashscope: 'check usage at bailian.console.aliyun.com',
  minimax: 'check balance at platform.minimaxi.com',
  gemini: 'check usage at aistudio.google.com',
  nvidia: 'check usage at build.nvidia.com',
  'ollama-cloud': 'check usage at ollama.com/settings',
}

export async function probeProviderQuota(ctx: ProbeContext): Promise<ProviderQuotaInfo | null> {
  switch (ctx.provider) {
    case 'openrouter':   return probeOpenRouter(ctx.apiKey)
    case 'groq':         return probeGroq(ctx.apiKey, ctx.model ?? 'llama-3.3-70b-versatile')
    default:
      if (DASHBOARD_ONLY[ctx.provider]) {
        return {
          provider: ctx.provider,
          capturedAt: Date.now(),
          note: DASHBOARD_ONLY[ctx.provider],
        }
      }
      return null
  }
}

export async function probeAll(contexts: ProbeContext[], opts: { refresh?: boolean } = {}): Promise<Record<string, ProviderQuotaInfo>> {
  const seen = new Set<string>()
  const out: Record<string, ProviderQuotaInfo> = {}
  await Promise.all(contexts.map(async ctx => {
    if (seen.has(ctx.provider)) return
    seen.add(ctx.provider)
    if (!opts.refresh) {
      const cached = getCachedQuota(ctx.provider)
      if (cached) { out[ctx.provider] = cached; return }
    }
    const info = await probeProviderQuota(ctx)
    if (info) {
      setCachedQuota(info)
      out[ctx.provider] = info
    }
  }))
  return out
}
