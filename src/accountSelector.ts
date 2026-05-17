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
import { readAuditLog, logAudit, type AuditEntry } from './auditLog';
import { scrubSecrets } from './scrubSecrets';
import {
  exceedsMaxTier,
  type ProjectPin,
  type ProjectPinResolved,
} from './projectConfig';

export type RouteFailureClass =
  | 'auth-required'
  | 'quota-exhausted'
  | 'provider-rejected'
  | 'missing-wrapper'
  | 'wrapper-not-executable'
  | 'unsupported-capability'
  | 'route-policy-mismatch'
  | 'unknown-unavailable';

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
  /**
   * Set when a `.sweech.json` project pin influenced this recommendation
   * (matched `commandName`, capped tier, or steered `cliType`). The
   * caller surfaces the source path so the user knows the routing
   * decision was project-driven.
   */
  pinApplied?: ProjectPinResolved | null;
}

export interface RouteRecommendationRequest {
  taskType?: string;
  repo?: string;
  requiredCapabilities?: string[];
  cliType?: string;
  preferredProvider?: string;
  preferredModel?: string;
  preferredProfile?: string;
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
    launch: {
      mode: 'native-cli-profile' | 'sweech-wrapper';
      status: 'available' | 'route-unavailable';
      command: string;
      args: string[];
      env: Record<string, string>;
      wrapperRequired: boolean;
      wrapperPath: string | null;
      nativeProfileUsable: boolean;
      failureClass: 'missing-wrapper' | 'wrapper-not-executable' | null;
      installGuidance: string | null;
    };
    health: {
      status: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
      checkMode: 'cache-only';
      checkedAt: string;
      failureClass: RouteFailureClass | null;
      reasons: string[];
      checks: {
        launch: 'pass' | 'fail';
        auth: 'pass' | 'fail';
        quota: 'pass' | 'fail' | 'unknown';
        capability: 'pass' | 'fail';
      };
    };
    quota: {
      source: 'live-cache' | 'manual-plan' | 'unknown';
      status: string | null;
      planType: string | null;
      planLabel: string | null;
      isStale: boolean;
      messages5h: number;
      messages7d: number;
      totalMessages: number;
      utilization5h: number | null;
      utilization7d: number | null;
      reset5hAt: number | null;
      reset7dAt: number | null;
      weeklyResetAt: string | null;
      hoursUntilWeeklyReset: number | null;
      minutesUntilFirstCapacity: number | null;
      buckets: Array<{
        label: string;
        session?: { utilization: number; resetsAt?: number };
        weekly?: { utilization: number; resetsAt?: number };
      }>;
      limits: { window5h?: number; window7d?: number } | null;
    };
    lastFailure: {
      at: string;
      action: string;
      failureClass: RouteFailureClass | null;
      message: string | null;
    } | null;
    metadata: {
      providerKey: string;
      providerDisplayName: string;
      apiFormat: string | null;
      supportedEngines: string[];
      activeEngine: string;
      toolUseMode: 'native-agent-cli' | 'anthropic-compatible' | 'openai-compatible' | 'unknown';
      sessionSupport: {
        resume: boolean;
        list: boolean;
        named: boolean;
        resumeCommand: string | null;
      };
      context: {
        model: string | null;
        window: string | null;
        tokens: number | null;
        source: 'model-catalog' | 'provider-default' | 'unknown';
      };
      costQuotaHints: {
        pricing: string | null;
        quotaSource: RouteCandidate['route']['quota']['source'];
        planType: string | null;
        planLabel: string | null;
      };
      headless: {
        suitable: boolean;
        reason: string;
      };
      taskSuitability: {
        review: boolean;
        edit: boolean;
        proof: boolean;
        longRunningSupervision: boolean;
      };
      unsupportedCapabilities: string[];
    };
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
  /**
   * The `.sweech.json` pin that influenced this recommendation, if any.
   * `null` when the caller passed no pin or the pin file was missing.
   * Surfaced so the auto/recommend commands can tell the user
   * "(pinned from /path/to/.sweech.json)".
   */
  pinApplied: ProjectPinResolved | null;
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
  const cli = getCLI(account.cliType);
  const metadata = routeMetadata(account, providerName, model, {
    source: 'unknown',
    status: null,
    planType: null,
    planLabel: null,
    isStale: false,
    messages5h: 0,
    messages7d: 0,
    totalMessages: 0,
    utilization5h: null,
    utilization7d: null,
    reset5hAt: null,
    reset7dAt: null,
    weeklyResetAt: null,
    hoursUntilWeeklyReset: null,
    minutesUntilFirstCapacity: null,
    buckets: [],
    limits: null,
  });
  const capabilities = new Set<string>([
    'coding',
    'agentic-coding',
    `cli:${account.cliType}`,
    `engine:${account.cliType}`,
    `provider:${providerName}`,
    'tool-use:native-agent-cli',
  ]);

