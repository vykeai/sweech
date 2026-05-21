export type SessionStatus = 'live' | 'tmux-detached' | 'crash-recoverable' | 'closed';

export type DashboardFreshnessState = 'fresh' | 'muted' | 'stale' | 'never';

export type HeroSession = {
  status: SessionStatus;
  summaryCostUsd?: number | null;
  summaryAt?: number | null;
  launchedAt?: number | null;
  launched_at?: number | null;
};

export type DoctorCheck = {
  status?: 'ok' | 'warn' | 'warning' | 'error' | 'unknown';
  ok?: boolean;
  severity?: 'ok' | 'warn' | 'warning' | 'error';
};

export type HeroStats = {
  liveCount: number;
  recoverableCount: number;
  costMtdUsd: number;
  doctorIssueCount: number;
};

const MONTH_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
});

export function deriveHeroStats(
  sessions: HeroSession[],
  doctorChecks: DoctorCheck[] = [],
  nowMs = Date.now(),
): HeroStats {
  const currentMonth = monthKey(nowMs);
  return {
    liveCount: sessions.filter((session) => session.status === 'live').length,
    recoverableCount: sessions.filter((session) => session.status === 'crash-recoverable').length,
    costMtdUsd: sessions.reduce((total, session) => {
      const cost = safeCost(session.summaryCostUsd);
      if (cost === 0) return total;
      const occurredAt = session.summaryAt ?? session.launchedAt ?? session.launched_at ?? null;
      return occurredAt && monthKey(occurredAt) === currentMonth ? total + cost : total;
    }, 0),
    doctorIssueCount: doctorChecks.filter(isDoctorIssue).length,
  };
}

export function freshnessChipCopy(state: DashboardFreshnessState): { label: string; title: string } {
  switch (state) {
    case 'fresh':
      return { label: 'Fresh', title: 'Data refreshed recently' };
    case 'muted':
      return { label: 'Muted', title: 'Data is cached and not actively refreshed' };
    case 'stale':
      return { label: 'Stale', title: 'Data needs a refresh before acting on it' };
    case 'never':
      return { label: 'Never', title: 'No successful refresh has been recorded' };
  }
}

export function viewerBadgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 1) return null;
  return `${Math.floor(count)} viewers`;
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function isDoctorIssue(check: DoctorCheck): boolean {
  if (check.ok === false) return true;
  return check.status === 'warning'
    || check.status === 'warn'
    || check.status === 'error'
    || check.severity === 'warn'
    || check.severity === 'warning'
    || check.severity === 'error';
}

function safeCost(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function monthKey(ms: number): string {
  return MONTH_FORMATTER.format(new Date(ms));
}
