/**
 * Usage tracking for sweetch profiles
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from './atomicWrite';

export interface UsageRecord {
  commandName: string;
  timestamp: string;
}

export interface UsageStats {
  commandName: string;
  totalUses: number;
  firstUsed: string;
  lastUsed: string;
  recentUses: string[]; // Last 10 timestamps
}

export interface UsageSummary {
  totalAccounts: number;
  availableAccounts: number;
  limitedAccounts: number;
  accountsNeedingReauth: number;
  recommendedAccount?: string;
}

export class UsageTracker {
  private usageFile: string;

  constructor() {
    const configDir = path.join(os.homedir(), '.sweech');
    this.usageFile = path.join(configDir, 'usage.json');
  }

  public logUsage(commandName: string): void {
    const records = this.getRecords();
    records.push({
      commandName,
      timestamp: new Date().toISOString()
    });

    // Keep last 1000 records
    const trimmed = records.slice(-1000);
    atomicWriteFileSync(this.usageFile, JSON.stringify(trimmed, null, 2));
  }

  public getStats(commandName?: string): UsageStats[] {
    const records = this.getRecords();

    // Group by command name
    const grouped = new Map<string, UsageRecord[]>();
    records.forEach(record => {
      if (commandName && record.commandName !== commandName) {
        return;
      }
      const existing = grouped.get(record.commandName) || [];
      existing.push(record);
      grouped.set(record.commandName, existing);
    });

    // Calculate stats
    const stats: UsageStats[] = [];
    grouped.forEach((records, cmdName) => {
      const sorted = records.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

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

  public clearStats(commandName?: string): void {
    if (!commandName) {
      atomicWriteFileSync(this.usageFile, JSON.stringify([], null, 2));
      return;
    }

    const records = this.getRecords().filter(r => r.commandName !== commandName);
    atomicWriteFileSync(this.usageFile, JSON.stringify(records, null, 2));
  }

  private getRecords(): UsageRecord[] {
    if (!fs.existsSync(this.usageFile)) {
      return [];
    }

    try {
      const data = fs.readFileSync(this.usageFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
}

export function summarizeAccountsForTelemetry(
  accounts: Array<{
    commandName: string;
    needsReauth?: boolean;
    live?: { status?: string };
  }>,
): UsageSummary {
  const available = accounts.filter((account) => !account.needsReauth && account.live?.status !== 'limit_reached');
  return {
    totalAccounts: accounts.length,
    availableAccounts: available.length,
    limitedAccounts: accounts.filter((account) => account.live?.status === 'limit_reached').length,
    accountsNeedingReauth: accounts.filter((account) => account.needsReauth).length,
    recommendedAccount: available[0]?.commandName,
  };
}
