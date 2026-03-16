"use strict";
/**
 * Event-driven webhook notifications for sweech.
 *
 * Loads webhook configurations from ~/.sweech/webhooks.json and dispatches
 * HTTP POST requests when matching internal events fire on the sweech event bus.
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
function loadWebhookConfig() {
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
        return parsed;
    }
    catch (err) {
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
function sendWebhook(config, event, payload) {
    const body = JSON.stringify({
        event,
        payload,
        timestamp: new Date().toISOString(),
        service: 'sweech',
    });
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
    };
    if (config.secret) {
        const signature = (0, node_crypto_1.createHmac)('sha256', config.secret)
            .update(body)
            .digest('hex');
        headers['X-Sweech-Signature'] = signature;
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(config.url);
    }
    catch {
        console.error(`[sweech-webhook] invalid URL for webhook${config.name ? ` "${config.name}"` : ''}: ${config.url}`);
        return;
    }
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request(parsedUrl, { method: 'POST', headers, timeout: 10000 }, (res) => {
        // Consume the response so the socket is released.
        res.resume();
    });
    req.on('timeout', () => {
        req.destroy();
        console.error(`[sweech-webhook] request timed out for webhook${config.name ? ` "${config.name}"` : ''} (${config.url})`);
    });
    req.on('error', (err) => {
        console.error(`[sweech-webhook] request failed for webhook${config.name ? ` "${config.name}"` : ''} (${config.url}):`, err.message);
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
function dispatchEvent(event, payload) {
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
];
/**
 * Subscribe to the sweech event bus and automatically dispatch webhooks for
 * `limit_reached`, `capacity_available`, and `token_expired` events.
 */
function registerWebhookListeners() {
    for (const event of WEBHOOK_EVENTS) {
        events_1.sweechEvents.on(event, (data) => {
            dispatchEvent(event, data);
        });
    }
}
