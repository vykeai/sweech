"use strict";
/**
 * sweech → fed integration server
 *
 * Exposes the fed contract endpoints so sweech appears in the fed dashboard:
 *   GET /fed/info    — machine metadata
 *   GET /fed/runs    — account list (sidebar/status)
 *   GET /fed/widget  — account-usage widget with 5h + 7d window data
 *
 * Start with: sweech serve [--port PORT]
 * Default fed port: 7854 (matches ~/.fed/config.json)
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSweechFedServer = createSweechFedServer;
exports.startSweechFedServer = startSweechFedServer;
const node_http_1 = __importDefault(require("node:http"));
const node_os_1 = __importDefault(require("node:os"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const subscriptions_1 = require("./subscriptions");
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    res.end(data);
}
function getMachineName() {
    return node_os_1.default.hostname().replace(/\.local$/, '').toLowerCase();
}
function getProfiles() {
    return new config_1.ConfigManager().getProfiles();
}
function createSweechFedServer(port) {
    const server = node_http_1.default.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
            res.end();
            return;
        }
        if (pathname === '/fed/info') {
            const profiles = getProfiles();
            const allAccounts = (0, subscriptions_1.getKnownAccounts)(profiles);
            sendJson(res, 200, {
                machine: getMachineName(),
                service: 'sweech',
                version: packageJson.version,
                fedPort: port,
                platform: process.platform,
                uptime: process.uptime(),
                hostname: node_os_1.default.hostname(),
                accountCount: allAccounts.length,
                capabilities: ['account-usage', 'claude-usage'],
            });
            return;
        }
        if (pathname === '/fed/runs') {
            const profiles = getProfiles();
            const accounts = await (0, subscriptions_1.getAccountInfo)((0, subscriptions_1.getKnownAccounts)(profiles));
            sendJson(res, 200, accounts.map(a => ({
                name: a.name,
                slug: a.commandName,
                cliType: a.cliType,
                plan: a.meta.plan,
                messages5h: a.messages5h,
                messages7d: a.messages7d,
                hoursUntilWeeklyReset: a.hoursUntilWeeklyReset,
                lastActive: a.lastActive,
            })));
            return;
        }
        if (pathname === '/fed/widget') {
            const profiles = getProfiles();
            const accounts = await (0, subscriptions_1.getAccountInfo)((0, subscriptions_1.getKnownAccounts)(profiles));
            sendJson(res, 200, {
                type: 'account-usage',
                title: 'sweech',
                emoji: '🍭',
                data: {
                    accounts: accounts.map(a => ({
                        name: a.name,
                        cliType: a.cliType,
                        plan: a.meta.plan,
                        limits: a.meta.limits,
                        messages5h: a.messages5h,
                        messages7d: a.messages7d,
                        minutesUntilFirstCapacity: a.minutesUntilFirstCapacity,
                        weeklyResetAt: a.weeklyResetAt,
                        hoursUntilWeeklyReset: a.hoursUntilWeeklyReset,
                        lastActive: a.lastActive,
                        live: a.live,
                    })),
                },
            });
            return;
        }
        sendJson(res, 404, { error: 'Not found' });
    });
    return server;
}
async function startSweechFedServer(port) {
    const server = createSweechFedServer(port);
    await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '0.0.0.0', resolve);
    });
    return server;
}
