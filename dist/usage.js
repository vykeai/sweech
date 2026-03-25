"use strict";
/**
 * Usage tracking for sweetch profiles
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
exports.UsageTracker = void 0;
exports.summarizeAccountsForTelemetry = summarizeAccountsForTelemetry;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
class UsageTracker {
    constructor() {
        const configDir = path.join(os.homedir(), '.sweech');
        this.usageFile = path.join(configDir, 'usage.json');
    }
    logUsage(commandName) {
        const records = this.getRecords();
        records.push({
            commandName,
            timestamp: new Date().toISOString()
        });
        // Keep last 1000 records
        const trimmed = records.slice(-1000);
        fs.writeFileSync(this.usageFile, JSON.stringify(trimmed, null, 2));
    }
    getStats(commandName) {
        const records = this.getRecords();
        // Group by command name
        const grouped = new Map();
        records.forEach(record => {
            if (commandName && record.commandName !== commandName) {
                return;
            }
            const existing = grouped.get(record.commandName) || [];
            existing.push(record);
            grouped.set(record.commandName, existing);
        });
        // Calculate stats
        const stats = [];
        grouped.forEach((records, cmdName) => {
            const sorted = records.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            stats.push({
                commandName: cmdName,
                totalUses: records.length,
                firstUsed: sorted[0].timestamp,
                lastUsed: sorted[sorted.length - 1].timestamp,
                recentUses: sorted.slice(-10).map(r => r.timestamp)
            });
        });
        return stats.sort((a, b) => b.totalUses - a.totalUses);
    }
    clearStats(commandName) {
        if (!commandName) {
            fs.writeFileSync(this.usageFile, JSON.stringify([], null, 2));
            return;
        }
        const records = this.getRecords().filter(r => r.commandName !== commandName);
        fs.writeFileSync(this.usageFile, JSON.stringify(records, null, 2));
    }
    getRecords() {
        if (!fs.existsSync(this.usageFile)) {
            return [];
        }
        try {
            const data = fs.readFileSync(this.usageFile, 'utf-8');
            return JSON.parse(data);
        }
        catch {
            return [];
        }
    }
}
exports.UsageTracker = UsageTracker;
function summarizeAccountsForTelemetry(accounts) {
    const available = accounts.filter((account) => !account.needsReauth && account.live?.status !== 'limit_reached');
    return {
        totalAccounts: accounts.length,
        availableAccounts: available.length,
        limitedAccounts: accounts.filter((account) => account.live?.status === 'limit_reached').length,
        accountsNeedingReauth: accounts.filter((account) => account.needsReauth).length,
        recommendedAccount: available[0]?.commandName,
    };
}
