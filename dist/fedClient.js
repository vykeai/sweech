"use strict";
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
exports.loadFedPeers = loadFedPeers;
exports.saveFedPeers = saveFedPeers;
exports.addPeer = addPeer;
exports.updatePeerLastSeen = updatePeerLastSeen;
exports.removePeer = removePeer;
exports.fetchPeerInfo = fetchPeerInfo;
exports.fetchPeerRuns = fetchPeerRuns;
exports.fetchPeerWidget = fetchPeerWidget;
exports.fetchPeerHealth = fetchPeerHealth;
exports.aggregateAllPeers = aggregateAllPeers;
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const config_1 = require("./config");
const subscriptions_1 = require("./subscriptions");
// ── Config paths ──────────────────────────────────────────────────────────────
const FED_PEERS_FILE = path.join(os.homedir(), '.sweech', 'peers.json');
// Legacy path for backwards compatibility
const LEGACY_PEERS_FILE = path.join(os.homedir(), '.sweech', 'fed-peers.json');
// ── Peer config management ────────────────────────────────────────────────────
function loadFedPeers() {
    try {
        const raw = fs.readFileSync(FED_PEERS_FILE, 'utf-8');
        const peers = JSON.parse(raw);
        // Backfill addedAt for legacy entries
        return peers.map(p => ({ ...p, addedAt: p.addedAt || new Date().toISOString() }));
    }
    catch {
        // Migrate from legacy fed-peers.json if it exists
        try {
            const legacyRaw = fs.readFileSync(LEGACY_PEERS_FILE, 'utf-8');
            const legacyPeers = JSON.parse(legacyRaw);
            const migrated = legacyPeers.map(p => ({ ...p, addedAt: p.addedAt || new Date().toISOString() }));
            // Save to new location
            saveFedPeers(migrated);
            return migrated;
        }
        catch {
            return [];
        }
    }
}
function saveFedPeers(peers) {
    fs.mkdirSync(path.dirname(FED_PEERS_FILE), { recursive: true });
    fs.writeFileSync(FED_PEERS_FILE, JSON.stringify(peers, null, 2));
}
function addPeer(peer) {
    const peers = loadFedPeers();
    const existing = peers.findIndex(p => p.name === peer.name);
    if (existing !== -1) {
        peers[existing] = { ...peer, addedAt: peers[existing].addedAt || peer.addedAt || new Date().toISOString() };
    }
    else {
        peers.push({ ...peer, addedAt: peer.addedAt || new Date().toISOString() });
    }
    saveFedPeers(peers);
}
/**
 * Update the lastSeen timestamp for a peer after a successful health check.
 */
function updatePeerLastSeen(name) {
    const peers = loadFedPeers();
    const peer = peers.find(p => p.name === name);
    if (peer) {
        peer.lastSeen = new Date().toISOString();
        saveFedPeers(peers);
    }
}
function removePeer(name) {
    const peers = loadFedPeers().filter(p => p.name !== name);
    saveFedPeers(peers);
}
// ── HTTP helper ───────────────────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = 5000;
function fetchJson(peer, urlPath) {
    return new Promise(resolve => {
        const protocol = peer.port === 443 ? https : http;
        const headers = { 'Accept': 'application/json' };
        if (peer.secret) {
            headers['Authorization'] = `Bearer ${peer.secret}`;
        }
        const req = protocol.request({
            hostname: peer.host,
            port: peer.port,
            path: urlPath,
            method: 'GET',
            headers,
            timeout: REQUEST_TIMEOUT_MS,
        }, res => {
            let data = '';
            res.on('data', (chunk) => { data += chunk.toString(); });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    resolve(null);
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
        req.on('error', () => {
            resolve(null);
        });
        req.end();
    });
}
// ── Peer fetch functions ──────────────────────────────────────────────────────
async function fetchPeerInfo(peer) {
    return fetchJson(peer, '/fed/info');
}
async function fetchPeerRuns(peer) {
    return fetchJson(peer, '/fed/runs');
}
async function fetchPeerWidget(peer) {
    return fetchJson(peer, '/fed/widget');
}
async function fetchPeerHealth(peer) {
    const start = Date.now();
    const result = await fetchJson(peer, '/healthz');
    const latencyMs = Date.now() - start;
    if (result === null)
        return null;
    const body = result;
    return { ok: body.status === 'ok', latencyMs };
}
// ── Aggregation ───────────────────────────────────────────────────────────────
function getMachineName() {
    return os.hostname().replace(/\.local$/, '').toLowerCase();
}
async function aggregateAllPeers() {
    const peers = loadFedPeers();
    const machineName = getMachineName();
    // Fetch local accounts
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const localAccounts = await (0, subscriptions_1.getAccountInfo)((0, subscriptions_1.getKnownAccounts)(profiles));
    const mergedAccounts = localAccounts.map(a => ({
        machine: machineName,
        name: a.name,
        slug: a.commandName,
        cliType: a.cliType,
        plan: a.meta.plan,
        messages5h: a.messages5h,
        messages7d: a.messages7d,
        hoursUntilWeeklyReset: a.hoursUntilWeeklyReset,
        lastActive: a.lastActive,
    }));
    const peerStatuses = [];
    // Fetch from all peers in parallel
    const results = await Promise.all(peers.map(async (peer) => {
        const start = Date.now();
        const runs = await fetchPeerRuns(peer);
        const latencyMs = Date.now() - start;
        if (runs === null || !Array.isArray(runs)) {
            return {
                peer,
                status: 'error',
                latencyMs,
                accounts: [],
            };
        }
        const accounts = runs.map((r) => ({
            machine: peer.name,
            name: r.name ?? '',
            slug: r.slug ?? '',
            cliType: r.cliType ?? 'claude',
            plan: r.plan,
            messages5h: r.messages5h ?? 0,
            messages7d: r.messages7d ?? 0,
            hoursUntilWeeklyReset: r.hoursUntilWeeklyReset,
            lastActive: r.lastActive,
        }));
        return { peer, status: 'ok', latencyMs, accounts };
    }));
    for (const r of results) {
        peerStatuses.push({ name: r.peer.name, status: r.status, latencyMs: r.latencyMs });
        mergedAccounts.push(...r.accounts);
    }
    return { accounts: mergedAccounts, peers: peerStatuses };
}
