/// <reference path="../apps/dashboard/src/types/react-shim.d.ts" />
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FreshnessChip, HeroStrip, ViewerCountBadge } from '../apps/dashboard/src/components/HeroStrip';
import { SessionTile } from '../apps/dashboard/src/components/SessionTile';
import {
  deriveHeroStats,
  formatUsd,
  freshnessChipCopy,
  viewerBadgeLabel,
} from '../apps/dashboard/src/components/heroStats';
import {
  filterSessions,
  formatRelativeTime,
  normalizeSession,
  sessionFilterOptions,
  sortSessions,
  sparklineBars,
  type DashboardSession,
} from '../apps/dashboard/src/components/sessionViewModel';
import {
  auditFixLabel,
  auditTone,
  billingDayTone,
  accountTokenStatus,
  costSparklineBars,
  formatCooldownRemaining,
  freshnessFromTimestamp,
  routeTone,
  utilizationPercent,
  workspaceStatus,
} from '../apps/dashboard/src/components/panelViewModel';
import { AccountsPanel } from '../apps/dashboard/src/panels/Accounts';
import { AuditPanel } from '../apps/dashboard/src/panels/Audit';
import { BillingPanel } from '../apps/dashboard/src/panels/Billing';
import { CostPanel } from '../apps/dashboard/src/panels/Cost';
import { FailoverPanel } from '../apps/dashboard/src/panels/Failover';
import { RoutingPanel } from '../apps/dashboard/src/panels/Routing';
import { SessionsPanel } from '../apps/dashboard/src/panels/Sessions';
import { WorkspacesPanel } from '../apps/dashboard/src/panels/Workspaces';

describe('dashboard hero components', () => {
  const now = Date.UTC(2026, 4, 20, 12);

  test('deriveHeroStats counts live and recoverable sessions', () => {
    expect(deriveHeroStats([
      { status: 'live' },
      { status: 'live' },
      { status: 'tmux-detached' },
      { status: 'crash-recoverable' },
      { status: 'closed' },
    ], [], now)).toMatchObject({ liveCount: 2, recoverableCount: 1 });
  });

  test('deriveHeroStats sums only current-month positive session costs', () => {
    const stats = deriveHeroStats([
      { status: 'live', summaryCostUsd: 1.25, summaryAt: Date.UTC(2026, 4, 1) },
      { status: 'closed', summaryCostUsd: 0.75, launchedAt: Date.UTC(2026, 4, 2) },
      { status: 'closed', summaryCostUsd: 99, summaryAt: Date.UTC(2026, 3, 30) },
      { status: 'closed', summaryCostUsd: -5, summaryAt: Date.UTC(2026, 4, 3) },
    ], [], now);

    expect(stats.costMtdUsd).toBe(2);
  });

  test('deriveHeroStats counts warning and error doctor checks', () => {
    const stats = deriveHeroStats([], [
      { status: 'ok' },
      { status: 'warning' },
      { status: 'warn' },
      { severity: 'error' },
      { ok: false },
    ], now);

    expect(stats.doctorIssueCount).toBe(4);
  });

  test('freshnessChipCopy exposes all R13 states', () => {
    expect(freshnessChipCopy('fresh').label).toBe('Fresh');
    expect(freshnessChipCopy('muted').label).toBe('Muted');
    expect(freshnessChipCopy('stale').label).toBe('Stale');
    expect(freshnessChipCopy('never').label).toBe('Never');
  });

  test('ViewerCountBadge hides for one or fewer viewers', () => {
    expect(renderToStaticMarkup(React.createElement(ViewerCountBadge, { count: 1 }))).toBe('');
    expect(viewerBadgeLabel(0)).toBeNull();
  });

  test('ViewerCountBadge renders plural count above one', () => {
    const html = renderToStaticMarkup(React.createElement(ViewerCountBadge, { count: 3 }));

    expect(html).toContain('viewer-count-badge');
    expect(html).toContain('3 viewers');
  });

  test('FreshnessChip renders state class and label', () => {
    const html = renderToStaticMarkup(React.createElement(FreshnessChip, { state: 'stale' }));

    expect(html).toContain('freshness-chip freshness-stale');
    expect(html).toContain('Stale');
    expect(html).toContain('Data needs a refresh');
  });

  test('HeroStrip renders live, recoverable, cost MTD, and doctor metrics', () => {
    const html = renderToStaticMarkup(React.createElement(HeroStrip, {
      connected: true,
      stats: { liveCount: 4, recoverableCount: 2, costMtdUsd: 3.5, doctorIssueCount: 1 },
    }));

    expect(html).toContain('Dashboard summary');
    expect(html).toContain('Doctor');
    expect(html).toContain('Live');
    expect(html).toContain('Recoverable');
    expect(html).toContain('Cost MTD');
    expect(html).toContain('$3.50');
    expect(html).toContain('streaming');
  });

  test('formatUsd always prints cents for dashboard metrics', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(12.5)).toBe('$12.50');
  });
});