  if (model) capabilities.add(`model:${model.toLowerCase()}`);
  if (provider?.apiFormat) capabilities.add(`api-format:${provider.apiFormat}`);
  if (provider?.apiFormat) capabilities.add(`tool-use:${provider.apiFormat}-compatible`);
  if (provider?.authOptional) capabilities.add('local-provider');
  if (account.isManaged) capabilities.add('managed-profile');
  if (account.isDefault) capabilities.add('default-account');
  if (account.isManaged) capabilities.add('launch:sweech-wrapper');
  if (account.isDefault) capabilities.add('launch:native-cli-profile');
  if (cli?.resumeFlag) capabilities.add('session:resume');
  if (cli?.sessionsCommand) capabilities.add('session:list');
  if (cli?.sessionNameFlag) capabilities.add('session:named');
  if (metadata.headless.suitable) capabilities.add('headless:suitable');
  if (metadata.taskSuitability.review) capabilities.add('task:review');
  if (metadata.taskSuitability.edit) capabilities.add('task:edit');
  if (metadata.taskSuitability.proof) capabilities.add('task:proof');
  if (metadata.taskSuitability.longRunningSupervision) capabilities.add('task:long-running-supervision');
  if (account.cliType === 'claude') capabilities.add('claude');
  if (account.cliType === 'codex') capabilities.add('codex');
  if (account.cliType === 'kimi') capabilities.add('kimi');
  if (providerName.includes('kimi')) capabilities.add('kimi');
  if (provider?.availableModels?.some((candidate) => candidate.type === 'vision')) capabilities.add('vision');

  return Array.from(capabilities).sort();
}

function parseContextTokens(value?: string): number | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function routeMetadata(
  account: AccountEntry,
  providerName: string,
  model: string | null,
  quota: RouteCandidate['route']['quota'],
): RouteCandidate['route']['metadata'] {
  const provider = getProvider(providerName);
  const cli = getCLI(account.cliType);
  const modelInfo = provider?.availableModels?.find((candidate) => candidate.id === model);
  const contextWindow = modelInfo?.context ?? null;
  const contextTokens = parseContextTokens(contextWindow ?? undefined);
  const apiFormat = provider?.apiFormat ?? null;
  const hasTooling = Boolean(cli);
  const hasResume = Boolean(cli?.resumeFlag);
  const hasVision = modelInfo?.type === 'vision'
    || Boolean(provider?.availableModels?.some((candidate) => candidate.type === 'vision'))
    || providerName === 'openai'
    || providerName === 'anthropic';

  return {
    providerKey: providerName,
    providerDisplayName: provider?.displayName ?? providerName,
    apiFormat,
    supportedEngines: provider?.compatibility ?? [account.cliType],
    activeEngine: account.cliType,
    toolUseMode: hasTooling
      ? 'native-agent-cli'
      : apiFormat === 'anthropic'
        ? 'anthropic-compatible'
        : apiFormat === 'openai'
          ? 'openai-compatible'
          : 'unknown',
    sessionSupport: {
      resume: hasResume,
      list: Boolean(cli?.sessionsCommand),
      named: Boolean(cli?.sessionNameFlag),
      resumeCommand: cli?.resumeFlag ?? null,
    },
    context: {
      model,
      window: contextWindow,
      tokens: contextTokens,
      source: modelInfo?.context ? 'model-catalog' : provider?.defaultModel === model ? 'provider-default' : 'unknown',
    },
    costQuotaHints: {
      pricing: provider?.pricing ?? null,
      quotaSource: quota.source,
      planType: quota.planType,
      planLabel: quota.planLabel,
    },
    headless: {
      suitable: hasTooling,
      reason: hasTooling
        ? `${account.cliType} exposes a non-interactive command path through Sweech`
        : 'No supported coding CLI engine is known for this route',
    },
    taskSuitability: {
      review: hasTooling,
      edit: hasTooling,
      proof: hasTooling && hasVision,
      longRunningSupervision: hasTooling && hasResume && (contextTokens === null || contextTokens >= 128_000),
    },
    unsupportedCapabilities: [],
  };
}

