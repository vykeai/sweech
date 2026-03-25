"use strict";
/**
 * Team management for sweech.
 *
 * Connects a local sweech installation to a team hub (self-hosted `sweech serve`),
 * enabling shared account visibility, usage budgets, and remote lock/unlock.
 *
 * Config is stored in ~/.sweech/team.json.
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
exports.loadTeamConfig = loadTeamConfig;
exports.saveTeamConfig = saveTeamConfig;
exports.teamRequest = teamRequest;
exports.joinTeam = joinTeam;
exports.leaveTeam = leaveTeam;
exports.inviteMember = inviteMember;
exports.listMembers = listMembers;
exports.setBudget = setBudget;
exports.getBudgets = getBudgets;
exports.lockAccount = lockAccount;
exports.unlockAccount = unlockAccount;
exports.joinTeamLocal = joinTeamLocal;
exports.leaveTeamLocal = leaveTeamLocal;
exports.getLocalMembers = getLocalMembers;
exports.addLocalInvite = addLocalInvite;
exports.removeTeamConfig = removeTeamConfig;
exports.getTeamConfigPath = getTeamConfigPath;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const TEAM_CONFIG_PATH = path.join(os.homedir(), '.sweech', 'team.json');
// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------
/**
 * Read ~/.sweech/team.json.
 * Returns null when the file is missing or unparseable.
 */
