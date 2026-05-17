/**
 * Provider-specific rate-limit header parsers.
 *
 * All parsers return the SAME `LiveRateLimitData` shape so that `accountScore()`
 * and `computeSmartScore()` work uniformly across providers (Anthropic, Kimi,
 * Qwen, DeepSeek, Z.ai/GLM).
 *
 * The Anthropic parser lives in `liveUsage.ts` (legacy) and uses unified
 * 5h/7d headers. The OpenAI-compat providers below use the standard
 * `x-ratelimit-*` headers shape: limit / remaining / reset for both requests
 * and tokens. There is no session vs weekly split — each provider returns a
 * single "All models" bucket placed in the `session` slot, mirroring how
 * Anthropic's 5h window maps onto session.
 *
 * Status semantics mirror Claude:
 *   - HTTP 200, utilization < 0.8                -> 'allowed'
 *   - HTTP 200, utilization >= 0.8               -> 'allowed_warning'
 *   - HTTP 429                                   -> 'limit_reached'
 *   - HTTP 401                                   -> 'unauthorized'
 *   - HTTP 403                                   -> 'forbidden'
 *   - other non-2xx                              -> 'rejected'
 */

import type { LiveRateLimitData, RateLimitBucket } from './liveUsage'

export type SupportedProvider = 'kimi' | 'qwen' | 'deepseek' | 'zai'

/** Headers-like accessor: works with a real `Headers` instance OR a plain object. */
export interface HeadersLike {
  get(name: string): string | null
}

/** Normalise a plain object into the `Headers`-like surface used by parsers. */
export function toHeadersLike(input: Headers | Record<string, string | undefined> | HeadersLike): HeadersLike {
  if (typeof (input as HeadersLike).get === 'function') return input as HeadersLike
  const obj = input as Record<string, string | undefined>
  const lower: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = v
  return {
    get(name: string): string | null {
      const v = lower[name.toLowerCase()]
      return v === undefined ? null : v
    },
  }
}

/**
 * Parse a numeric header value safely. Returns `undefined` on `null`, empty,
 * or non-finite values -- never throws and never returns NaN.
 */