function wrapperPathFor(commandName: string): string {
  return path.join(os.homedir(), '.sweech', 'bin', commandName);
}

function executableStatus(filePath: string): 'available' | 'missing-wrapper' | 'wrapper-not-executable' {
  if (!fs.existsSync(filePath)) return 'missing-wrapper';
  try {
    return (fs.statSync(filePath).mode & 0o111) !== 0
      ? 'available'
      : 'wrapper-not-executable';
  } catch {
    return 'wrapper-not-executable';
  }
}

function buildLaunchPlan(account: AccountEntry): RouteCandidate['route']['launch'] {
  const cli = getCLI(account.cliType);
  const cliCommand = cli?.command ?? account.cliType;

  if (!account.isManaged) {
    return {
      mode: 'native-cli-profile',
      status: 'available',
      command: cliCommand,
      args: [],
      env: cli ? { [cli.configDirEnvVar]: account.configDir } : {},
      wrapperRequired: false,
      wrapperPath: null,
      nativeProfileUsable: true,
      failureClass: null,
      installGuidance: null,
    };
  }

  const wrapperPath = wrapperPathFor(account.commandName);
  const wrapperStatus = executableStatus(wrapperPath);
  const failureClass = wrapperStatus === 'available' ? null : wrapperStatus;

  return {
    mode: 'sweech-wrapper',
    status: wrapperStatus === 'available' ? 'available' : 'route-unavailable',
    command: wrapperPath,
    args: [],
    env: {},
    wrapperRequired: true,
    wrapperPath,
    nativeProfileUsable: false,
    failureClass,
    installGuidance: failureClass
      ? `Run: sweech repair ${account.commandName}`
      : null,
  };
}

function routeQuota(info: AccountInfo): RouteCandidate['route']['quota'] {
  const live = info.live;
  const primaryBucket = live?.buckets?.[0];
  return {
    source: live ? 'live-cache' : (info.meta.plan || info.meta.limits ? 'manual-plan' : 'unknown'),
    status: live?.status ?? null,
    planType: live?.planType ?? null,
    planLabel: info.meta.plan ?? null,
    isStale: Boolean(live?.isStale),
    messages5h: info.messages5h,
    messages7d: info.messages7d,
    totalMessages: info.totalMessages,
    utilization5h: primaryBucket?.session?.utilization ?? null,
    utilization7d: primaryBucket?.weekly?.utilization ?? null,
    reset5hAt: primaryBucket?.session?.resetsAt ?? null,
    reset7dAt: primaryBucket?.weekly?.resetsAt ?? null,
    weeklyResetAt: info.weeklyResetAt ?? null,
    hoursUntilWeeklyReset: info.hoursUntilWeeklyReset ?? null,
    minutesUntilFirstCapacity: info.minutesUntilFirstCapacity ?? null,
    buckets: (live?.buckets ?? []).map((bucket) => ({
      label: bucket.label,
      ...(bucket.session ? { session: { utilization: bucket.session.utilization, ...(bucket.session.resetsAt !== undefined ? { resetsAt: bucket.session.resetsAt } : {}) } } : {}),
      ...(bucket.weekly ? { weekly: { utilization: bucket.weekly.utilization, ...(bucket.weekly.resetsAt !== undefined ? { resetsAt: bucket.weekly.resetsAt } : {}) } } : {}),
    })),
    limits: info.meta.limits ?? null,
  };
}

