import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Estate } from './estate.js';

export type AccountRoutingStrategy = 'balanced' | 'least-used' | 'protect-weekly';

interface SweechMetaEntry {
  plan?: string;
}

interface RateLimitWindow {
  utilization?: number;
}

interface LiveRateLimitData {
  buckets?: Array<{
    label?: string;
    session?: RateLimitWindow;
    weekly?: RateLimitWindow;
  }>;
}

export interface AccountTelemetry {
  plan?: string;
  utilization5h?: number;
  utilization7d?: number;
}

export function getSweechSubscriptionsPath(): string {
  return join(homedir(), '.sweech', 'subscriptions.json');
}

export function getSweechRateLimitCachePath(): string {
  return join(homedir(), '.sweech', 'rate-limit-cache.json');
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function normalizePlanBonus(plan?: string): number {
  if (!plan) return 0;
  const lower = plan.toLowerCase();
  if (lower.includes('max 20')) return 12;
  if (lower.includes('max 5')) return 8;
  if (lower.includes('max')) return 8;
  if (lower.includes('pro')) return 4;
  return 0;
}

export async function loadSweechTelemetry(): Promise<Record<string, AccountTelemetry>> {
  const meta = await readJson<Record<string, SweechMetaEntry>>(getSweechSubscriptionsPath(), {});
  const cache = await readJson<Record<string, LiveRateLimitData>>(getSweechRateLimitCachePath(), {});

  const telemetry: Record<string, AccountTelemetry> = {};

  for (const [accountId, entry] of Object.entries(meta)) {
    telemetry[accountId] = { ...(telemetry[accountId] ?? {}), plan: entry.plan };
  }

  for (const [configDir, entry] of Object.entries(cache)) {
    const accountId = configDir.split('/').pop()?.replace(/^\./, '');
    if (!accountId) continue;
    const firstBucket = entry.buckets?.[0];
    telemetry[accountId] = {
      ...(telemetry[accountId] ?? {}),
      utilization5h: firstBucket?.session?.utilization,
      utilization7d: firstBucket?.weekly?.utilization,
    };
  }

  return telemetry;
}

function scoreAccount(telemetry: AccountTelemetry | undefined, strategy: AccountRoutingStrategy): number {
  const u5h = telemetry?.utilization5h ?? 0.5;
  const u7d = telemetry?.utilization7d ?? 0.5;
  const planBonus = normalizePlanBonus(telemetry?.plan);

  switch (strategy) {
    case 'least-used':
      return (1 - u5h) * 100 + (1 - u7d) * 30 + planBonus;
    case 'protect-weekly':
      return (1 - u7d) * 120 + (1 - u5h) * 20 + planBonus;
    case 'balanced':
    default:
      return (1 - u5h) * 70 + (1 - u7d) * 70 + planBonus;
  }
}

export function reorderAccountsByStrategy(
  accountIds: string[],
  estate: Estate,
  telemetry: Record<string, AccountTelemetry>,
  strategy?: AccountRoutingStrategy,
): string[] {
  if (!strategy) return accountIds;

  return [...accountIds].sort((a, b) => {
    const aAccount = estate.accounts[a];
    const bAccount = estate.accounts[b];
    const aEligible = aAccount?.type === 'subscription' && !!aAccount?.configDir;
    const bEligible = bAccount?.type === 'subscription' && !!bAccount?.configDir;

    if (aEligible !== bEligible) return aEligible ? -1 : 1;

    const aScore = scoreAccount(telemetry[a], strategy);
    const bScore = scoreAccount(telemetry[b], strategy);
    if (aScore !== bScore) return bScore - aScore;
    return accountIds.indexOf(a) - accountIds.indexOf(b);
  });
}