function loadTeamConfig() {
    try {
        if (!fs.existsSync(TEAM_CONFIG_PATH)) {
            return null;
        }
        const raw = fs.readFileSync(TEAM_CONFIG_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Write team config to ~/.sweech/team.json.
 */
function saveTeamConfig(config) {
    fs.mkdirSync(path.dirname(TEAM_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEAM_CONFIG_PATH, JSON.stringify(config, null, 2));
}
// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
/**
 * Shared HTTP helper that reads teamConfig for hubUrl and auth.
 *
 * - Uses node:http or node:https depending on hubUrl scheme
 * - Includes Authorization header from team config (teamId)
 * - 10-second timeout
 * - Returns parsed JSON body or throws with a clear message
 */
async function teamRequest(method, apiPath, body) {
    const config = loadTeamConfig();
    if (!config) {
        throw new Error('Not connected to a team. Run `sweech team join` first.');
    }
    let baseUrl;
    try {
        // Normalise: strip trailing slash so path joining is predictable
        baseUrl = config.hubUrl.replace(/\/+$/, '');
    }
    catch {
        throw new Error(`Invalid hub URL in team config: ${config.hubUrl}`);
    }
    const url = new URL(apiPath, baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : undefined;
    const headers = {
        'Authorization': `Bearer ${config.teamId}`,
        'Accept': 'application/json',
    };
    if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    return new Promise((resolve, reject) => {
        const req = transport.request(url, { method, headers, timeout: 10000 }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString('utf-8');
                const status = res.statusCode ?? 0;
                if (status < 200 || status >= 300) {
                    let message = `Hub returned HTTP ${status}`;
                    try {
                        const parsed = JSON.parse(responseBody);
                        if (parsed.error)
                            message += `: ${parsed.error}`;
                    }
                    catch { /* use generic message */ }
                    reject(new Error(message));
                    return;
                }
                try {
                    resolve(JSON.parse(responseBody));
                }
                catch {
                    reject(new Error(`Hub returned invalid JSON (HTTP ${status})`));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request to team hub timed out after 10s (${method} ${apiPath})`));
        });
        req.on('error', (err) => {
            reject(new Error(`Team hub request failed (${method} ${apiPath}): ${err.message}`));
        });
        if (payload) {
            req.end(payload);
        }
        else {
            req.end();
        }
    });
}
// ---------------------------------------------------------------------------
// Team operations
// ---------------------------------------------------------------------------
/**
 * Join a team by invite code.
 *
 * Sends POST to hub /api/team/join with the invite code, then persists the
 * returned team config locally.
 */
async function joinTeam(inviteCode, hubUrl) {
    const normalizedUrl = hubUrl.replace(/\/+$/, '');
    const url = new URL('/api/team/join', normalizedUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify({
        inviteCode,
        machine: os.hostname(),
    });
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
        'Accept': 'application/json',
    };
    const config = await new Promise((resolve, reject) => {
        const req = transport.request(url, { method: 'POST', headers, timeout: 10000 }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                const status = res.statusCode ?? 0;
                if (status < 200 || status >= 300) {
                    let message = `Failed to join team (HTTP ${status})`;
                    try {
                        const parsed = JSON.parse(body);
                        if (parsed.error)
                            message += `: ${parsed.error}`;
                    }
                    catch { /* use generic message */ }
                    reject(new Error(message));
                    return;
                }
                try {
                    const data = JSON.parse(body);
                    resolve(data);
                }
                catch {
                    reject(new Error('Hub returned invalid JSON when joining team'));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Join request timed out after 10s (${normalizedUrl})`));
        });
        req.on('error', (err) => {
            reject(new Error(`Failed to connect to team hub: ${err.message}`));
        });
        req.end(payload);
    });
    // Persist locally
    saveTeamConfig(config);
    return config;
}
/**
 * Leave the current team.
 *
 * Notifies the hub via POST /api/team/leave, then removes local team.json.
 */
async function leaveTeam() {
    const config = loadTeamConfig();
    if (!config) {
        throw new Error('Not connected to a team.');
    }
    await teamRequest('POST', '/api/team/leave', { machine: os.hostname() });
    // Remove local config
    try {
        fs.unlinkSync(TEAM_CONFIG_PATH);
    }
    catch { /* file may already be gone */ }
}
/**
 * Invite a new member to the team (admin only).
 *
 * Sends POST to hub /api/team/invite with the target email address.
 * Returns the invite code from the hub response.
 */
async function inviteMember(email) {
    const config = loadTeamConfig();
    if (!config) {
        throw new Error('Not connected to a team.');
    }
    if (config.role !== 'admin') {
        throw new Error('Only team admins can invite members.');
    }
    return teamRequest('POST', '/api/team/invite', { email });
}
/**
 * List all members of the current team.
 */
async function listMembers() {
    return teamRequest('GET', '/api/team/members');
}
/**
 * Set a usage budget for accounts matching a pattern.
 */
async function setBudget(budget) {
    await teamRequest('POST', '/api/team/budget', budget);
}
/**
 * Get all usage budgets configured for the team.
 */
async function getBudgets() {
    return teamRequest('GET', '/api/team/budgets');
}
/**
 * Lock an account so it cannot be used.
 */
async function lockAccount(commandName) {
    await teamRequest('POST', '/api/team/lock', { commandName });
}
/**
 * Unlock a previously locked account.
 */
async function unlockAccount(commandName) {
    await teamRequest('POST', '/api/team/unlock', { commandName });
}
// ---------------------------------------------------------------------------
// Local team operations (no hub required)
// ---------------------------------------------------------------------------
/**
 * Generate a deterministic team ID from an invite code.
 * In a real system this would validate against a server; here we derive a
 * stable identifier so the same code always produces the same teamId.
 */
function deriveTeamId(code) {
    // Simple hash — not cryptographic, just needs to be deterministic
    let hash = 0;
    for (let i = 0; i < code.length; i++) {
        hash = ((hash << 5) - hash + code.charCodeAt(i)) | 0;
    }
    return `team-${Math.abs(hash).toString(36)}`;
}
/**
 * Join a team locally using an invite code.
 *
 * Creates a team config with the current machine as the sole member.
 * No hub communication is required — this is the "basic" offline join.
 */
function joinTeamLocal(code) {
    const existing = loadTeamConfig();
    if (existing) {
        throw new Error(`Already a member of team "${existing.name}". Run \`sweech team leave\` first.`);
    }
    const teamId = deriveTeamId(code);
    const now = new Date().toISOString();
    const config = {
        teamId,
        name: `team-${code.slice(0, 8)}`,
        hubUrl: '',
        role: 'admin',
        joinedAt: now,
        inviteCode: code,
        members: [
            {
                email: `${os.userInfo().username}@local`,
                name: os.userInfo().username,
                role: 'admin',
                joinedAt: now,
            },
        ],
        pendingInvites: [],
    };
    saveTeamConfig(config);
    return config;
}
/**
 * Leave the current team (local-only).
 *
 * Removes ~/.sweech/team.json. Does not contact a hub.
 */
function leaveTeamLocal() {
    const config = loadTeamConfig();
    if (!config) {
        throw new Error('Not connected to a team.');
    }
    try {
        fs.unlinkSync(TEAM_CONFIG_PATH);
    }
    catch { /* file may already be gone */ }
}
/**
 * List team members from the local config.
 */
function getLocalMembers() {
    const config = loadTeamConfig();
    if (!config) {
        throw new Error('Not connected to a team. Run `sweech team join` first.');
    }
    return config.members;
}
/**
 * Add an email to the pending invites list (local-only).
 *
 * Does not send any email — just records the intent. A future hub sync
 * or `sweech team sync` would deliver the invites.
 */
function addLocalInvite(email) {
    const config = loadTeamConfig();
    if (!config) {
        throw new Error('Not connected to a team. Run `sweech team join` first.');
    }
    if (config.pendingInvites.includes(email)) {
        throw new Error(`${email} is already in the pending invites list.`);
    }
    if (config.members.some(m => m.email === email)) {
        throw new Error(`${email} is already a team member.`);
    }
    config.pendingInvites.push(email);
    saveTeamConfig(config);
}
/**
 * Remove team config file — exposed for testing.
 */
function removeTeamConfig() {
    try {
        fs.unlinkSync(TEAM_CONFIG_PATH);
    }
    catch { /* file may already be gone */ }
}
/**
 * Get the team config path — exposed for testing.
 */
function getTeamConfigPath() {
    return TEAM_CONFIG_PATH;
}
