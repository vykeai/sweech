"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadWebhookConfig = loadWebhookConfig;
exports.matchesEvent = matchesEvent;
exports.buildWebhookBody = buildWebhookBody;
exports.buildHeaders = buildHeaders;
exports.deliverWebhook = deliverWebhook;
exports.getDeliveryLog = getDeliveryLog;
exports.clearDeliveryLog = clearDeliveryLog;
exports.sendWebhook = sendWebhook;
exports.dispatchEvent = dispatchEvent;
exports.registerWebhookListeners = registerWebhookListeners;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const https = __importStar(require("node:https"));
const http = __importStar(require("node:http"));
const node_crypto_1 = require("node:crypto");
const events_1 = require("./events");
// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------
const WEBHOOKS_PATH = path.join(os.homedir(), '.sweech', 'webhooks.json');
/**
 * Read and parse ~/.sweech/webhooks.json.
 * Returns an empty array when the file is missing or unparseable.
 */
function loadWebhookConfig(filePath) {
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
        return parsed.filter((entry) => {
            if (typeof entry !== 'object' || entry === null)
                return false;
            const obj = entry;
            if (typeof obj.url !== 'string' || !obj.url)
                return false;
            if (!Array.isArray(obj.events))
                return false;
            return true;
        });
    }
    catch (err) {
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
function matchesEvent(config, event) {
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
function buildWebhookBody(event, payload) {
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
function buildHeaders(body, secret) {
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
        'User-Agent': 'sweech-webhook/1.0',
    };
    if (secret) {
        const signature = (0, node_crypto_1.createHmac)('sha256', secret)
            .update(body)
            .digest('hex');
        headers['X-Sweech-Signature'] = signature;
    }
    return headers;
}
/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Send a single HTTP POST request. Returns a promise that resolves with the
 * status code on success, or rejects on error/timeout.
 */
function httpPost(url, headers, body, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
            res.resume(); // consume response to release socket
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) {
                resolve(code);
            }
            else {
                reject(new Error(`HTTP ${code}`));
            }
        });
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
async function deliverWebhook(config, event, payload, maxRetries = DEFAULT_MAX_RETRIES) {
    const body = buildWebhookBody(event, payload);
    const headers = buildHeaders(body, config.secret);
    let parsedUrl;
    try {
        parsedUrl = new URL(config.url);
    }
    catch {
        const msg = `invalid URL for webhook${config.name ? ` "${config.name}"` : ''}: ${config.url}`;
        console.error(`[sweech-webhook] ${msg}`);
        return { success: false, attempts: 0, error: msg };
    }
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const statusCode = await httpPost(parsedUrl, headers, body);
            return { success: true, attempts: attempt, statusCode };
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (attempt < maxRetries) {
                // Exponential backoff: 1s, 2s, 4s, ...
                const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                await sleep(delay);
            }
            else {
                console.error(`[sweech-webhook] delivery failed after ${maxRetries} attempts for` +
                    `${config.name ? ` "${config.name}"` : ''} (${config.url}): ${errMsg}`);
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
const deliveryLog = [];
function logDelivery(record) {
    deliveryLog.push(record);
    if (deliveryLog.length > MAX_LOG_ENTRIES) {
        deliveryLog.shift();
    }
}
/**
 * Get recent delivery records (most recent first).
 */
function getDeliveryLog() {
    return [...deliveryLog].reverse();
}
/**
 * Clear the delivery log (useful for testing).
 */
function clearDeliveryLog() {
    deliveryLog.length = 0;
}
// ---------------------------------------------------------------------------
// Legacy fire-and-forget send (kept for backwards compatibility)
// ---------------------------------------------------------------------------
/**
 * Fire-and-forget HTTP POST to a single webhook endpoint.
 * @deprecated Use deliverWebhook() for retry support. Kept for backwards compat.
 */
function sendWebhook(config, event, payload) {
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
async function dispatchEvent(event, payload) {
    const configs = loadWebhookConfig();
    const matching = configs.filter((c) => matchesEvent(c, event));
    const results = await Promise.all(matching.map(async (config) => {
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
    }));
    return results;
}
// ---------------------------------------------------------------------------
// Event-bus integration
// ---------------------------------------------------------------------------
const WEBHOOK_EVENTS = [
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
function registerWebhookListeners() {
    for (const event of WEBHOOK_EVENTS) {
        events_1.sweechEvents.on(event, (data) => {
            dispatchEvent(event, data).catch(() => {
                // Never let webhook delivery crash the process
            });
        });
    }
}