describe('dashboard workspace account cost panels', () => {
  test('workspaceStatus prioritizes hidden disabled missing and active states', () => {
    expect(workspaceStatus({ commandName: 'claude', cliType: 'claude', provider: 'anthropic' }).label).toBe('Active');
    expect(workspaceStatus({ commandName: 'claude', cliType: 'claude', provider: 'anthropic', hidden: true }).label).toBe('Hidden');
    expect(workspaceStatus({ commandName: 'claude', cliType: 'claude', provider: 'anthropic', disabled: true }).label).toBe('Disabled');
    expect(workspaceStatus({ commandName: 'claude', cliType: 'claude', provider: 'anthropic', profileDirExists: false }).label).toBe('Missing dir');
  });

  test('account helpers expose token, freshness, and utilization states', () => {
    expect(accountTokenStatus({ commandName: 'claude', cliType: 'claude', tokenStatus: 'valid' }).label).toBe('Token ok');
    expect(accountTokenStatus({ commandName: 'claude', cliType: 'claude', tokenStatus: 'expired' }).tone).toBe('danger');
    expect(freshnessFromTimestamp(Date.UTC(2026, 4, 21, 11, 58), Date.UTC(2026, 4, 21, 12))).toBe('fresh');
    expect(utilizationPercent(1.4)).toBe(100);
    expect(utilizationPercent(-0.2)).toBe(0);
  });

  test('WorkspacesPanel renders status sharedWith last-used and edit affordance', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspacesPanel, {
      workspaces: [{
        name: 'Sweech Main',
        commandName: 'claude-main',
        cliType: 'claude',
        provider: 'anthropic',
        sharedWith: 'claude',
        lastUsed: '2026-05-21T09:00:00.000Z',
        profileDirExists: true,
      }],
    }));

    expect(html).toContain('Workspaces');
    expect(html).toContain('workspace-card-claude-main');
    expect(html).toContain('Active');
    expect(html).toContain('sharedWith');
    expect(html).toContain('claude');
    expect(html).toContain('Edit');
  });

  test('WorkspacesPanel exposes click-through edit dialog markup when selected client-side', () => {
    const html = renderToStaticMarkup(React.createElement(WorkspacesPanel, {
      workspaces: [{
        commandName: 'claude-main',
        cliType: 'claude',
        provider: 'anthropic',
        profileDirExists: true,
      }],
    }));

    expect(html).toContain('aria-label="Edit claude-main"');
  });

  test('AccountsPanel renders usage bars freshness chip and token status', () => {
    const html = renderToStaticMarkup(React.createElement(AccountsPanel, {
      accounts: [{
        commandName: 'claude-pro',
        cliType: 'claude',
        provider: 'anthropic',
        plan: 'Max 20x',
        tokenStatus: 'valid',
        messages5h: 42,
        messages7d: 320,
        freshnessAt: Date.UTC(2026, 4, 21, 12),
        utilization5h: 0.42,
        utilization7d: 0.64,
        resetLabel: '18h',
      }],
    }));

    expect(html).toContain('account-card-claude-pro');
    expect(html).toContain('usage-bar-claude-pro-5h');
    expect(html).toContain('usage-bar-claude-pro-7d');
    expect(html).toContain('Token ok');
    expect(html).toContain('Max 20x');
    expect(html).toContain('42 5h');
    expect(html).toContain('64%');
  });

  test('CostPanel renders provider-mix sparkline and provider breakdown', () => {
    const html = renderToStaticMarkup(React.createElement(CostPanel, {
      cost: {
        spent7dUsd: 2.5,
        estCostPerCallUsd: 0.05,
        sparkline: [4, 8, 12, 16, 20, 28, 32],
        providers: [
          { provider: 'anthropic', spent7dUsd: 2, estCostPerCallUsd: 0.04, profiles: 2 },
          { provider: 'openai', spent7dUsd: 0.5, estCostPerCallUsd: 0.01, profiles: 1 },
        ],
      },
    }));

    expect(html).toContain('Cost');
    expect(html).toContain('$2.50');
    expect(html).toContain('cost-sparkline-provider-mix');
    expect(html).toContain('cost-provider-anthropic');
    expect(html).toContain('2 profiles');
  });

  test('costSparklineBars pads and bounds dashboard bars', () => {
    expect(costSparklineBars({ spent7dUsd: 0, estCostPerCallUsd: 0, providers: [], sparkline: [1, 60] })).toHaveLength(7);
    expect(Math.max(...costSparklineBars({ spent7dUsd: 0, estCostPerCallUsd: 0, providers: [], sparkline: [1, 60] }))).toBe(36);
  });
});