function readNumber(h: HeadersLike, key: string): number | undefined {
  const raw = h.get(key)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Parse a reset value. OpenAI-compat APIs typically emit one of:
 *   - duration strings like "3m20s" / "1d2h3m4s5ms" (OpenAI canonical)
 *   - bare seconds-until-reset (e.g. "60")
 *   - epoch seconds (large number >= 10^9)
 *
 * Returns Unix epoch seconds, or `undefined` on parse failure.
 */
function parseResetHeader(h: HeadersLike, key: string, nowSeconds: number): number | undefined {
  const raw = h.get(key)
  if (raw === null || raw === '') return undefined

  // Bare number -- could be seconds-from-now OR epoch seconds.
  const asNum = Number(raw)
  if (Number.isFinite(asNum) && raw.trim() === String(asNum)) {
    // Epoch seconds typically >= 1e9 (year 2001+). Anything smaller is a delta.
    return asNum >= 1_000_000_000 ? Math.floor(asNum) : Math.floor(nowSeconds + asNum)
  }

  // Duration string: e.g. "1d2h3m4s5ms"
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
  let totalMs = 0
  let m: RegExpExecArray | null
  let matched = false
  while ((m = re.exec(raw)) !== null) {
    matched = true
    const v = Number(m[1])
    if (!Number.isFinite(v)) return undefined
    switch (m[2]) {
      case 'ms': totalMs += v; break
      case 's':  totalMs += v * 1_000; break
      case 'm':  totalMs += v * 60_000; break
      case 'h':  totalMs += v * 3_600_000; break
      case 'd':  totalMs += v * 86_400_000; break
    }
  }
  if (!matched || totalMs === 0) return undefined
  return Math.floor(nowSeconds + totalMs / 1_000)
}

/**
 * Compute utilization from limit / remaining. Returns `undefined` if either is
 * missing or limit is zero / negative.
 *
 * Utilization is clamped to [0, 1] -- providers occasionally emit `remaining`
 * values larger than `limit` (concurrent request accounting); we treat those
 * as 0% used rather than negative.
 */
function utilizationFrom(limit: number | undefined, remaining: number | undefined): number | undefined {
  if (limit === undefined || remaining === undefined) return undefined
  if (!(limit > 0)) return undefined
  const used = limit - remaining
  if (!Number.isFinite(used)) return undefined
  return Math.min(1, Math.max(0, used / limit))
}

/**
 * Map HTTP status + utilization to a Claude-aligned status string.
 *
 * Called by every provider parser so the meaning is identical regardless of
 * which provider's headers we just parsed.
 */
export function statusFromHttp(httpStatus: number, utilization: number | undefined): string {
  if (httpStatus === 429) return 'limit_reached'
  if (httpStatus === 401) return 'unauthorized'
  if (httpStatus === 403) return 'forbidden'
  if (httpStatus >= 200 && httpStatus < 300) {
    if (utilization !== undefined && utilization >= 0.8) return 'allowed_warning'
    return 'allowed'
  }
  return 'rejected'
}

// -- Core OpenAI-compat parser -----------------------------------------------

/**
 * Parse the standard OpenAI-compat rate-limit headers into a single "session"
 * bucket. Used as the base for Kimi, Qwen, DeepSeek, Z.ai -- each just supplies
 * its own label.
 *
 * Headers consumed (all optional -- missing ones degrade gracefully):
 *   - x-ratelimit-limit-requests / x-ratelimit-remaining-requests / x-ratelimit-reset-requests
 *   - x-ratelimit-limit-tokens   / x-ratelimit-remaining-tokens   / x-ratelimit-reset-tokens
 *
 * We pick the more-restrictive of the two (requests vs tokens) for the
 * primary utilization, since `accountScore()` reads `buckets[0].session.utilization`
 * and an account that is at 95% of token quota but 5% of request quota is still
 * effectively at 95%.
 */
function parseOpenAICompatHeaders(
  label: string,
  headers: HeadersLike,
  httpStatus: number,
  providerName: SupportedProvider,
  errorMessage?: string,
): LiveRateLimitData {
  const nowSeconds = Date.now() / 1_000

  // 401 / 403 short-circuit -- there are no useful rate-limit headers on auth
  // errors. Mirror the Anthropic branch in liveUsage.ts.
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      buckets: [],
      capturedAt: Date.now(),
      status: httpStatus === 401 ? 'unauthorized' : 'forbidden',
      forbiddenReason: errorMessage || undefined,
      provider: providerName,
    }
  }

  const limReq = readNumber(headers, 'x-ratelimit-limit-requests')
  const remReq = readNumber(headers, 'x-ratelimit-remaining-requests')
  const resetReq = parseResetHeader(headers, 'x-ratelimit-reset-requests', nowSeconds)

  const limTok = readNumber(headers, 'x-ratelimit-limit-tokens')
  const remTok = readNumber(headers, 'x-ratelimit-remaining-tokens')
  const resetTok = parseResetHeader(headers, 'x-ratelimit-reset-tokens', nowSeconds)

  const reqUtil = utilizationFrom(limReq, remReq)
  const tokUtil = utilizationFrom(limTok, remTok)

  // Pick the more-restrictive side. If only one is present, use that.
  let utilization: number | undefined
  let resetsAt: number | undefined
  if (reqUtil !== undefined && tokUtil !== undefined) {
    if (reqUtil >= tokUtil) { utilization = reqUtil; resetsAt = resetReq }
    else                    { utilization = tokUtil; resetsAt = resetTok }
  } else if (reqUtil !== undefined) {
    utilization = reqUtil
    resetsAt = resetReq
  } else if (tokUtil !== undefined) {
    utilization = tokUtil
    resetsAt = resetTok
  }

  const buckets: RateLimitBucket[] = []
  if (utilization !== undefined) {
    buckets.push({
      label,
      session: { utilization, ...(resetsAt !== undefined ? { resetsAt } : {}) },
    })
  } else if (httpStatus === 429) {
    // 429 with no headers -- still want a bucket so consumers can see the
    // hard cap. resetsAt unknown; utilization is implicitly 100%.
    buckets.push({ label, session: { utilization: 1 } })
  }

  return {
    buckets,
    status: statusFromHttp(httpStatus, utilization),
    capturedAt: Date.now(),
    provider: providerName,
  }
}

// -- Provider entry points ---------------------------------------------------

/** Kimi / Moonshot AI -- OpenAI-compat headers, single bucket labelled "All models". */
export function parseKimiRateLimitHeaders(
  headers: Headers | Record<string, string | undefined> | HeadersLike,
  httpStatus: number,
  errorMessage?: string,
): LiveRateLimitData {
  return parseOpenAICompatHeaders('All models', toHeadersLike(headers), httpStatus, 'kimi', errorMessage)
}

