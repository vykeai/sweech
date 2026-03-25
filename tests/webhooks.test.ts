/**
 * Tests for the webhook event system.
 *
 * Covers:
 * - Config loading (valid, missing file, malformed, validation)
 * - Event matching (exact match, wildcard, no match)
 * - Webhook delivery (mock HTTP, verify POST body, headers, HMAC)
 * - Retry logic (failures then success, all failures)
 * - Event filtering (only delivers for subscribed events)
 * - Delivery log (records, ring buffer)
 * - Event bus integration (registerWebhookListeners)
 * - Usage monitor (threshold crossing, limit reached/recovered)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { createHmac } from 'node:crypto';

// We need to mock fs before importing the modules under test
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs') as typeof fs;
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readFileSync: jest.fn(actual.readFileSync),
    mkdirSync: jest.fn(),
    writeFileSync: jest.fn(),
  };
});

import {
  loadWebhookConfig,
  matchesEvent,
  buildWebhookBody,
  buildHeaders,
  deliverWebhook,
  dispatchEvent,
  getDeliveryLog,
  clearDeliveryLog,
  registerWebhookListeners,
  type WebhookConfig,
  type DeliverWebhookResult,
} from '../src/webhooks';

import { sweechEvents } from '../src/events';
import {
  checkUsageThresholds,
  resetAllState,
  resetAccountState,
} from '../src/usageMonitor';
import type { LiveRateLimitData } from '../src/liveUsage';

const mockedFs = jest.mocked(fs);

// ---------------------------------------------------------------------------
// Test HTTP server for delivery tests
// ---------------------------------------------------------------------------

let testServer: http.Server;
let testPort: number;
let serverRequests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;
let serverResponder: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  serverRequests = [];
  serverResponder = (_req, res) => {
    res.writeHead(200);
    res.end('ok');
  };

  testServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      serverRequests.push({ body, headers: req.headers });
      serverResponder(req, res);
    });
  });

  await new Promise<void>((resolve) => {
    testServer.listen(0, '127.0.0.1', () => {
      const addr = testServer.address();
      testPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    testServer.close(() => resolve());
  });
});

beforeEach(() => {
  serverRequests = [];
  serverResponder = (_req, res) => {
    res.writeHead(200);
    res.end('ok');
  };
  clearDeliveryLog();
  resetAllState();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe('loadWebhookConfig', () => {
  afterEach(() => {
    mockedFs.existsSync.mockRestore?.();
    mockedFs.readFileSync.mockRestore?.();
  });

  it('returns empty array when file does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false);
    const result = loadWebhookConfig('/nonexistent/webhooks.json');
    expect(result).toEqual([]);
  });

  it('loads valid webhook config array', () => {
    const config: WebhookConfig[] = [
      { url: 'https://example.com/hook', events: ['limit_reached'], name: 'test-hook' },
      { url: 'https://other.com/hook', events: ['*'], secret: 'my-secret' },
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));

    const result = loadWebhookConfig('/mock/webhooks.json');
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe('https://example.com/hook');
    expect(result[1].events).toEqual(['*']);
  });

  it('returns empty array for non-array JSON', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ url: 'bad' }));

    const spy = jest.spyOn(console, 'error').mockImplementation();
    const result = loadWebhookConfig('/mock/webhooks.json');
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('must be a JSON array'));
    spy.mockRestore();
  });

  it('returns empty array for malformed JSON', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('not json at all{{{');

    const spy = jest.spyOn(console, 'error').mockImplementation();
    const result = loadWebhookConfig('/mock/webhooks.json');
    expect(result).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('filters out entries missing url', () => {
    const config = [
      { url: 'https://valid.com/hook', events: ['*'] },
      { events: ['limit_reached'] },  // no url
      { url: '', events: ['*'] },     // empty url
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));

    const result = loadWebhookConfig('/mock/webhooks.json');
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://valid.com/hook');
  });

  it('filters out entries missing events array', () => {
    const config = [
      { url: 'https://valid.com/hook', events: ['*'] },
      { url: 'https://bad.com/hook' },               // no events
      { url: 'https://bad2.com/hook', events: 'all' }, // events not array
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(config));

    const result = loadWebhookConfig('/mock/webhooks.json');
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

describe('matchesEvent', () => {
  it('matches exact event name', () => {
    const config: WebhookConfig = { url: 'https://x.com', events: ['limit_reached', 'profile_switch'] };
    expect(matchesEvent(config, 'limit_reached')).toBe(true);
    expect(matchesEvent(config, 'profile_switch')).toBe(true);
  });

  it('does not match unsubscribed event', () => {
    const config: WebhookConfig = { url: 'https://x.com', events: ['limit_reached'] };
    expect(matchesEvent(config, 'profile_switch')).toBe(false);
    expect(matchesEvent(config, 'usage_threshold')).toBe(false);
  });

  it('wildcard matches all events', () => {
    const config: WebhookConfig = { url: 'https://x.com', events: ['*'] };
    expect(matchesEvent(config, 'limit_reached')).toBe(true);
    expect(matchesEvent(config, 'profile_switch')).toBe(true);
    expect(matchesEvent(config, 'usage_threshold')).toBe(true);
    expect(matchesEvent(config, 'anything_at_all')).toBe(true);
  });

  it('empty events matches nothing', () => {
    const config: WebhookConfig = { url: 'https://x.com', events: [] };
    expect(matchesEvent(config, 'limit_reached')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Body and header building
// ---------------------------------------------------------------------------

describe('buildWebhookBody', () => {
  it('produces valid JSON with expected fields', () => {
    const body = buildWebhookBody('limit_reached', { account: 'test' });
    const parsed = JSON.parse(body);
    expect(parsed.event).toBe('limit_reached');
    expect(parsed.payload).toEqual({ account: 'test' });
    expect(parsed.service).toBe('sweech');
    expect(parsed.timestamp).toBeDefined();
  });
});

describe('buildHeaders', () => {
  it('includes content-type and user-agent', () => {
    const headers = buildHeaders('{"test":true}');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBe('sweech-webhook/1.0');
    expect(headers['Content-Length']).toBeDefined();
  });

  it('does not include signature when no secret', () => {
    const headers = buildHeaders('{"test":true}');
    expect(headers['X-Sweech-Signature']).toBeUndefined();
  });

  it('includes HMAC signature when secret is provided', () => {
    const body = '{"test":true}';
    const secret = 'my-secret-key';
    const headers = buildHeaders(body, secret);

    expect(headers['X-Sweech-Signature']).toBeDefined();

    // Verify the signature is correct
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(headers['X-Sweech-Signature']).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

describe('deliverWebhook', () => {
  it('delivers successfully on first attempt', async () => {
    const config: WebhookConfig = {
      url: `http://127.0.0.1:${testPort}/hook`,
      events: ['*'],
      name: 'test',
    };

    const result = await deliverWebhook(config, 'profile_switch', { account: 'claude-main' }, 1);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.statusCode).toBe(200);

    // Verify the server received the correct body
    expect(serverRequests).toHaveLength(1);
    const received = JSON.parse(serverRequests[0].body);
    expect(received.event).toBe('profile_switch');
    expect(received.payload.account).toBe('claude-main');
    expect(received.service).toBe('sweech');
  });

  it('includes HMAC signature when secret is configured', async () => {
    const config: WebhookConfig = {
      url: `http://127.0.0.1:${testPort}/hook`,
      events: ['*'],
      secret: 'test-secret-123',
    };

    const result = await deliverWebhook(config, 'test', { data: 1 }, 1);
    expect(result.success).toBe(true);

    const sig = serverRequests[0].headers['x-sweech-signature'];
    expect(sig).toBeDefined();

    // Verify signature matches
    const body = serverRequests[0].body;
    const expected = createHmac('sha256', 'test-secret-123').update(body).digest('hex');
    expect(sig).toBe(expected);
  });

  it('retries on failure and succeeds', async () => {
    let callCount = 0;
    serverResponder = (_req, res) => {
      callCount++;
      if (callCount < 3) {
        res.writeHead(500);
        res.end('error');
      } else {
        res.writeHead(200);
        res.end('ok');
      }
    };

    const config: WebhookConfig = {
      url: `http://127.0.0.1:${testPort}/hook`,
      events: ['*'],
      name: 'retry-test',
    };

    const result = await deliverWebhook(config, 'limit_reached', { account: 'test' }, 3);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
    expect(serverRequests).toHaveLength(3);
  });

  it('fails after all retries exhausted', async () => {
    serverResponder = (_req, res) => {
      res.writeHead(500);
      res.end('server error');
    };

    const spy = jest.spyOn(console, 'error').mockImplementation();
    const config: WebhookConfig = {
      url: `http://127.0.0.1:${testPort}/hook`,
      events: ['*'],
      name: 'fail-test',
    };

    const result = await deliverWebhook(config, 'limit_reached', { account: 'test' }, 3);
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toContain('HTTP 500');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns error for invalid URL', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    const config: WebhookConfig = {
      url: 'not-a-valid-url',
      events: ['*'],
      name: 'bad-url',
    };

    const result = await deliverWebhook(config, 'test', {}, 1);
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(0);
    expect(result.error).toContain('invalid URL');
    spy.mockRestore();
  });

  it('fails for connection refused', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    const config: WebhookConfig = {
      url: 'http://127.0.0.1:1/nonexistent',
      events: ['*'],
    };

    const result = await deliverWebhook(config, 'test', {}, 1);
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toBeDefined();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Dispatch (config + matching + delivery)
// ---------------------------------------------------------------------------

describe('dispatchEvent', () => {
  beforeEach(() => {
    // Mock loadWebhookConfig to return test configs pointing at our test server
    mockedFs.existsSync.mockReturnValue(true);
  });

  it('delivers to matching webhooks only', async () => {
    const configs: WebhookConfig[] = [
      { url: `http://127.0.0.1:${testPort}/a`, events: ['limit_reached'], name: 'a' },
      { url: `http://127.0.0.1:${testPort}/b`, events: ['profile_switch'], name: 'b' },
      { url: `http://127.0.0.1:${testPort}/c`, events: ['*'], name: 'c' },
    ];
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));

    const results = await dispatchEvent('limit_reached', { account: 'test' });
    // Should match 'a' (exact) and 'c' (wildcard), not 'b'
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);

    // Verify server got 2 requests
    expect(serverRequests).toHaveLength(2);
  });

  it('delivers to no webhooks when none match', async () => {
    const configs: WebhookConfig[] = [
      { url: `http://127.0.0.1:${testPort}/a`, events: ['profile_switch'], name: 'a' },
    ];
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));

    const results = await dispatchEvent('limit_reached', { account: 'test' });
    expect(results).toHaveLength(0);
    expect(serverRequests).toHaveLength(0);
  });

  it('records deliveries in the log', async () => {
    const configs: WebhookConfig[] = [
      { url: `http://127.0.0.1:${testPort}/a`, events: ['*'], name: 'log-test' },
    ];
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));

    await dispatchEvent('profile_switch', { account: 'test' });

    const log = getDeliveryLog();
    expect(log).toHaveLength(1);
    expect(log[0].event).toBe('profile_switch');
    expect(log[0].status).toBe('success');
    expect(log[0].attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------

describe('delivery log', () => {
  it('stores and retrieves records in reverse order', async () => {
    const configs: WebhookConfig[] = [
      { url: `http://127.0.0.1:${testPort}/a`, events: ['*'] },
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));

    await dispatchEvent('event_1', {});
    await dispatchEvent('event_2', {});

    const log = getDeliveryLog();
    expect(log).toHaveLength(2);
    // Most recent first
    expect(log[0].event).toBe('event_2');
    expect(log[1].event).toBe('event_1');
  });

  it('clearDeliveryLog empties the log', async () => {
    const configs: WebhookConfig[] = [
      { url: `http://127.0.0.1:${testPort}/a`, events: ['*'] },
    ];
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));

    await dispatchEvent('test', {});
    expect(getDeliveryLog()).toHaveLength(1);

    clearDeliveryLog();
    expect(getDeliveryLog()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Event bus integration
// ---------------------------------------------------------------------------

describe('registerWebhookListeners', () => {
  it('subscribes to webhook-eligible events on the event bus', () => {
    const spy = jest.spyOn(sweechEvents, 'on');
    registerWebhookListeners();

    const subscribedEvents = spy.mock.calls.map(c => c[0]);
    expect(subscribedEvents).toContain('profile_switch');
    expect(subscribedEvents).toContain('limit_reached');
    expect(subscribedEvents).toContain('limit_recovered');
    expect(subscribedEvents).toContain('usage_threshold');
    expect(subscribedEvents).toContain('capacity_available');
    expect(subscribedEvents).toContain('token_expired');
    expect(subscribedEvents).toContain('token_refreshed');

    spy.mockRestore();
    // Clean up listeners we just added
    sweechEvents.removeAllListeners();
  });
});

// ---------------------------------------------------------------------------
// Usage monitor — threshold crossings
// ---------------------------------------------------------------------------

describe('checkUsageThresholds', () => {
  function makeLive(session5h: number, weekly7d: number): LiveRateLimitData {
    return {
      buckets: [{
        label: 'All models',
        session: { utilization: session5h / 100 },
        weekly: { utilization: weekly7d / 100 },
      }],
      capturedAt: Date.now(),
    };
  }

  beforeEach(() => {
    resetAllState();
  });

  it('emits usage_threshold at 70% (5h)', () => {
    const events: Array<{ threshold: number; window: string }> = [];
    sweechEvents.on('usage_threshold', (data) => {
      events.push({ threshold: data.threshold, window: data.window });
    });

    checkUsageThresholds('acct-1', makeLive(75, 50));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ threshold: 70, window: '5h' });

    sweechEvents.removeAllListeners('usage_threshold');
  });

  it('emits usage_threshold at 90% (7d)', () => {
    const events: Array<{ threshold: number; window: string }> = [];
    sweechEvents.on('usage_threshold', (data) => {
      events.push({ threshold: data.threshold, window: data.window });
    });

    checkUsageThresholds('acct-1', makeLive(50, 92));

    // Should fire 70 + 90 for 7d
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ threshold: 70, window: '7d' });
    expect(events[1]).toEqual({ threshold: 90, window: '7d' });

    sweechEvents.removeAllListeners('usage_threshold');
  });

  it('does not re-emit threshold on subsequent calls at same level', () => {
    const events: Array<{ threshold: number }> = [];
    sweechEvents.on('usage_threshold', (data) => {
      events.push({ threshold: data.threshold });
    });

    checkUsageThresholds('acct-1', makeLive(75, 50));
    checkUsageThresholds('acct-1', makeLive(78, 50));  // still above 70, below 90

    // Should only fire once for the 70% threshold
    expect(events).toHaveLength(1);

    sweechEvents.removeAllListeners('usage_threshold');
  });

  it('re-emits threshold after dropping below and crossing again', () => {
    const events: Array<{ threshold: number; window: string }> = [];
    sweechEvents.on('usage_threshold', (data) => {
      events.push({ threshold: data.threshold, window: data.window });
    });

    // Cross 70
    checkUsageThresholds('acct-1', makeLive(75, 50));
    expect(events).toHaveLength(1);

    // Drop below 70
    checkUsageThresholds('acct-1', makeLive(60, 50));
    // No new threshold event, but internal state reset

    // Cross 70 again
    checkUsageThresholds('acct-1', makeLive(72, 50));
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ threshold: 70, window: '5h' });

    sweechEvents.removeAllListeners('usage_threshold');
  });

  it('emits limit_reached at 100%', () => {
    const events: Array<{ account: string; window: string }> = [];
    sweechEvents.on('limit_reached', (data) => {
      events.push({ account: data.account, window: data.window });
    });

    checkUsageThresholds('acct-1', makeLive(100, 50));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ account: 'acct-1', window: '5h' });

    sweechEvents.removeAllListeners('limit_reached');
  });

  it('emits limit_recovered when dropping below 100%', () => {
    const recovered: Array<{ account: string; window: string }> = [];
    sweechEvents.on('limit_recovered', (data) => {
      recovered.push({ account: data.account, window: data.window });
    });

    // Hit limit
    checkUsageThresholds('acct-1', makeLive(100, 50));
    expect(recovered).toHaveLength(0);

    // Recover
    checkUsageThresholds('acct-1', makeLive(80, 50));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual({ account: 'acct-1', window: '5h' });

    sweechEvents.removeAllListeners('limit_recovered');
  });

  it('does not emit limit_recovered if not previously at limit', () => {
    const recovered: string[] = [];
    sweechEvents.on('limit_recovered', () => {
      recovered.push('fired');
    });

    checkUsageThresholds('acct-1', makeLive(80, 50));
    expect(recovered).toHaveLength(0);

    sweechEvents.removeAllListeners('limit_recovered');
  });

  it('handles undefined live data gracefully', () => {
    // Should not throw
    checkUsageThresholds('acct-1', undefined);
  });

  it('handles empty buckets gracefully', () => {
    checkUsageThresholds('acct-1', { buckets: [], capturedAt: Date.now() });
  });

  it('tracks state independently per account', () => {
    const events: Array<{ account: string; threshold: number }> = [];
    sweechEvents.on('usage_threshold', (data) => {
      events.push({ account: data.account, threshold: data.threshold });
    });

    checkUsageThresholds('acct-1', makeLive(75, 50));
    checkUsageThresholds('acct-2', makeLive(75, 50));

    // Both accounts should fire the 70% threshold independently
    expect(events).toHaveLength(2);
    expect(events[0].account).toBe('acct-1');
    expect(events[1].account).toBe('acct-2');

    sweechEvents.removeAllListeners('usage_threshold');
  });

  it('emits both window thresholds independently', () => {
    const events: Array<{ threshold: number; window: string }> = [];
    sweechEvents.on('usage_threshold', (data) => {
      events.push({ threshold: data.threshold, window: data.window });
    });

    // 5h at 75%, 7d at 95%
    checkUsageThresholds('acct-1', makeLive(75, 95));

    // 5h: 70% crossed. 7d: 70% + 90% crossed.
    expect(events).toHaveLength(3);
    expect(events).toContainEqual({ threshold: 70, window: '5h' });
    expect(events).toContainEqual({ threshold: 70, window: '7d' });
    expect(events).toContainEqual({ threshold: 90, window: '7d' });

    sweechEvents.removeAllListeners('usage_threshold');
  });

  it('resetAccountState clears tracked state for one account', () => {
    const events: Array<{ threshold: number }> = [];
    sweechEvents.on('usage_threshold', (data) => {
      events.push({ threshold: data.threshold });
    });

    checkUsageThresholds('acct-1', makeLive(75, 50));
    expect(events).toHaveLength(1);

    resetAccountState('acct-1');

    // Should fire again after reset
    checkUsageThresholds('acct-1', makeLive(75, 50));
    expect(events).toHaveLength(2);

    sweechEvents.removeAllListeners('usage_threshold');
  });

  it('resetAllState clears all tracked state', () => {
    const events: Array<{ account: string }> = [];
    sweechEvents.on('usage_threshold', (data) => {
      events.push({ account: data.account });
    });

    checkUsageThresholds('acct-1', makeLive(75, 50));
    checkUsageThresholds('acct-2', makeLive(75, 50));
    expect(events).toHaveLength(2);

    resetAllState();

    checkUsageThresholds('acct-1', makeLive(75, 50));
    checkUsageThresholds('acct-2', makeLive(75, 50));
    expect(events).toHaveLength(4);

    sweechEvents.removeAllListeners('usage_threshold');
  });
});