function failureClassFromReasons(reasons: string[]): RouteFailureClass | null {
  if (reasons.includes('needs-reauth')) return 'auth-required';
  if (reasons.includes('availability:limit_reached')) return 'quota-exhausted';
  if (reasons.includes('availability:rejected')) return 'provider-rejected';
  if (reasons.includes('route-unavailable:missing-wrapper')) return 'missing-wrapper';
  if (reasons.includes('route-unavailable:wrapper-not-executable')) return 'wrapper-not-executable';
  if (reasons.some((reason) => reason.startsWith('missing-capability:'))) return 'unsupported-capability';
  if (reasons.some((reason) => reason.startsWith('cli-type-mismatch:') || reason.startsWith('profile-mismatch:'))) {
    return 'route-policy-mismatch';
  }
  return reasons.length > 0 ? 'unknown-unavailable' : null;
}

function routeHealth(
  reasons: string[],
  launch: RouteCandidate['route']['launch'],
  info: AccountInfo,
): RouteCandidate['route']['health'] {
  const failureClass = failureClassFromReasons(reasons);
  const liveStatus = info.live?.status;
  const quotaFailure = liveStatus === 'rejected' || liveStatus === 'limit_reached';
  const quotaUnknown = liveStatus === undefined;

  return {
    status: failureClass
      ? 'unavailable'
      : liveStatus === 'allowed_warning' || info.live?.isStale
        ? 'degraded'
        : quotaUnknown
          ? 'unknown'
          : 'healthy',
    checkMode: 'cache-only',
    checkedAt: new Date().toISOString(),
    failureClass,
    reasons,
    checks: {
      launch: launch.status === 'available' ? 'pass' : 'fail',
      auth: info.needsReauth ? 'fail' : 'pass',
      quota: quotaFailure ? 'fail' : quotaUnknown ? 'unknown' : 'pass',
      capability: reasons.some((reason) => reason.startsWith('missing-capability:')) ? 'fail' : 'pass',
    },
  };
}