/**
 * Qwen / Alibaba DashScope -- OpenAI-compat with optional `x-dashscope-*`
 * variants. We try the canonical `x-ratelimit-*` first, then fall back to
 * `x-dashscope-ratelimit-*` if present.
 */
export function parseQwenRateLimitHeaders(
  headers: Headers | Record<string, string | undefined> | HeadersLike,
  httpStatus: number,
  errorMessage?: string,
): LiveRateLimitData {
  const h = toHeadersLike(headers)
  // If standard headers are absent but dashscope-prefixed ones exist,
  // create a shim that maps the standard names to the dashscope ones.
  const hasStandard = h.get('x-ratelimit-limit-requests') !== null || h.get('x-ratelimit-limit-tokens') !== null
  const hasDashscope = h.get('x-dashscope-ratelimit-limit-requests') !== null || h.get('x-dashscope-ratelimit-limit-tokens') !== null
  let effective: HeadersLike = h
  if (!hasStandard && hasDashscope) {
    effective = {
      get(name: string): string | null {
        const norm = name.toLowerCase()
        if (norm.startsWith('x-ratelimit-')) {
          const ds = h.get('x-dashscope-' + norm.slice('x-'.length))
          if (ds !== null) return ds
        }
        return h.get(name)
      },
    }
  }
  return parseOpenAICompatHeaders('All models', effective, httpStatus, 'qwen', errorMessage)
}

/** DeepSeek -- OpenAI-compat headers. */
export function parseDeepSeekRateLimitHeaders(
  headers: Headers | Record<string, string | undefined> | HeadersLike,
  httpStatus: number,
  errorMessage?: string,
): LiveRateLimitData {
  return parseOpenAICompatHeaders('All models', toHeadersLike(headers), httpStatus, 'deepseek', errorMessage)
}

/** Z.ai / Zhipu GLM -- OpenAI-compat headers. */
export function parseZaiRateLimitHeaders(
  headers: Headers | Record<string, string | undefined> | HeadersLike,
  httpStatus: number,
  errorMessage?: string,
): LiveRateLimitData {
  return parseOpenAICompatHeaders('All models', toHeadersLike(headers), httpStatus, 'zai', errorMessage)
}

// -- Unified dispatch --------------------------------------------------------

/**
 * Dispatch to the right provider parser by name. Returns `null` for unknown
 * providers so callers can fall back to the legacy Anthropic path or skip.
 *
 * Accepted provider strings (case-insensitive, common aliases supported):
 *   - kimi, moonshot, kimi-coding         -> parseKimiRateLimitHeaders
 *   - qwen, dashscope, alibaba, qwen-openai, dashscope-openai -> parseQwenRateLimitHeaders
 *   - deepseek, deepseek-openai           -> parseDeepSeekRateLimitHeaders
 *   - zai, z.ai, glm, zhipu               -> parseZaiRateLimitHeaders
 */
export function parseProviderRateLimitHeaders(
  provider: string,
  headers: Headers | Record<string, string | undefined> | HeadersLike,
  httpStatus: number,
  errorMessage?: string,
): LiveRateLimitData | null {
  const p = provider.trim().toLowerCase()
  if (p === 'kimi' || p === 'moonshot' || p === 'kimi-coding') {
    return parseKimiRateLimitHeaders(headers, httpStatus, errorMessage)
  }
  if (p === 'qwen' || p === 'dashscope' || p === 'alibaba' || p === 'qwen-openai' || p === 'dashscope-openai') {
    return parseQwenRateLimitHeaders(headers, httpStatus, errorMessage)
  }
  if (p === 'deepseek' || p === 'deepseek-openai') {
    return parseDeepSeekRateLimitHeaders(headers, httpStatus, errorMessage)
  }
  if (p === 'zai' || p === 'z.ai' || p === 'glm' || p === 'zhipu') {
    return parseZaiRateLimitHeaders(headers, httpStatus, errorMessage)
  }
  return null
}

// -- Probe URLs --------------------------------------------------------------

/**
 * Cheap probe endpoints per provider. We hit `/v1/models` (a GET that costs
 * no quota but still returns the standard rate-limit headers) for each.
 *
 * Used by the `fetch{Provider}RateLimit` helpers in `liveUsage.ts` -- kept
 * here so docs and parsers live together.
 */
export const PROVIDER_PROBE_URLS: Record<SupportedProvider, string> = {
  kimi: 'https://api.moonshot.ai/v1/models',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
  deepseek: 'https://api.deepseek.com/v1/models',
  zai: 'https://api.z.ai/api/paas/v4/models',
}
