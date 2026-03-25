/**
 * Event-driven webhook notifications for sweech.
 *
 * Loads webhook configurations from ~/.sweech/webhooks.json and dispatches
 * HTTP POST requests when matching internal events fire on the sweech event bus.
 *
 * Features:
 * - Retry with exponential backoff (3 attempts by default)
 * - Wildcard ("*") event subscription
 * - HMAC-SHA256 signature verification
 * - Delivery log for recent deliveries
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';
import * as http from 'node:http';
import { createHmac } from 'node:crypto';
import { sweechEvents, type SweechEventName } from './events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookConfig {
  url: string;
  events: string[];
  secret?: string;
  name?: string;
}

export interface DeliveryRecord {
  event: string;
  url: string;
  status: 'success' | 'failed';
  attempts: number;
  statusCode?: number;
  error?: string;
  timestamp: string;
}

export interface DeliverWebhookResult {
  success: boolean;
  attempts: number;
  statusCode?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const WEBHOOKS_PATH = path.join(os.homedir(), '.sweech', 'webhooks.json');

/**
 * Read and parse ~/.sweech/webhooks.json.
 * Returns an empty array when the file is missing or unparseable.
 */
export function loadWebhookConfig(filePath?: string): WebhookConfig[] {
  const configPath = filePath ?? WEBHOOKS_PATH;
  try {
    if (!fs.existsSync(configPath)) {
      return [];
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('[sweech-webhook] webhooks.json must be a JSON array');
      return [];
    }
    // Validate each entry has at minimum a url and events array
    return parsed.filter((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const obj = entry as Record<string, unknown>;
      if (typeof obj.url !== 'string' || !obj.url) return false;
      if (!Array.isArray(obj.events)) return false;
      return true;
    }) as WebhookConfig[];
  } catch (err) {
    console.error(`[sweech-webhook] failed to load ${configPath}:`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

/**
 * Check whether a webhook config subscribes to a given event.
 * Supports wildcard "*" to match all events.
 */
export function matchesEvent(config: WebhookConfig, event: string): boolean {
  return config.events.includes('*') || config.events.includes(event);
}

// ---------------------------------------------------------------------------
// Delivery with retry
// ---------------------------------------------------------------------------

/** Default retry configuration */
const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Build the JSON body for a webhook delivery.
 */
export function buildWebhookBody(event: string, payload: object): string {
  return JSON.stringify({
    event,
    payload,
    timestamp: new Date().toISOString(),
    service: 'sweech',
  });
}

/**
 * Build request headers, including HMAC signature if a secret is configured.
 */
export function buildHeaders(body: string, secret?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString(),
    'User-Agent': 'sweech-webhook/1.0',
  };

  if (secret) {
    const signature = createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    headers['X-Sweech-Signature'] = signature;
  }

  return headers;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a single HTTP POST request. Returns a promise that resolves with the
 * status code on success, or rejects on error/timeout.
 */
function httpPost(
  url: URL,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number = 10_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      url,
      { method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        res.resume(); // consume response to release socket
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) {
          resolve(code);
        } else {
          reject(new Error(`HTTP ${code}`));
        }
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end(body);
  });
}

/**
 * Deliver a webhook with retry logic (exponential backoff).
 *
 * @param config  - Webhook endpoint configuration
 * @param event   - Event name
 * @param payload - Event payload
 * @param maxRetries - Maximum number of attempts (default 3)
 * @returns Result with success status, attempt count, and any error
 */
export async function deliverWebhook(
  config: WebhookConfig,
  event: string,
  payload: object,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<DeliverWebhookResult> {
  const body = buildWebhookBody(event, payload);
  const headers = buildHeaders(body, config.secret);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(config.url);
  } catch {
    const msg = `invalid URL for webhook${config.name ? ` "${config.name}"` : ''}: ${config.url}`;
    console.error(`[sweech-webhook] ${msg}`);
    return { success: false, attempts: 0, error: msg };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const statusCode = await httpPost(parsedUrl, headers, body);
      return { success: true, attempts: attempt, statusCode };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s, ...
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      } else {
        console.error(
          `[sweech-webhook] delivery failed after ${maxRetries} attempts for` +
          `${config.name ? ` "${config.name}"` : ''} (${config.url}): ${errMsg}`,
        );
        return { success: false, attempts: attempt, error: errMsg };
      }
    }
  }

  // Should not reach here, but TypeScript needs it
  return { success: false, attempts: maxRetries, error: 'Unknown error' };
}

// ---------------------------------------------------------------------------
// Delivery log (in-memory ring buffer)
// ---------------------------------------------------------------------------

const MAX_LOG_ENTRIES = 50;
const deliveryLog: DeliveryRecord[] = [];

function logDelivery(record: DeliveryRecord): void {
  deliveryLog.push(record);
  if (deliveryLog.length > MAX_LOG_ENTRIES) {
    deliveryLog.shift();
  }
}

/**
 * Get recent delivery records (most recent first).
 */
export function getDeliveryLog(): DeliveryRecord[] {
  return [...deliveryLog].reverse();
}

/**
 * Clear the delivery log (useful for testing).
 */
export function clearDeliveryLog(): void {
  deliveryLog.length = 0;
}

// ---------------------------------------------------------------------------
// Legacy fire-and-forget send (kept for backwards compatibility)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget HTTP POST to a single webhook endpoint.
 * @deprecated Use deliverWebhook() for retry support. Kept for backwards compat.
 */
export function sendWebhook(
  config: WebhookConfig,
  event: string,
  payload: object,
): void {
  deliverWebhook(config, event, payload).then((result) => {
    logDelivery({
      event,
      url: config.url,
      status: result.success ? 'success' : 'failed',
      attempts: result.attempts,
      statusCode: result.statusCode,
      error: result.error,
      timestamp: new Date().toISOString(),
    });
  }).catch(() => {
    // Never let webhook delivery crash the process
  });
}

// ---------------------------------------------------------------------------
// Dispatching
// ---------------------------------------------------------------------------

/**
 * Load all webhook configs, filter to those subscribing to `event` (or "*"),
 * and deliver the payload to every match with retry.
 */
export async function dispatchEvent(event: string, payload: object): Promise<DeliverWebhookResult[]> {
  const configs = loadWebhookConfig();
  const matching = configs.filter((c) => matchesEvent(c, event));

  const results = await Promise.all(
    matching.map(async (config) => {
      const result = await deliverWebhook(config, event, payload);
      logDelivery({
        event,
        url: config.url,
        status: result.success ? 'success' : 'failed',
        attempts: result.attempts,
        statusCode: result.statusCode,
        error: result.error,
        timestamp: new Date().toISOString(),
      });
      return result;
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Event-bus integration
// ---------------------------------------------------------------------------

const WEBHOOK_EVENTS: SweechEventName[] = [
  'profile_switch',
  'limit_reached',
  'limit_recovered',
  'usage_threshold',
  'capacity_available',
  'token_expired',
  'token_refreshed',
];

/**
 * Subscribe to the sweech event bus and automatically dispatch webhooks for
 * all webhook-eligible events. Events are delivered asynchronously with retry.
 */
export function registerWebhookListeners(): void {
  for (const event of WEBHOOK_EVENTS) {
    sweechEvents.on(event, (data) => {
      dispatchEvent(event, data as object).catch(() => {
        // Never let webhook delivery crash the process
      });
    });
  }
}