describe('dashboard audit failover routing billing panels', () => {
  test('AuditPanel renders fixable findings without evidence payloads', () => {
    const html = renderToStaticMarkup(React.createElement(AuditPanel, {
      audit: {
        scanned: 3,
        totalIssues: 1,
        fixable: 1,
        findings: [{
          profile: 'codex-wrong',
          cliType: 'codex',
          provider: 'openai',
          severity: 'warn',
          kind: 'provider_misconfig',
          detail: 'Provider mismatch',
          fixAction: 'fix_provider',
          expectedProvider: 'ollama',
        }],
      },
    }));

    expect(auditTone({ profile: 'x', cliType: 'codex', provider: 'openai', severity: 'critical', kind: 'cli_type_mismatch', detail: 'x' })).toBe('danger');
    expect(auditFixLabel('fix_provider')).toBe('Fix provider');
    expect(html).toContain('Audit');
    expect(html).toContain('audit-finding-codex-wrong-provider_misconfig');
    expect(html).toContain('audit-fix-codex-wrong-provider_misconfig');
    expect(html).not.toContain('accessToken');
  });

  test('FailoverPanel renders cooldown rows and clear affordance', () => {
    const html = renderToStaticMarkup(React.createElement(FailoverPanel, {
      failover: {
        cooldowns: [{
          commandName: 'claude-pro',
          reason: 'limit_reached',
          recordedAt: '2026-05-21T10:00:00.000Z',
          expiresAt: '2026-05-21T11:00:00.000Z',
          minutesRemaining: 75,
        }],
      },
    }));

    expect(formatCooldownRemaining({ commandName: 'x', reason: 'limit', recordedAt: '', expiresAt: '', minutesRemaining: 75 })).toBe('1h 15m');
    expect(html).toContain('cooldown-row-claude-pro');
    expect(html).toContain('cooldown-clear-claude-pro');
  });

  test('RoutingPanel renders selected route pin and candidates', () => {
    const html = renderToStaticMarkup(React.createElement(RoutingPanel, {
      routing: {
        rejectedCount: 1,
        searchRoot: '/repo/apps/sweech',
        pin: { source: '/repo/.sweech.json', projectRoot: '/repo', profile: 'claude-pro' },
        pins: [{
          workspace: 'sweech',
          cwd: '/repo/apps/sweech',
          cwdBasename: 'sweech',
          pinned: true,
          source: '/repo/.sweech.json',
          projectRoot: '/repo',
          profile: 'claude-pro',
        }],
        selected: {
          commandName: 'claude-pro',
          cliType: 'claude',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          status: 'healthy',
          score: 98,
          reasons: [],
          launchStatus: 'available',
          quotaStatus: 'ok',
        },
        candidates: [{
          commandName: 'claude-pro',
          cliType: 'claude',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          status: 'healthy',
          score: 98,
          reasons: [],
          launchStatus: 'available',
          quotaStatus: 'ok',
        }],
      },
      onPinSet: jest.fn(),
      onPinUnset: jest.fn(),
    }));

    expect(routeTone({ commandName: 'x', cliType: 'claude', provider: 'anthropic', model: null, status: 'healthy', score: 1, reasons: [], launchStatus: 'available', quotaStatus: null })).toBe('success');
    expect(html).toContain('routing-pin-active');
    expect(html).toContain('routing-pin-map-repo-apps-sweech');
    expect(html).toContain('routing-pin-unset');
    expect(html).toContain('routing-candidate-claude-pro');
    expect(html).toContain('routing-pin-set-claude-pro');
  });

  test('BillingPanel renders 30-day calendar and upcoming entries', () => {
    const days = Array.from({ length: 30 }, (_, index) => ({ date: `2026-05-${String(index + 1).padStart(2, '0')}`, count: index === 20 ? 1 : 0, entries: [] }));
    const html = renderToStaticMarkup(React.createElement(BillingPanel, {
      billing: {
        days,
        entries: [{ vendor: 'anthropic', email: 'luke@example.com', billingDay: 21, nextBillingAt: '2026-05-21', daysUntilNextBill: 0 }],
      },
    }));

    expect(billingDayTone({ count: 1 })).toBe('active');
    expect(html).toContain('billing-calendar');
    expect(html).toContain('billing-day-2026-05-21');
    expect(html).toContain('billing-entry-anthropic-luke-example-com');
  });
});

