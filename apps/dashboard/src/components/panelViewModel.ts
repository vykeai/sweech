import { type DashboardFreshnessState, formatUsd } from './heroStats';

export type DashboardWorkspace = {
  name?: string;
  commandName: string;
  cliType: string;
  provider: string;
  disabled?: boolean;
  hidden?: boolean;
  sharedWith?: string | null;
  lastUsed?: string | null;
  profileDirExists?: boolean;
  model?: string;
  baseUrl?: string;
  smallFastModel?: string;
};

export type DashboardAccount = {
  name?: string;
  commandName: string;
  cliType: string;
  provider?: string;
  plan?: string;
  tokenStatus?: string;
  messages5h?: number | null;
  messages7d?: number | null;
  lastActive?: string;
  freshnessAt?: number | null;
  utilization5h?: number | null;
  utilization7d?: number | null;
  resetLabel?: string | null;
};

export type DashboardCostProvider = {
  provider: string;
  spent7dUsd: number;
  estCostPerCallUsd: number;
  profiles: number;
};

export type DashboardCostState = {
  generatedAt?: string;
  spent7dUsd: number;
  estCostPerCallUsd: number;
  providers: DashboardCostProvider[];
  sparkline: number[];
};

export type DashboardAuditFinding = {
  profile: string;
  cliType: string;
  provider: string;
  severity: 'info' | 'warn' | 'critical';
  kind: string;
  detail: string;
  fixAction?: 'fix_cli_type' | 'fix_provider' | 'clear_orphan_env' | null;
  expectedProvider?: string;
  orphanEnvKeys?: string[];
};

export type DashboardAuditState = {
  generatedAt?: string;
  scanned: number;
  totalIssues: number;
  fixable: number;
  findings: DashboardAuditFinding[];
};

export type DashboardCooldown = {
  commandName: string;
  reason: string;
  recordedAt: string;
  expiresAt: string;
  minutesRemaining: number;
};

export type DashboardFailoverState = {
  generatedAt?: string;
  cooldowns: DashboardCooldown[];
};

export type DashboardRouteCandidate = {
  commandName: string;
  cliType: string;
  provider: string;
  model: string | null;
  status: string;
  score: number;
  reasons: string[];
  launchStatus: string;
  quotaStatus: string | null;
};

export type DashboardRoutingState = {
  generatedAt?: string;
  searchRoot?: string;
  selected: DashboardRouteCandidate | null;
  rejectedCount: number;
  pin: { source: string; projectRoot: string; profile?: string; cliType?: string; maxTier?: string; model?: string } | null;
  pins?: Array<{
    workspace: string;
    cwd: string;
    cwdBasename?: string;
    pinned: boolean;
    source: string | null;
    projectRoot: string | null;
    profile?: string;
    cliType?: string;
    maxTier?: string;
    model?: string;
  }>;
  candidates: DashboardRouteCandidate[];
};

export type DashboardBillingEntry = {
  vendor: string;
  email: string;
  billingDay: number | null;
  nextBillingAt: string | null;
  daysUntilNextBill: number | null;
};

export type DashboardBillingState = {
  generatedAt?: string;
  days: Array<{ date: string; count: number; entries: DashboardBillingEntry[] }>;
  entries: DashboardBillingEntry[];
};

export type DashboardDoctorCheck = {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  category: 'structural' | 'network';
};

export type DashboardDoctorState = {
  generatedAt?: string;
  status: 'ok' | 'warn' | 'error';
  checks: DashboardDoctorCheck[];
  nextNetworkRefreshAt?: string;
};

export type DashboardLogLine = {
  index: number;
  at?: string;
  event?: string;
  profile?: string;
  message: string;
  severity: 'info' | 'warn' | 'error';
};

export type DashboardLogsState = {
  generatedAt?: string;
  file?: string;
  lines: DashboardLogLine[];
};

export type DashboardPlugin = {
  name: string;
  version: string;
  enabled: boolean;
};

export type DashboardPluginsState = {
  generatedAt?: string;
  total: number;
  enabled: number;
  plugins: DashboardPlugin[];
};

export type DashboardTemplate = {
  name: string;
  description: string;
  cliType: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  tags: string[];
  builtIn: boolean;
};

export type DashboardTemplatesState = {
  generatedAt?: string;
  total: number;
  custom: number;
  templates: DashboardTemplate[];
};

export type DashboardFederationPeer = {
  hostname: string;
  url: string;
  lastSeen: string;
  capabilities: string[];
  status: 'online' | 'offline';
  sessionCount: number;
};

export type DashboardFederationState = {
  generatedAt?: string;
  enabled: boolean;
  peers: DashboardFederationPeer[];
};

