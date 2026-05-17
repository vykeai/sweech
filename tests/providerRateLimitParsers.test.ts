/**
 * Tests for provider-specific rate-limit header parsers.
 *
 * Covers Kimi, Qwen, DeepSeek, Z.ai across the matrix:
 *   - 200 with full headers (allowed / allowed_warning)
 *   - 429 (limit_reached)
 *   - 401 (unauthorized)
 *   - 403 (forbidden)
 *   - missing headers (graceful empty buckets, valid object)
 *   - malformed numeric values (graceful fallback, no throw)
 *
 * Plus integration tests for the dispatch helper and the OpenAI-compat
 * fetcher (`fetchKimiRateLimit` etc.) using a mocked global `fetch`.
 *
 * No real network calls. No keychain. No filesystem.
 */

import {
  parseKimiRateLimitHeaders,
  parseQwenRateLimitHeaders,
  parseDeepSeekRateLimitHeaders,
  parseZaiRateLimitHeaders,
  parseProviderRateLimitHeaders,
  statusFromHttp,
  toHeadersLike,
  PROVIDER_PROBE_URLS,
} from '../src/providerRateLimitParsers';
import {
  fetchKimiRateLimit,
  fetchQwenRateLimit,
  fetchDeepSeekRateLimit,
  fetchZaiRateLimit,
} from '../src/liveUsage';

const NOW = 1_700_000_000_000;
const NOW_S = NOW / 1_000;

function makeHeaders(obj: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(obj)) h.set(k, v);
  return h;
}

// Pin Date.now so utilization and reset arithmetic is deterministic.
const realDateNow = Date.now;
beforeAll(() => { (Date as any).now = () => NOW; });
afterAll(() => { (Date as any).now = realDateNow; });

// ─────────────────────────────────────────────────────────────────────────────
// helpers — shared by all provider suites
// ─────────────────────────────────────────────────────────────────────────────

function fullOpenAICompatHeaders200(): Headers {
  // 1000 limit, 700 remaining → 30% utilized (allowed)
  return makeHeaders({
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '700',
    'x-ratelimit-reset-requests': '3m20s',
    'x-ratelimit-limit-tokens': '100000',
    'x-ratelimit-remaining-tokens': '95000',
    'x-ratelimit-reset-tokens': '60s',
  });
}

