/**
 * Event-driven webhook notifications for sweech.
 *
 * Loads webhook configurations from ~/.sweech/webhooks.json and dispatches
 * HTTP POST requests when matching internal events fire on the sweech event bus.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';
import * as http from 'node:http';
import { createHmac } from 'node:crypto';
import { sweechEvents } from './events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookConfig {
  url: string;
  events: string[];
  secret?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const WEBHOOKS_PATH = path.join(os.homedir(), '.sweech', 'webhooks.json');

/**
 * Read and parse ~/.sweech/webhooks.json.
 * Returns an empty array when the file is missing or unparseable.
 */
export function loadWebhookConfig(): WebhookConfig[] {
  try {
    if (!fs.existsSync(WEBHOOKS_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(WEBHOOKS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('[sweech-webhook] webhooks.json must be a JSON array');
      return [];
    }
    return parsed as WebhookConfig[];
  } catch (err) {
    console.error(`[sweech-webhook] failed to load ${WEBHOOKS_PATH}:`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget HTTP POST to a single webhook endpoint.
 *
 * - Body is JSON: `{ event, payload, timestamp, service: 'sweech' }`
 * - If `config.secret` is set, an HMAC-SHA256 signature of the body is sent
 *   in the `X-Sweech-Signature` header.
 * - 10-second timeout; errors are logged to stderr but never thrown.
 */
export function sendWebhook(
  config: WebhookConfig,
  event: string,
  payload: object,
): void {
  const body = JSON.stringify({
    event,
    payload,
    timestamp: new Date().toISOString(),
    service: 'sweech',
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString(),
  };

  if (config.secret) {
    const signature = createHmac('sha256', config.secret)
      .update(body)
      .digest('hex');
    headers['X-Sweech-Signature'] = signature;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(config.url);
  } catch {
    console.error(
      `[sweech-webhook] invalid URL for webhook${config.name ? ` "${config.name}"` : ''}: ${config.url}`,
    );
    return;
  }

  const transport = parsedUrl.protocol === 'https:' ? https : http;

  const req = transport.request(
    parsedUrl,
    { method: 'POST', headers, timeout: 10_000 },
    (res) => {
      // Consume the response so the socket is released.
      res.resume();
    },
  );

  req.on('timeout', () => {
    req.destroy();
    console.error(
      `[sweech-webhook] request timed out for webhook${config.name ? ` "${config.name}"` : ''} (${config.url})`,
    );
  });

  req.on('error', (err) => {
    console.error(
      `[sweech-webhook] request failed for webhook${config.name ? ` "${config.name}"` : ''} (${config.url}):`,
      err.message,
    );
  });

  req.end(body);
}

// ---------------------------------------------------------------------------
// Dispatching
// ---------------------------------------------------------------------------

/**
 * Load all webhook configs, filter to those subscribing to `event`, and send
 * the payload to every match.
 */
export function dispatchEvent(event: string, payload: object): void {
  const configs = loadWebhookConfig();
  const matching = configs.filter((c) => c.events.includes(event));

  for (const config of matching) {
    sendWebhook(config, event, payload);
  }
}

// ---------------------------------------------------------------------------
// Event-bus integration
// ---------------------------------------------------------------------------

const WEBHOOK_EVENTS = [
  'limit_reached',
  'capacity_available',
  'token_expired',
] as const;

/**
 * Subscribe to the sweech event bus and automatically dispatch webhooks for
 * `limit_reached`, `capacity_available`, and `token_expired` events.
 */
export function registerWebhookListeners(): void {
  for (const event of WEBHOOK_EVENTS) {
    sweechEvents.on(event, (data) => {
      dispatchEvent(event, data as object);
    });
  }
}