describe('dashboard sessions panel components', () => {
  const now = Date.UTC(2026, 4, 21, 12);
  const rawSessions: DashboardSession[] = [
    {
      id: 'local-live',
      workspace: 'claude-main',
      cwd: '/repo/sweech',
      cwdBasename: 'sweech',
      machine: 'studio',
      status: 'live',
      tmuxName: 'sweech-claude-main',
      pid: 123,
      tty: 'ttys004',
      launchedAt: now - 7_200_000,
      lastActiveAt: now - 120_000,
      messageCount: 24,
      msgCountFirst: 3,
      msgCountLast: 24,
      summaryOne: 'Shipping the dashboard tile grid.',
      summaryBullets: JSON.stringify(['Added filters', 'Wired restore', 'Captured screenshot']),
      summaryStale: false,
      attachClients: 3,
    },
    {
      id: 'remote-recoverable',
      workspace: 'codex-pole',
      cwd: '/work/pole',
      machine: 'macbook',
      status: 'crash-recoverable',
      launchedAt: now - 86_400_000,
      lastActiveAt: now - 3_600_000,
      messageCount: 8,
      msgCountFirst: 0,
      msgCountLast: 8,
      summaryOne: null,
      summaryBullets: '- Recovered launch\n- Needs attach',
      summaryStale: true,
      attachClients: 0,
    },
  ];

  test('normalizeSession accepts camel and snake case fields', () => {
    const normalized = normalizeSession({
      id: 'snake',
      workspace: 'claude',
      cwd: '/repo/app',
      cwd_basename: 'app',
      machine: 'studio',
      status: 'live',
      tmux_name: 'tmux-snake',
      message_count: 5,
      msg_count_first: 1,
      msg_count_last: 5,
      summary_bullets: '["one","two"]',
      attach_clients: 2,
    });

    expect(normalized).toMatchObject({
      cwdBasename: 'app',
      tmuxName: 'tmux-snake',
      messageCount: 5,
      summaryBullets: ['one', 'two'],
      attachClients: 2,
    });
  });

  test('filterSessions filters by machine status workspace and search text', () => {
    const sessions = rawSessions.map(normalizeSession);
    const filtered = filterSessions(sessions, {
      machine: 'studio',
      status: 'live',
      workspace: 'claude-main',
      search: 'tile grid',
    });

    expect(filtered.map((session) => session.id)).toEqual(['local-live']);
  });

  test('filterSessions returns no rows when filters do not match', () => {
    const filtered = filterSessions(rawSessions.map(normalizeSession), {
      machine: 'studio',
      status: 'closed',
      workspace: '',
      search: '',
    });

    expect(filtered).toEqual([]);
  });

  test('sortSessions defaults to newest active session first', () => {
    const sorted = sortSessions(rawSessions.map(normalizeSession), 'last-active');

    expect(sorted[0].id).toBe('local-live');
  });

  test('sortSessions can prioritize message count', () => {
    const sorted = sortSessions(rawSessions.map(normalizeSession), 'messages');

    expect(sorted.map((session) => session.id)).toEqual(['local-live', 'remote-recoverable']);
  });

  test('sessionFilterOptions derives unique machines and workspaces', () => {
    expect(sessionFilterOptions(rawSessions.map(normalizeSession))).toEqual({
      machines: ['macbook', 'studio'],
      workspaces: ['claude-main', 'codex-pole'],
    });
  });

  test('formatRelativeTime uses compact dashboard labels', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 2 * 60 * 60_000, now)).toBe('2h ago');
  });

  test('sparklineBars returns stable bounded bars', () => {
    const bars = sparklineBars(normalizeSession(rawSessions[0]));

    expect(bars).toHaveLength(6);
    expect(Math.max(...bars)).toBeLessThanOrEqual(28);
    expect(Math.min(...bars)).toBeGreaterThanOrEqual(2);
  });

  test('SessionTile renders local star, restore button, tmux, pid tty, and viewer badge', () => {
    const html = renderToStaticMarkup(React.createElement(SessionTile, {
      session: normalizeSession(rawSessions[0]),
      localMachine: 'studio',
      onJump: jest.fn(),
      onOpen: jest.fn(),
    }));

    expect(html).toContain('local machine');
    expect(html).toContain('↗ Jump');
    expect(html).toContain('sweech-claude-main');
    expect(html).toContain('123 ttys004');
    expect(html).toContain('3 viewers');
  });

  test('SessionTile renders skeleton copy when summary is pending', () => {
    const html = renderToStaticMarkup(React.createElement(SessionTile, {
      session: normalizeSession(rawSessions[1]),
      localMachine: 'studio',
      onJump: jest.fn(),
      onOpen: jest.fn(),
    }));

    expect(html).toContain('Summary pending');
    expect(html).toContain('summary-skeleton');
    expect(html).not.toContain('local machine');
  });

  test('SessionsPanel renders filter controls and populated grid', () => {
    const html = renderToStaticMarkup(React.createElement(SessionsPanel, {
      sessions: rawSessions,
      connected: true,
      localMachine: 'studio',
    }));

    expect(html).toContain('Session filters');
    expect(html).toContain('workspace, path, summary');
    expect(html).toContain('2 / 2');
    expect(html).toContain('claude-main');
    expect(html).toContain('codex-pole');
  });

  test('SessionsPanel renders setup wizard CTA for empty state', () => {
    const html = renderToStaticMarkup(React.createElement(SessionsPanel, {
      sessions: [],
      connected: false,
      localMachine: 'studio',
    }));

    expect(html).toContain('No sessions yet');
    expect(html).toContain('Setup wizard');
    expect(html).toContain('SSE reconnecting');
  });
});
