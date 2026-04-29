import type { Estate, QuotaDef } from '../estate.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface AccountUsage {
  requestCount: number;
  tokenCount: number;
  costUsd: number;
  periodStart: string;
}

export interface QuotaState {
  accounts: Record<string, AccountUsage>;
  lastFlushed: string;
}

function periodStart(period: QuotaDef['period'], now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'daily') {
    return d.toISOString();
  }
  if (period === 'weekly') {
    const day = d.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setUTCDate(d.getUTCDate() - diff);
    return d.toISOString();
  }
  d.setUTCDate(1);
  return d.toISOString();
}

function isInCurrentPeriod(period: QuotaDef['period'], recorded: string, now: Date = new Date()): boolean {
  return periodStart(period, now) === recorded;
}

function freshUsage(period: QuotaDef['period'], now: Date = new Date()): AccountUsage {
  return {
    requestCount: 0,
    tokenCount: 0,
    costUsd: 0,
    periodStart: periodStart(period, now),
  };
}

export class QuotaTracker {
  private state: QuotaState;
  private statePath: string;
  private estate: Estate;
  private flushTimer?: ReturnType<typeof setInterval>;
  private _now: () => Date;

  constructor(estate: Estate, statePath?: string, opts?: { now?: () => Date }) {
    this.estate = estate;
    this.statePath = statePath ?? join(homedir(), '.omnai', 'quota-state.json');
    this.state = { accounts: {}, lastFlushed: new Date().toISOString() };
    this._now = opts?.now ?? (() => new Date());
    this.flushTimer = setInterval(() => { this.flush(); }, 30_000);
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  canUse(accountId: string): boolean {
    const account = this.estate.accounts[accountId];
    if (!account) return false;

    if (account.type === 'subscription') return true;

    const quota = account.quota;
    if (!quota) return true;

    const usage = this.getOrResetUsage(accountId);

    if (account.type === 'free-tier' && quota.limit !== undefined) {
      return usage.requestCount < quota.limit;
    }

    if (account.type === 'api-key' && quota.limit !== undefined) {
      return usage.costUsd < quota.limit;
    }

    return true;
  }

  recordUsage(accountId: string, tokens: number, costUsd: number): void {
    const usage = this.getOrResetUsage(accountId);
    usage.requestCount += 1;
    usage.tokenCount += tokens;
    usage.costUsd += costUsd;
  }

  getState(): QuotaState {
    return this.state;
  }

  getAccountStatus(accountId: string): {
    canUse: boolean;
    usage: AccountUsage;
    quota?: QuotaDef;
    utilizationPct?: number;
  } {
    const account = this.estate.accounts[accountId];
    const usage = this.getOrResetUsage(accountId);
    const canUse = this.canUse(accountId);
    const quota = account?.quota;

    let utilizationPct: number | undefined;
    if (quota?.limit !== undefined && quota.limit > 0) {
      if (account.type === 'api-key') {
        utilizationPct = (usage.costUsd / quota.limit) * 100;
      } else {
        utilizationPct = (usage.requestCount / quota.limit) * 100;
      }
    }

    return { canUse, usage, quota, utilizationPct };
  }

  async flush(): Promise<void> {
    this.state.lastFlushed = this._now().toISOString();
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, 'utf-8');
      this.state = JSON.parse(raw);
    } catch {
      this.state = { accounts: {}, lastFlushed: this._now().toISOString() };
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private getOrResetUsage(accountId: string): AccountUsage {
    const account = this.estate.accounts[accountId];
    const quota = account?.quota;
    const existing = this.state.accounts[accountId];

    if (existing && quota && isInCurrentPeriod(quota.period, existing.periodStart, this._now())) {
      return existing;
    }

    const period = quota?.period ?? 'monthly';
    const usage = freshUsage(period, this._now());
    this.state.accounts[accountId] = usage;
    return usage;
  }
}