function lastFailureFor(commandName: string): RouteCandidate['route']['lastFailure'] {
  let entries: AuditEntry[];
  try {
    entries = readAuditLog({ limit: 100 });
  } catch {
    return null;
  }

  const entry = [...entries].reverse().find((candidate) => {
    if (candidate.account !== commandName) return false;
    const action = candidate.action.toLowerCase();
    const details = candidate.details ?? {};
    return action.includes('fail')
      || action.includes('error')
      || typeof details.failureClass === 'string'
      || typeof details.error === 'string';
  });

  if (!entry) return null;
  const details = entry.details ?? {};
  const rawFailureClass = typeof details.failureClass === 'string' ? details.failureClass : null;
  const failureClass = rawFailureClass && [
    'auth-required',
    'quota-exhausted',
    'provider-rejected',
    'missing-wrapper',
    'wrapper-not-executable',
    'unsupported-capability',
    'route-policy-mismatch',
    'unknown-unavailable',
  ].includes(rawFailureClass)
    ? rawFailureClass as RouteFailureClass
    : null;
  const rawMessage = typeof details.message === 'string'
    ? details.message
    : typeof details.error === 'string'
      ? details.error
      : null;

  return {
    at: entry.timestamp,
    action: entry.action,
    failureClass,
    message: rawMessage ? scrubSecrets(rawMessage) : null,
  };
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
  if (request.preferredProfile && candidate.route.commandName !== request.preferredProfile) {
    reasons.push(`profile-mismatch:${candidate.route.commandName}`);
  }
  if (candidate.account.needsReauth) reasons.push('needs-reauth');
  if (candidate.account.liveStatus === 'rejected' || candidate.account.liveStatus === 'limit_reached') {
    reasons.push(`availability:${candidate.account.liveStatus}`);
  }
  if (candidate.route.launch.status === 'route-unavailable') {
    reasons.push(`route-unavailable:${candidate.route.launch.failureClass ?? 'unknown'}`);
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
  const quota = routeQuota(info);
  const capabilities = routeCapabilities(account, provider, model);
  const cli = getCLI(account.cliType);
  const launch = buildLaunchPlan(account);
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
      launchCommand: account.isManaged ? launch.command : (cli?.command ?? account.cliType),
      launch,
      health: routeHealth([], launch, info),
      quota,
      lastFailure: lastFailureFor(account.commandName),
      metadata: routeMetadata(account, provider, model, quota),
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
  candidate.route.health = routeHealth(candidate.reasons, launch, info);
  candidate.route.metadata.unsupportedCapabilities = candidate.reasons
    .filter((reason) => reason.startsWith('missing-capability:'))
    .map((reason) => reason.replace(/^missing-capability:/, ''));
  return candidate;
}

/**
 * Apply a project pin to the incoming RouteRecommendationRequest.
 *
 * Pin precedence:
 *   - `pin.cliType` always wins over `request.cliType` — projects are
 *     opinionated, callers asking for the "default" CLI should defer.
 *   - `pin.profile` is mapped to `preferredProfile`. If the caller
 *     already passed an explicit `preferredProfile`, the caller wins
 *     (e.g. `sweech recommend --preferred-profile X` must override
 *     the pin so a one-off run can sidestep the pin).
 *   - `pin.model` becomes `preferredModel` (caller override wins).
 *
 * `maxTier` is NOT merged into the request — it's a candidate-level
 * filter applied below alongside scoring.
 */
function mergePinIntoRequest(
  request: RouteRecommendationRequest,
  pin: ProjectPin,
): RouteRecommendationRequest {
  const merged: RouteRecommendationRequest = { ...request };
  if (pin.cliType) {
    merged.cliType = pin.cliType;
  }
  if (pin.profile && !merged.preferredProfile) {
    merged.preferredProfile = pin.profile;
  }
  if (pin.model && !merged.preferredModel) {
    merged.preferredModel = pin.model;
  }
  return merged;
}

/**
 * Recommend the best executable route for a coding task.
 *
 * Returns both the winning route and explicit rejection reasons for alternatives
 * that were filtered by CLI, capability, auth, quota, or launch-path state.
 *
 * When `projectPin` is provided it overrides the request (cliType,
 * preferredProfile, preferredModel) and caps candidates by tier. The
 * `pinApplied` field on the response surfaces the pin source so callers
 * can tell the user "(pinned from /path/to/.sweech.json)".
 *
 * If the pin's `profile` does not match any available profile, the
 * caller falls through to normal ranking — a warning is logged once to
 * stderr but the pin doesn't black out the whole result. A bad pin
 * should never strand the user.
 */
export async function recommendRoute(
  request: RouteRecommendationRequest = {},
  profiles?: ProfileConfig[],
  projectPin?: ProjectPinResolved | null,
): Promise<RouteRecommendationResponse> {
  const resolvedProfiles = profiles ?? new ConfigManager().getProfiles();

  // Merge pin overrides into the request BEFORE normalisation so the
  // pin's cliType/preferredProfile/preferredModel flow through the
  // existing scoring / rejection paths unchanged.
  const requestWithPin = projectPin?.pin
    ? mergePinIntoRequest(request, projectPin.pin)
    : request;

  const normalizedRequest: RouteRecommendationRequest = {
    ...requestWithPin,
    requiredCapabilities: normalizeCapabilities(requestWithPin.requiredCapabilities),
  };
  const known = getKnownAccounts(resolvedProfiles);
  const infos = await getAccountInfo(known, { cacheOnly: true });
  const available = getAvailableAccounts(resolvedProfiles);
  const byCommand = new Map(available.map((entry) => [entry.commandName, entry]));

  let candidates = infos
    .map((info) => {
      const account = byCommand.get(info.commandName);
      if (!account) return null;
      return buildCandidate(account, info, resolvedProfiles, normalizedRequest);
    })
    .filter((value): value is RouteCandidate => Boolean(value))
    .sort((a, b) => b.score - a.score);

  // Apply pin.maxTier as a rejection reason (not a hard drop) so callers
  // can see which candidates were tier-capped. The candidate stays in the
  // `rejected` list with a clear reason for diagnostics.
  if (projectPin?.pin.maxTier) {
    const cap = projectPin.pin.maxTier;
    for (const candidate of candidates) {
      const info = infos.find(i => i.commandName === candidate.route.commandName);
      const candidateTier = info?.rateLimitTier ?? info?.billingType ?? info?.live?.planType;
      if (exceedsMaxTier(candidateTier, cap)) {
        candidate.reasons.push(`pin-max-tier-exceeded:${candidateTier ?? 'unknown'}`);
      }
    }
  }

  // If the pin specified a profile that doesn't exist among candidates,
  // log once to stderr and let scoring fall through. The selected
  // candidate will just be the best-scoring one, not the pinned one.
  const pinProfile = projectPin?.pin.profile;
  if (pinProfile) {
    const hasPinned = candidates.some(c => c.route.commandName === pinProfile);
    if (!hasPinned) {
      // eslint-disable-next-line no-console
      console.error(
        `sweech: pinned profile '${pinProfile}' (from ${projectPin?.source}) not found — falling through to default ranking`,
      );
    }
  }

  const selected = candidates.find((candidate) => candidate.reasons.length === 0 && Number.isFinite(candidate.score)) ?? null;
  if (selected) selected.selected = true;
  for (const candidate of candidates) {
    if (candidate !== selected && candidate.reasons.length === 0) {
      candidate.reasons.push('not-selected:lower-score');
    }
  }

  // Audit-log pin-influenced selections so we have a trail for routing
  // decisions made on behalf of the user. Only logs when a pin was
  // applied AND it actually changed the outcome (cliType, profile, or
  // tier cap had to filter something). Best-effort — audit log failures
  // never block the recommendation.
  if (projectPin && selected) {
    try {
      logAudit({
        timestamp: new Date().toISOString(),
        action: 'route_pin_applied',
        account: selected.route.commandName,
        details: {
          source: projectPin.source,
          projectRoot: projectPin.projectRoot,
          pin: projectPin.pin,
        },
      });
    } catch {
      /* audit-log failures are non-fatal */
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
    pinApplied: projectPin ?? null,
  };
}

/**
 * Recommend the best account to use right now.
 *
 * Priority:
 * 1. Exclude accounts already rejected/at hard limit
 * 2. Prefer quota that resets sooner so expiring capacity gets used first
 * 3. Prefer accounts with higher weekly/session utilization if they are still healthy
 *
 * When `projectPin` is provided, the pin steers the recommendation
 * (cliType / preferredProfile / maxTier) and the resolved pin source
 * is echoed back on the result so `sweech auto` can tell the user
 * "Using profile X (pinned by .sweech.json at /path)".
 */
export async function suggestBestAccount(
  cliType?: string,
  profiles?: ProfileConfig[],
  projectPin?: ProjectPinResolved | null,
): Promise<AccountRecommendation | undefined> {
  const route = await recommendRoute({ cliType }, profiles, projectPin);
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
    pinApplied: route.pinApplied,
  };
}
