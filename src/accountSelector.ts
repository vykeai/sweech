/**
 * Reusable account enumeration for sweech.
 *
 * Extracts the launcher's account-building logic into standalone helpers
 * so that other modules (server, CLI commands, tests) can list and filter
 * accounts without depending on the TUI.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ConfigManager, ProfileConfig } from './config';
import { CLIType, getProvider } from './providers';
import { SUPPORTED_CLIS, getCLI } from './clis';
import { getAccountInfo, getKnownAccounts, type AccountInfo } from './subscriptions';

export interface AccountEntry {
  name: string;
  commandName: string;
  cliType: string;
  configDir: string;
  isDefault: boolean;   // true for built-in claude/codex
  isManaged: boolean;   // true for sweech-managed profiles
}

export interface AccountRecommendation {
  account: AccountEntry;
  score: number;
  reason: string;
}

export interface RouteRecommendationRequest {
  taskType?: string;
  repo?: string;
  requiredCapabilities?: string[];
  cliType?: string;
  preferredProvider?: string;
  preferredModel?: string;
}

export interface RouteCandidate {
  route: {
    commandName: string;
    account: string;
    cliType: string;
    provider: string;
    model: string | null;
    profile: string | null;
    configDir: string;
    launchCommand: string;
  };
  account: {
    name: string;
    commandName: string;
    isDefault: boolean;
    isManaged: boolean;
    needsReauth: boolean;
    liveStatus: string | null;
  };
  capabilities: string[];
  score: number;
  selected: boolean;
  scoreReason: string;
  reasons: string[];
}

export interface RouteRecommendationResponse {
  schemaVersion: 'sweech.route-recommendation.v1';
  producer: 'sweech';
  generatedAt: string;
  request: Required<Pick<RouteRecommendationRequest, 'requiredCapabilities'>> & Omit<RouteRecommendationRequest, 'requiredCapabilities'>;
  selected: RouteCandidate | null;
  rejected: RouteCandidate[];
  candidates: RouteCandidate[];
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Check whether a CLI binary is reachable on the PATH. */
function isInstalled(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Default config directory for a built-in CLI (e.g. ~/.claude, ~/.codex). */
function defaultConfigDir(command: string): string {
  return path.join(os.homedir(), `.${command}`);
}

// ─── Core enumeration ───────────────────────────────────────────────

/**
 * Build the full list of known accounts — both built-in defaults and
 * sweech-managed profiles.
 *
 * When `profiles` is omitted the current on-disk config is read
 * automatically via ConfigManager.
 */
export function enumerateAccounts(profiles?: ProfileConfig[]): AccountEntry[] {
  const resolvedProfiles = profiles ?? new ConfigManager().getProfiles();

  const entries: AccountEntry[] = [];
  const seen = new Set<string>();

  // 1. Default accounts for every installed CLI
  for (const cli of Object.values(SUPPORTED_CLIS)) {
    if (!isInstalled(cli.command)) continue;

    entries.push({
      name: cli.command,
      commandName: cli.command,
      cliType: cli.name,
      configDir: defaultConfigDir(cli.command),
      isDefault: true,
      isManaged: false,
    });
    seen.add(cli.command);
  }

  // 2. Sweech-managed profiles
  for (const p of resolvedProfiles) {
    if (seen.has(p.commandName)) continue;

    const cliType = p.cliType || 'claude';
    entries.push({
      name: p.name || p.commandName,
      commandName: p.commandName,
      cliType,
      configDir: path.join(os.homedir(), `.${p.commandName}`),
      isDefault: false,
      isManaged: true,
    });
    seen.add(p.commandName);
  }

  // 3. Group: claude (defaults first, then profiles), then kimi, then codex
  return [
    ...entries.filter(e => e.cliType === 'claude' && e.isDefault),
    ...entries.filter(e => e.cliType === 'claude' && !e.isDefault),
    ...entries.filter(e => e.cliType === 'kimi' && e.isDefault),
    ...entries.filter(e => e.cliType === 'kimi' && !e.isDefault),
    ...entries.filter(e => e.cliType === 'codex' && e.isDefault),
    ...entries.filter(e => e.cliType === 'codex' && !e.isDefault),
  ];
}

// ─── Filtered views ─────────────────────────────────────────────────

/**
 * Same as `enumerateAccounts` but only returns entries whose config
 * directory actually exists on disk.
 */
export function getAvailableAccounts(profiles?: ProfileConfig[]): AccountEntry[] {
  return enumerateAccounts(profiles).filter(e => fs.existsSync(e.configDir));
}

/**
 * Return accounts that match a specific CLI type (e.g. "claude" or "codex").
 */
export function getAccountsByType(cliType: string, profiles?: ProfileConfig[]): AccountEntry[] {
  return enumerateAccounts(profiles).filter(e => e.cliType === cliType);
}

/**
 * Return the "best" account to use right now.
 *
 * Placeholder implementation: returns the first account from the
 * enumerated list. A future version will consult usage/limit data and
 * skip accounts that have hit their rate-limit window.
 */
export function getBestAccount(profiles?: ProfileConfig[]): AccountEntry | undefined {
  const accounts = enumerateAccounts(profiles);
  return accounts[0];
}

export function accountScore(info: AccountInfo): number {
  const live = info.live;
  const status = live?.status;
  if (status === 'rejected' || status === 'limit_reached') return Number.NEGATIVE_INFINITY;

  const weeklyUtil = live?.buckets?.[0]?.weekly?.utilization ?? 0;
  const sessionUtil = live?.buckets?.[0]?.session?.utilization ?? 0;
  const resetHours = info.hoursUntilWeeklyReset ?? 24 * 365;
  const resetUrgency = resetHours > 0 ? 1 / resetHours : 10;
  const firstCapacityMinutes = info.minutesUntilFirstCapacity ?? 0;
  const capacityPenalty = firstCapacityMinutes > 0 ? Math.min(firstCapacityMinutes / 600, 1) : 0;

  return (weeklyUtil * 100) + (sessionUtil * 20) + (resetUrgency * 50) - (capacityPenalty * 10);
}

export function accountReason(info: AccountInfo): string {
  const pieces: string[] = [];
  if (info.live?.status) pieces.push(`status=${info.live.status}`);
  if (info.hoursUntilWeeklyReset !== undefined) pieces.push(`weekly-reset=${info.hoursUntilWeeklyReset.toFixed(1)}h`);
  const weeklyUtil = info.live?.buckets?.[0]?.weekly?.utilization;
  const sessionUtil = info.live?.buckets?.[0]?.session?.utilization;
  if (weeklyUtil !== undefined) pieces.push(`7d=${Math.round(weeklyUtil * 100)}%`);
  if (sessionUtil !== undefined) pieces.push(`5h=${Math.round(sessionUtil * 100)}%`);
  if (pieces.length === 0) return 'fallback order';
  return pieces.join(', ');
}

function normalizeCapabilities(values?: string[]): string[] {
  return Array.from(new Set((values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)));
}

function providerFor(account: AccountEntry, info: AccountInfo, profiles: ProfileConfig[]): string {
  const profile = profiles.find((p) => p.commandName === account.commandName);
  if (profile?.provider) return profile.provider;
  if (account.cliType === 'kimi' && (!info.provider || info.provider === 'openai')) return 'kimi-coding';
  if (info.provider) return info.provider;
  if (account.cliType === 'codex') return 'openai';
  return 'anthropic';
}

function modelFor(providerName: string, account: AccountEntry, profiles: ProfileConfig[]): string | null {
  const profile = profiles.find((p) => p.commandName === account.commandName);
  if (profile?.model) return profile.model;
  return getProvider(providerName)?.defaultModel ?? null;
}

function routeCapabilities(account: AccountEntry, providerName: string, model: string | null): string[] {
  const provider = getProvider(providerName);
  const capabilities = new Set<string>([
    'coding',
    'agentic-coding',
    `cli:${account.cliType}`,
    `provider:${providerName}`,
  ]);

  if (model) capabilities.add(`model:${model.toLowerCase()}`);
  if (provider?.apiFormat) capabilities.add(`api-format:${provider.apiFormat}`);
  if (provider?.authOptional) capabilities.add('local-provider');
  if (account.isManaged) capabilities.add('managed-profile');
  if (account.isDefault) capabilities.add('default-account');
  if (account.cliType === 'claude') capabilities.add('claude');
  if (account.cliType === 'codex') capabilities.add('codex');
  if (account.cliType === 'kimi') capabilities.add('kimi');
  if (providerName.includes('kimi')) capabilities.add('kimi');
  if (provider?.availableModels?.some((candidate) => candidate.type === 'vision')) capabilities.add('vision');

  return Array.from(capabilities).sort();
}

function requestedTaskBonus(request: RouteRecommendationRequest, candidate: RouteCandidate): number {
  const taskType = request.taskType?.toLowerCase() ?? '';
  let bonus = 0;
  if (request.preferredProvider && candidate.route.provider === request.preferredProvider) bonus += 25;
  if (request.preferredModel && candidate.route.model === request.preferredModel) bonus += 20;
  if ((taskType.includes('backend') || taskType.includes('api')) && candidate.route.cliType === 'codex') bonus += 5;
  if ((taskType.includes('long') || taskType.includes('context')) && candidate.capabilities.includes('kimi')) bonus += 5;
  return bonus;
}

function rejectionReasons(
  request: RouteRecommendationRequest,
  candidate: RouteCandidate,
): string[] {
  const reasons: string[] = [];
  if (request.cliType && candidate.route.cliType !== request.cliType) {
    reasons.push(`cli-type-mismatch:${candidate.route.cliType}`);
  }
  if (candidate.account.needsReauth) reasons.push('needs-reauth');
  if (candidate.account.liveStatus === 'rejected' || candidate.account.liveStatus === 'limit_reached') {
    reasons.push(`availability:${candidate.account.liveStatus}`);
  }

  const capabilities = new Set(candidate.capabilities.map((capability) => capability.toLowerCase()));
  for (const required of normalizeCapabilities(request.requiredCapabilities)) {
    if (!capabilities.has(required)) reasons.push(`missing-capability:${required}`);
  }

  return reasons;
}

function buildCandidate(
  account: AccountEntry,
  info: AccountInfo,
  profiles: ProfileConfig[],
  request: RouteRecommendationRequest,
): RouteCandidate {
  const provider = providerFor(account, info, profiles);
  const model = modelFor(provider, account, profiles);
  const capabilities = routeCapabilities(account, provider, model);
  const cli = getCLI(account.cliType);
  const baseScore = accountScore(info);
  const candidate: RouteCandidate = {
    route: {
      commandName: account.commandName,
      account: account.name,
      cliType: account.cliType,
      provider,
      model,
      profile: account.isManaged ? account.commandName : null,
      configDir: account.configDir,
      launchCommand: cli?.command ?? account.cliType,
    },
    account: {
      name: account.name,
      commandName: account.commandName,
      isDefault: account.isDefault,
      isManaged: account.isManaged,
      needsReauth: Boolean(info.needsReauth),
      liveStatus: info.live?.status ?? null,
    },
    capabilities,
    score: baseScore,
    selected: false,
    scoreReason: accountReason(info),
    reasons: [],
  };
  if (Number.isFinite(candidate.score)) {
    candidate.score += requestedTaskBonus(request, candidate);
  }
  candidate.reasons = rejectionReasons(request, candidate);
  return candidate;
}

/**
 * Recommend the best executable route for a coding task.
 *
 * Codeuctor should call this contract instead of hardcoding provider/model
 * preference. It returns both the winning route and explicit rejection reasons
 * for alternatives that were filtered by CLI, capability, auth, or quota state.
 */
export async function recommendRoute(
  request: RouteRecommendationRequest = {},
  profiles?: ProfileConfig[],
): Promise<RouteRecommendationResponse> {
  const resolvedProfiles = profiles ?? new ConfigManager().getProfiles();
  const normalizedRequest: RouteRecommendationRequest = {
    ...request,
    requiredCapabilities: normalizeCapabilities(request.requiredCapabilities),
  };
  const known = getKnownAccounts(resolvedProfiles);
  const infos = await getAccountInfo(known, { cacheOnly: true });
  const available = getAvailableAccounts(resolvedProfiles);
  const byCommand = new Map(available.map((entry) => [entry.commandName, entry]));

  const candidates = infos
    .map((info) => {
      const account = byCommand.get(info.commandName);
      if (!account) return null;
      return buildCandidate(account, info, resolvedProfiles, normalizedRequest);
    })
    .filter((value): value is RouteCandidate => Boolean(value))
    .sort((a, b) => b.score - a.score);

  const selected = candidates.find((candidate) => candidate.reasons.length === 0 && Number.isFinite(candidate.score)) ?? null;
  if (selected) selected.selected = true;
  for (const candidate of candidates) {
    if (candidate !== selected && candidate.reasons.length === 0) {
      candidate.reasons.push('not-selected:lower-score');
    }
  }

  return {
    schemaVersion: 'sweech.route-recommendation.v1',
    producer: 'sweech',
    generatedAt: new Date().toISOString(),
    request: {
      ...normalizedRequest,
      requiredCapabilities: normalizedRequest.requiredCapabilities ?? [],
    },
    selected,
    rejected: candidates.filter((candidate) => candidate !== selected),
    candidates,
  };
}

/**
 * Recommend the best account to use right now.
 *
 * Priority:
 * 1. Exclude accounts already rejected/at hard limit
 * 2. Prefer quota that resets sooner so expiring capacity gets used first
 * 3. Prefer accounts with higher weekly/session utilization if they are still healthy
 */
export async function suggestBestAccount(
  cliType?: string,
  profiles?: ProfileConfig[],
): Promise<AccountRecommendation | undefined> {
  const route = await recommendRoute({ cliType }, profiles);
  const selected = route.selected;
  if (!selected) return undefined;

  return {
    account: {
      name: selected.account.name,
      commandName: selected.account.commandName,
      cliType: selected.route.cliType,
      configDir: selected.route.configDir,
      isDefault: selected.account.isDefault,
      isManaged: selected.account.isManaged,
    },
    score: selected.score,
    reason: selected.scoreReason,
  };
}