function fullOpenAICompatHeaders200Warning(): Headers {
  // 1000 limit, 50 remaining → 95% utilized (allowed_warning)
  return makeHeaders({
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '50',
    'x-ratelimit-reset-requests': '60s',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// statusFromHttp — primitive used by every parser
// ─────────────────────────────────────────────────────────────────────────────

describe('statusFromHttp', () => {
  test('200 with low utilization → allowed', () => {
    expect(statusFromHttp(200, 0.3)).toBe('allowed');
  });
  test('200 with utilization === 0.8 → allowed_warning', () => {
    expect(statusFromHttp(200, 0.8)).toBe('allowed_warning');
  });
  test('200 with utilization > 0.8 → allowed_warning', () => {
    expect(statusFromHttp(200, 0.95)).toBe('allowed_warning');
  });
  test('200 with utilization undefined → allowed', () => {
    expect(statusFromHttp(200, undefined)).toBe('allowed');
  });
  test('429 → limit_reached', () => {
    expect(statusFromHttp(429, undefined)).toBe('limit_reached');
  });
  test('401 → unauthorized', () => {
    expect(statusFromHttp(401, undefined)).toBe('unauthorized');
  });
  test('403 → forbidden', () => {
    expect(statusFromHttp(403, undefined)).toBe('forbidden');
  });
  test('500 → rejected', () => {
    expect(statusFromHttp(500, undefined)).toBe('rejected');
  });
  test('400 → rejected', () => {
    expect(statusFromHttp(400, undefined)).toBe('rejected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toHeadersLike — accepts both Headers instances and plain objects
// ─────────────────────────────────────────────────────────────────────────────

describe('toHeadersLike', () => {
  test('returns Headers instance as-is via .get()', () => {
    const h = makeHeaders({ 'x-foo': '1' });
    const wrapped = toHeadersLike(h);
    expect(wrapped.get('x-foo')).toBe('1');
    expect(wrapped.get('X-FOO')).toBe('1');
  });

  test('wraps a plain object case-insensitively', () => {
    const wrapped = toHeadersLike({ 'X-Foo': '42', 'x-bar': 'hello' });
    expect(wrapped.get('x-foo')).toBe('42');
    expect(wrapped.get('X-BAR')).toBe('hello');
    expect(wrapped.get('missing')).toBeNull();
  });

  test('handles undefined values as null', () => {
    const wrapped = toHeadersLike({ 'x-foo': undefined });
    expect(wrapped.get('x-foo')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-provider matrix — each provider × {200, 200_warning, 429, 401, 403,
// missing, malformed}
//
// All four OpenAI-compat parsers share an implementation, so we run the
// same matrix against each entry point to prove the contract holds for each.
// ─────────────────────────────────────────────────────────────────────────────

type Parser = (h: Headers, status: number, errMsg?: string) => ReturnType<typeof parseKimiRateLimitHeaders>;

const providers: Array<{ name: string; parse: Parser; providerField: string }> = [
  { name: 'Kimi',     parse: parseKimiRateLimitHeaders,     providerField: 'kimi' },
  { name: 'Qwen',     parse: parseQwenRateLimitHeaders,     providerField: 'qwen' },
  { name: 'DeepSeek', parse: parseDeepSeekRateLimitHeaders, providerField: 'deepseek' },
  { name: 'Z.ai',     parse: parseZaiRateLimitHeaders,      providerField: 'zai' },
];

for (const { name, parse, providerField } of providers) {
  describe(`${name} parser`, () => {
    test('200 with full headers → allowed, single bucket with utilization & resetsAt', () => {
      const result = parse(fullOpenAICompatHeaders200(), 200);
      expect(result.status).toBe('allowed');
      expect(result.provider).toBe(providerField);
      expect(result.buckets).toHaveLength(1);

      const b = result.buckets[0]!;
      expect(b.label).toBe('All models');
      expect(b.weekly).toBeUndefined();
      expect(b.session).toBeDefined();
      // 30% util (requests) is more restrictive than 5% util (tokens) → pick requests bucket
      expect(b.session!.utilization).toBeCloseTo(0.3, 5);
      // 3m20s = 200s from now
      expect(b.session!.resetsAt).toBe(Math.floor(NOW_S + 200));
      expect(result.capturedAt).toBe(NOW);
    });

    test('200 with utilization ≥ 0.8 → allowed_warning', () => {
      const result = parse(fullOpenAICompatHeaders200Warning(), 200);
      expect(result.status).toBe('allowed_warning');
      expect(result.buckets[0]!.session!.utilization).toBeCloseTo(0.95, 5);
    });

    test('429 → limit_reached with fallback 100% bucket when headers absent', () => {
      const result = parse(makeHeaders({}), 429);
      expect(result.status).toBe('limit_reached');
      expect(result.provider).toBe(providerField);
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0]!.session!.utilization).toBe(1);
    });

    test('429 with headers → limit_reached with real utilization', () => {
      const result = parse(makeHeaders({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '30s',
      }), 429);
      expect(result.status).toBe('limit_reached');
      expect(result.buckets[0]!.session!.utilization).toBe(1);
      expect(result.buckets[0]!.session!.resetsAt).toBe(Math.floor(NOW_S + 30));
    });

    test('401 → unauthorized with no buckets and optional forbiddenReason', () => {
      const result = parse(makeHeaders({}), 401, 'Invalid API key');
      expect(result.status).toBe('unauthorized');
      expect(result.provider).toBe(providerField);
      expect(result.buckets).toEqual([]);
      expect(result.forbiddenReason).toBe('Invalid API key');
    });

    test('403 → forbidden with no buckets and optional forbiddenReason', () => {
      const result = parse(makeHeaders({}), 403, 'Account suspended');
      expect(result.status).toBe('forbidden');
      expect(result.provider).toBe(providerField);
      expect(result.buckets).toEqual([]);
      expect(result.forbiddenReason).toBe('Account suspended');
    });

    test('401 without errMsg → unauthorized, forbiddenReason undefined', () => {
      const result = parse(makeHeaders({}), 401);
      expect(result.status).toBe('unauthorized');
      expect(result.forbiddenReason).toBeUndefined();
    });

    test('200 with missing headers → allowed, empty buckets, valid object', () => {
      const result = parse(makeHeaders({}), 200);
      expect(result.status).toBe('allowed');
      expect(result.provider).toBe(providerField);
      expect(result.buckets).toEqual([]);
      expect(result.capturedAt).toBe(NOW);
    });

    test('200 with malformed numeric values → no throw, graceful fallback', () => {
      const result = parse(makeHeaders({
        'x-ratelimit-limit-requests': 'not-a-number',
        'x-ratelimit-remaining-requests': 'NaN',
        'x-ratelimit-reset-requests': 'garbage',
        'x-ratelimit-limit-tokens': '',
        'x-ratelimit-remaining-tokens': 'Infinity',
        'x-ratelimit-reset-tokens': '',
      }), 200);
      expect(result.status).toBe('allowed');
      expect(result.buckets).toEqual([]);
    });

    test('200 with limit=0 → graceful (no divide-by-zero, no bucket)', () => {
      const result = parse(makeHeaders({
        'x-ratelimit-limit-requests': '0',
        'x-ratelimit-remaining-requests': '0',
      }), 200);
      expect(result.status).toBe('allowed');
      expect(result.buckets).toEqual([]);
    });

    test('200 with remaining > limit → utilization clamped to 0 (allowed)', () => {
      const result = parse(makeHeaders({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '150',
      }), 200);
      expect(result.status).toBe('allowed');
      expect(result.buckets[0]!.session!.utilization).toBe(0);
    });

    test('200 with bare-seconds reset header → resetsAt is now + delta', () => {
      const result = parse(makeHeaders({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '50',
        'x-ratelimit-reset-requests': '120',
      }), 200);
      expect(result.buckets[0]!.session!.resetsAt).toBe(Math.floor(NOW_S + 120));
    });

    test('200 with epoch-seconds reset header → resetsAt is the epoch value', () => {
      const future = Math.floor(NOW_S + 600);
      const result = parse(makeHeaders({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '50',
        'x-ratelimit-reset-requests': String(future),
      }), 200);
      expect(result.buckets[0]!.session!.resetsAt).toBe(future);
    });

    test('200 with complex duration "1d2h3m4s" reset → seconds correctly summed', () => {
      const result = parse(makeHeaders({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '50',
        'x-ratelimit-reset-requests': '1d2h3m4s',
      }), 200);
      // 1d + 2h + 3m + 4s = 86400 + 7200 + 180 + 4 = 93784s
      expect(result.buckets[0]!.session!.resetsAt).toBe(Math.floor(NOW_S + 93784));
    });

    test('500 → rejected (no bucket, no throw)', () => {
      const result = parse(makeHeaders({}), 500);
      expect(result.status).toBe('rejected');
      expect(result.buckets).toEqual([]);
      expect(result.provider).toBe(providerField);
    });

    test('only tokens headers present → uses tokens utilization', () => {
      const result = parse(makeHeaders({
        'x-ratelimit-limit-tokens': '1000',
        'x-ratelimit-remaining-tokens': '200',
        'x-ratelimit-reset-tokens': '60s',
      }), 200);
      expect(result.buckets[0]!.session!.utilization).toBeCloseTo(0.8, 5);
      // 0.8 triggers warning per shared status semantics
      expect(result.status).toBe('allowed_warning');
    });

    test('plain-object headers accepted (not just Headers instance)', () => {
      const result = parse({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '30',
      } as any, 200);
      expect(result.buckets[0]!.session!.utilization).toBeCloseTo(0.7, 5);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Qwen-specific: x-dashscope-* fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('Qwen parser — dashscope-prefixed fallback', () => {
  test('uses x-dashscope-* headers when standard ones absent', () => {
    const result = parseQwenRateLimitHeaders(makeHeaders({
      'x-dashscope-ratelimit-limit-requests': '500',
      'x-dashscope-ratelimit-remaining-requests': '100',
      'x-dashscope-ratelimit-reset-requests': '90s',
    }), 200);
    expect(result.buckets[0]!.session!.utilization).toBeCloseTo(0.8, 5);
    expect(result.buckets[0]!.session!.resetsAt).toBe(Math.floor(NOW_S + 90));
    expect(result.status).toBe('allowed_warning');
  });

  test('prefers standard x-ratelimit-* over dashscope-prefixed when both present', () => {
    const result = parseQwenRateLimitHeaders(makeHeaders({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '50',
      'x-dashscope-ratelimit-limit-requests': '999999',
      'x-dashscope-ratelimit-remaining-requests': '999999',
    }), 200);
    // Should use standard headers: 50% util
    expect(result.buckets[0]!.session!.utilization).toBeCloseTo(0.5, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseProviderRateLimitHeaders — dispatch table
// ─────────────────────────────────────────────────────────────────────────────

describe('parseProviderRateLimitHeaders dispatch', () => {
  const validHeaders = makeHeaders({
    'x-ratelimit-limit-requests': '100',
    'x-ratelimit-remaining-requests': '50',
  });

  test.each([
    ['kimi', 'kimi'],
    ['Kimi', 'kimi'],
    ['MOONSHOT', 'kimi'],
    ['kimi-coding', 'kimi'],
    ['qwen', 'qwen'],
    ['DASHSCOPE', 'qwen'],
    ['alibaba', 'qwen'],
    ['qwen-openai', 'qwen'],
    ['dashscope-openai', 'qwen'],
    ['deepseek', 'deepseek'],
    ['deepseek-openai', 'deepseek'],
    ['zai', 'zai'],
    ['z.ai', 'zai'],
    ['glm', 'zai'],
    ['zhipu', 'zai'],
  ])('"%s" → provider=%s', (input, expected) => {
    const result = parseProviderRateLimitHeaders(input, validHeaders, 200);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe(expected);
  });

  test('unknown provider returns null', () => {
    expect(parseProviderRateLimitHeaders('anthropic', validHeaders, 200)).toBeNull();
    expect(parseProviderRateLimitHeaders('unknown', validHeaders, 200)).toBeNull();
    expect(parseProviderRateLimitHeaders('', validHeaders, 200)).toBeNull();
  });

  test('whitespace in provider name is trimmed', () => {
    const result = parseProviderRateLimitHeaders('  kimi  ', validHeaders, 200);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('kimi');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER_PROBE_URLS — sanity check that all four providers map to URLs
// ─────────────────────────────────────────────────────────────────────────────

describe('PROVIDER_PROBE_URLS', () => {
  test('every supported provider has a probe URL', () => {
    expect(PROVIDER_PROBE_URLS.kimi).toMatch(/^https:\/\//);
    expect(PROVIDER_PROBE_URLS.qwen).toMatch(/^https:\/\//);
    expect(PROVIDER_PROBE_URLS.deepseek).toMatch(/^https:\/\//);
    expect(PROVIDER_PROBE_URLS.zai).toMatch(/^https:\/\//);
  });

  test('all URLs end with a /models path (probe endpoint convention)', () => {
    expect(PROVIDER_PROBE_URLS.kimi).toMatch(/\/models$/);
    expect(PROVIDER_PROBE_URLS.qwen).toMatch(/\/models$/);
    expect(PROVIDER_PROBE_URLS.deepseek).toMatch(/\/models$/);
    expect(PROVIDER_PROBE_URLS.zai).toMatch(/\/models$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetcher integration — mocked global fetch
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchKimiRateLimit / fetchQwenRateLimit / fetchDeepSeekRateLimit / fetchZaiRateLimit', () => {
  let mockFetch: jest.Mock;
  const realFetch = (global as any).fetch;

  beforeEach(() => {
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
  });

  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  test('Kimi: 200 with headers → allowed, calls Moonshot endpoint with Bearer token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: fullOpenAICompatHeaders200(),
      json: async () => ({ data: [] }),
    });
    const result = await fetchKimiRateLimit('sk-test-kimi');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe(PROVIDER_PROBE_URLS.kimi);
    expect((opts as any).method).toBe('GET');
    expect((opts as any).headers.Authorization).toBe('Bearer sk-test-kimi');
    expect(result!.status).toBe('allowed');
    expect(result!.provider).toBe('kimi');
  });

  test('Qwen: 429 → limit_reached', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: makeHeaders({
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '0',
      }),
      json: async () => ({ error: { message: 'rate limited' } }),
    });
    const result = await fetchQwenRateLimit('sk-test-qwen');
    expect(result!.status).toBe('limit_reached');
    expect(result!.provider).toBe('qwen');
  });

  test('DeepSeek: 401 → unauthorized with parsed error message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: makeHeaders({}),
      json: async () => ({ error: { message: 'Invalid API key' } }),
    });
    const result = await fetchDeepSeekRateLimit('sk-bad');
    expect(result!.status).toBe('unauthorized');
    expect(result!.forbiddenReason).toBe('Invalid API key');
    expect(result!.provider).toBe('deepseek');
  });

  test('Z.ai: 403 → forbidden', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: makeHeaders({}),
      json: async () => ({ error: { message: 'Region not supported' } }),
    });
    const result = await fetchZaiRateLimit('sk-test-zai');
    expect(result!.status).toBe('forbidden');
    expect(result!.provider).toBe('zai');
    expect(result!.forbiddenReason).toBe('Region not supported');
  });

  test('returns null when fetch throws (network failure / timeout)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await fetchKimiRateLimit('k')).toBeNull();
    expect(await fetchQwenRateLimit('k')).toBeNull();
    expect(await fetchDeepSeekRateLimit('k')).toBeNull();
    expect(await fetchZaiRateLimit('k')).toBeNull();
  });

  test('401 with no parseable body → forbiddenReason undefined, status still unauthorized', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: makeHeaders({}),
      json: async () => { throw new Error('not json'); },
    });
    const result = await fetchKimiRateLimit('k');
    expect(result!.status).toBe('unauthorized');
    expect(result!.forbiddenReason).toBeUndefined();
  });
});