export type DashboardSettingsState = {
  generatedAt?: string;
  general: { machine: string };
  tmux: { enabled: boolean; namingScheme: string; suffix: string };
  terminal: { preferred: 'auto' | 'ghostty' | 'iterm2' | 'terminal' | 'alacritty' | 'kitty' | 'wezterm' };
  summaries: { enabled: boolean; providerOrder: string[]; budgetPerSummaryUsd: number | null; budgetPerDayUsd: number | null; model: string };
  federation: { enabled: boolean; discoveryMethod: string };
  retention: { autoWipe: boolean; wipeOlderThanDays: number | null };
  refresh: { sessionsMs: number; peersMs: number; doctorNetworkMs: number };
};

export function workspaceStatus(workspace: DashboardWorkspace): { label: string; tone: 'success' | 'warning' | 'muted' } {
  if (workspace.hidden) return { label: 'Hidden', tone: 'muted' };
  if (workspace.disabled) return { label: 'Disabled', tone: 'warning' };
  if (workspace.profileDirExists === false) return { label: 'Missing dir', tone: 'warning' };
  return { label: 'Active', tone: 'success' };
}

export function accountTokenStatus(account: DashboardAccount): { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' } {
  const status = account.tokenStatus ?? (account.cliType === 'codex' ? 'managed' : 'unknown');
  if (status === 'valid' || status === 'refreshed' || status === 'managed') return { label: status === 'managed' ? 'Managed' : 'Token ok', tone: 'success' };
  if (status === 'expired' || status === 'unauthorized') return { label: 'Reauth', tone: 'danger' };
  if (status === 'no_token') return { label: 'No token', tone: 'warning' };
  return { label: 'Unknown', tone: 'muted' };
}

export function freshnessFromTimestamp(timestamp: number | string | null | undefined, now = Date.now()): DashboardFreshnessState {
  if (timestamp === null || timestamp === undefined) return 'never';
  const millis = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(millis)) return 'never';
  const age = now - millis;
  if (age < 0 || age <= 10 * 60_000) return 'fresh';
  if (age <= 60 * 60_000) return 'muted';
  return 'stale';
}

export function utilizationPercent(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

export function formatMessageWindow(count: number | null | undefined, label: string): string {
  return typeof count === 'number' ? `${Math.max(0, count)} ${label}` : `${label} window`;
}

export function formatWorkspaceLastUsed(value: string | null | undefined): string {
  if (!value) return 'No launches yet';
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return value;
  return new Date(millis).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function costSparklineBars(cost: DashboardCostState): number[] {
  const bars = Array.isArray(cost.sparkline) ? cost.sparkline.slice(0, 7) : [];
  while (bars.length < 7) bars.unshift(4);
  return bars.map((bar) => Math.max(4, Math.min(36, Math.round(bar))));
}

export function auditTone(finding: DashboardAuditFinding): 'success' | 'warning' | 'danger' | 'muted' {
  if (finding.severity === 'critical') return 'danger';
  if (finding.severity === 'warn') return 'warning';
  if (finding.fixAction) return 'success';
  return 'muted';
}

export function auditFixLabel(action?: DashboardAuditFinding['fixAction']): string {
  if (action === 'fix_cli_type') return 'Fix CLI';
  if (action === 'fix_provider') return 'Fix provider';
  if (action === 'clear_orphan_env') return 'Clear env';
  return 'Review';
}

export function formatCooldownRemaining(cooldown: DashboardCooldown): string {
  if (cooldown.minutesRemaining <= 0) return 'expires now';
  if (cooldown.minutesRemaining < 60) return `${cooldown.minutesRemaining}m`;
  const hours = Math.floor(cooldown.minutesRemaining / 60);
  const minutes = cooldown.minutesRemaining % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function routeTone(candidate: DashboardRouteCandidate): 'success' | 'warning' | 'danger' | 'muted' {
  if (candidate.launchStatus !== 'available' || candidate.status === 'unavailable') return 'danger';
  if (candidate.status === 'degraded' || candidate.status === 'unknown') return 'warning';
  return 'success';
}

export function billingDayTone(day: { count: number }): 'active' | 'empty' {
  return day.count > 0 ? 'active' : 'empty';
}

export function doctorTone(status: DashboardDoctorCheck['status'] | DashboardDoctorState['status']): 'success' | 'warning' | 'danger' {
  if (status === 'error') return 'danger';
  if (status === 'warn') return 'warning';
  return 'success';
}

export function logTone(severity: DashboardLogLine['severity']): 'success' | 'warning' | 'danger' | 'muted' {
  if (severity === 'error') return 'danger';
  if (severity === 'warn') return 'warning';
  if (severity === 'info') return 'muted';
  return 'success';
}

export function federationTone(status: DashboardFederationPeer['status']): 'success' | 'warning' {
  return status === 'online' ? 'success' : 'warning';
}

export function safeTestId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

export { formatUsd };
