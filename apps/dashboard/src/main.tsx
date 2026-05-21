import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, themes } from '@vykeai/vysual-react';
import { create } from 'zustand';
import { HeroStrip } from './components/HeroStrip';
import { type DoctorCheck, deriveHeroStats } from './components/heroStats';
import { SettingsDrawer } from './components/SettingsDrawer';
import { SetupWizard } from './components/SetupWizard';
import { SessionsPanel } from './panels/Sessions';
import { type DashboardSession } from './components/sessionViewModel';
import { AccountsPanel } from './panels/Accounts';
import { AuditPanel } from './panels/Audit';
import { BillingPanel } from './panels/Billing';
import { CostPanel } from './panels/Cost';
import { DoctorPanel } from './panels/Doctor';
import { FailoverPanel } from './panels/Failover';
import { FederationPanel } from './panels/Federation';
import { LogsPanel } from './panels/Logs';
import { PluginsPanel } from './panels/Plugins';
import { RoutingPanel } from './panels/Routing';
import { SettingsPanel } from './panels/Settings';
import { TemplatesPanel } from './panels/Templates';
import { WorkspacesPanel } from './panels/Workspaces';
import { type DashboardAccount, type DashboardAuditFinding, type DashboardAuditState, type DashboardBillingState, type DashboardCostState, type DashboardDoctorState, type DashboardFailoverState, type DashboardFederationState, type DashboardLogLine, type DashboardLogsState, type DashboardPluginsState, type DashboardRouteCandidate, type DashboardRoutingState, type DashboardSettingsState, type DashboardTemplatesState, type DashboardWorkspace } from './components/panelViewModel';
import './styles.css';

type DashboardState = {
  sessions: DashboardSession[];
  workspaces: DashboardWorkspace[];
  accounts: DashboardAccount[];
  cost: DashboardCostState;
  audit: DashboardAuditState;
  failover: DashboardFailoverState;
  routing: DashboardRoutingState;
  billing: DashboardBillingState;
  doctor: DashboardDoctorState;
  logs: DashboardLogsState;
  plugins: DashboardPluginsState;
  templates: DashboardTemplatesState;
  federation: DashboardFederationState;
  settings: DashboardSettingsState;
  doctorChecks: DoctorCheck[];
  connected: boolean;
  localMachine: string;
  panels: Record<string, 'idle' | 'loading' | 'ready'>;
  setConnected: (connected: boolean) => void;
  applyInitialState: (state: { sessions?: DashboardSession[]; machine?: string; workspaces?: DashboardWorkspace[]; accounts?: DashboardAccount[]; cost?: DashboardCostState; audit?: DashboardAuditState; failover?: DashboardFailoverState; routing?: DashboardRoutingState; billing?: DashboardBillingState; doctor?: DashboardDoctorState; logs?: DashboardLogsState; plugins?: DashboardPluginsState; templates?: DashboardTemplatesState; federation?: DashboardFederationState; settings?: DashboardSettingsState }) => void;
  updateWorkspace: (workspace: DashboardWorkspace) => void;
  applyAuditFix: (profile: string, action: NonNullable<DashboardAuditFinding['fixAction']>) => void;
  clearCooldown: (commandName: string) => void;
  upsertSession: (session: DashboardSession) => void;
  applyDoctorTick: (payload: unknown) => void;
  setDoctor: (doctor: DashboardDoctorState) => void;
  appendLogs: (lines: DashboardLogLine[]) => void;
  setPlugins: (plugins: DashboardPluginsState) => void;
  setTemplates: (templates: DashboardTemplatesState) => void;
  setFederation: (federation: DashboardFederationState) => void;
  setSettings: (settings: DashboardSettingsState) => void;
};

type DashboardInitialPayload = {
  sessions?: unknown;
  machine?: unknown;
  workspaces?: unknown;
  accounts?: unknown;
  cost?: unknown;
  audit?: unknown;
  failover?: unknown;
  routing?: unknown;
  billing?: unknown;
  doctor?: unknown;
  logs?: unknown;
  plugins?: unknown;
  templates?: unknown;
  federation?: unknown;
  settings?: unknown;
};

const emptyCost: DashboardCostState = {
  spent7dUsd: 0,
  estCostPerCallUsd: 0,
  providers: [],
  sparkline: [],
};
const emptyAudit: DashboardAuditState = { scanned: 0, totalIssues: 0, fixable: 0, findings: [] };
const emptyFailover: DashboardFailoverState = { cooldowns: [] };
const emptyRouting: DashboardRoutingState = { selected: null, rejectedCount: 0, pin: null, candidates: [] };
const emptyBilling: DashboardBillingState = { days: [], entries: [] };
const emptyDoctor: DashboardDoctorState = { status: 'ok', checks: [] };
const emptyLogs: DashboardLogsState = { lines: [] };
const emptyPlugins: DashboardPluginsState = { total: 0, enabled: 0, plugins: [] };
const emptyTemplates: DashboardTemplatesState = { total: 0, custom: 0, templates: [] };
const emptyFederation: DashboardFederationState = { enabled: true, peers: [] };
const emptySettings: DashboardSettingsState = {
  general: { machine: '' },
  tmux: { enabled: true, namingScheme: 'workspace-cwd', suffix: 'sweech' },
  terminal: { preferred: 'auto' },
  summaries: { enabled: true, providerOrder: ['anthropic'], budgetPerSummaryUsd: 0.15, budgetPerDayUsd: 5, model: 'auto' },
  federation: { enabled: true, discoveryMethod: 'peers-file' },
  retention: { autoWipe: false, wipeOlderThanDays: 30 },
  refresh: { sessionsMs: 2000, peersMs: 30000, doctorNetworkMs: 60000 },
};

const useDashboardStore = create<DashboardState>((set) => ({
  sessions: [],
  workspaces: [],
  accounts: [],
  cost: emptyCost,
  audit: emptyAudit,
  failover: emptyFailover,
  routing: emptyRouting,
  billing: emptyBilling,
  doctor: emptyDoctor,
  logs: emptyLogs,
  plugins: emptyPlugins,
  templates: emptyTemplates,
  federation: emptyFederation,
  settings: emptySettings,
  doctorChecks: [],
  connected: false,
  localMachine: '',
  panels: {
    sessions: 'idle',
    workspaces: 'idle',
    accounts: 'idle',
    cost: 'idle',
    audit: 'idle',
    failover: 'idle',
    routing: 'idle',
    billing: 'idle',
  },
  setConnected: (connected) => set({ connected }),
  applyInitialState: (state) => set((current) => ({
    sessions: state.sessions ?? current.sessions,
    workspaces: state.workspaces ?? current.workspaces,
    accounts: state.accounts ?? current.accounts,
    cost: state.cost ?? current.cost,
    audit: state.audit ?? current.audit,
    failover: state.failover ?? current.failover,
    routing: state.routing ?? current.routing,
    billing: state.billing ?? current.billing,
    doctor: state.doctor ?? current.doctor,
    logs: state.logs ?? current.logs,
    plugins: state.plugins ?? current.plugins,
    templates: state.templates ?? current.templates,
    federation: state.federation ?? current.federation,
    settings: state.settings ?? current.settings,
    localMachine: state.machine ?? current.localMachine,
    panels: { ...current.panels, sessions: 'ready', workspaces: 'ready', accounts: 'ready', cost: 'ready', audit: 'ready', failover: 'ready', routing: 'ready', billing: 'ready', doctor: 'ready', logs: 'ready', plugins: 'ready', templates: 'ready', federation: 'ready', settings: 'ready' },
  })),
  updateWorkspace: (workspace) => set((state) => ({
    workspaces: state.workspaces.map((item) => item.commandName === workspace.commandName ? { ...item, ...workspace } : item),
    panels: { ...state.panels, workspaces: 'ready' },
  })),
  applyAuditFix: (profile, action) => set((state) => ({
    audit: {
      ...state.audit,
      findings: state.audit.findings.filter((finding) => !(finding.profile === profile && finding.fixAction === action)),
      totalIssues: Math.max(0, state.audit.totalIssues - 1),
      fixable: Math.max(0, state.audit.fixable - 1),
    },
    panels: { ...state.panels, audit: 'ready' },
  })),
  clearCooldown: (commandName) => set((state) => ({
    failover: { ...state.failover, cooldowns: state.failover.cooldowns.filter((cooldown) => cooldown.commandName !== commandName) },
    panels: { ...state.panels, failover: 'ready' },
  })),
  upsertSession: (session) => set((state) => ({
    sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
    panels: { ...state.panels, sessions: 'ready' },
  })),
  applyDoctorTick: (payload) => set((state) => ({
    doctorChecks: doctorChecksFromPayload(payload),
    doctor: doctorStateFromTick(payload, state.doctor),
    panels: { ...state.panels, doctor: 'ready' },
  })),
  setDoctor: (doctor) => set((state) => ({
    doctor,
    panels: { ...state.panels, doctor: 'ready' },
  })),
  appendLogs: (lines) => set((state) => ({
    logs: {
      ...state.logs,
      lines: mergeLogLines(state.logs.lines, lines).slice(-40),
    },
    panels: { ...state.panels, logs: 'ready' },
  })),
  setPlugins: (plugins) => set((state) => ({
    plugins,
    panels: { ...state.panels, plugins: 'ready' },
  })),
  setTemplates: (templates) => set((state) => ({
    templates,
    panels: { ...state.panels, templates: 'ready' },
  })),
  setFederation: (federation) => set((state) => ({
    federation,
    panels: { ...state.panels, federation: 'ready' },
  })),
  setSettings: (settings) => set((state) => ({
    settings,
    panels: { ...state.panels, settings: 'ready' },
  })),
}));

function useInitialState(url: string) {
  const applyInitialState = useDashboardStore((state) => state.applyInitialState);

  React.useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        const payload = data as DashboardInitialPayload | null;
        if (!cancelled && payload && Array.isArray(payload.sessions)) {
          applyInitialState({
            sessions: payload.sessions as DashboardSession[],
            machine: typeof payload.machine === 'string' ? payload.machine : undefined,
            workspaces: Array.isArray(payload.workspaces) ? payload.workspaces as DashboardWorkspace[] : undefined,
            accounts: Array.isArray(payload.accounts) ? payload.accounts as DashboardAccount[] : undefined,
            cost: payload.cost && typeof payload.cost === 'object' ? payload.cost as DashboardCostState : undefined,
            audit: payload.audit && typeof payload.audit === 'object' ? payload.audit as DashboardAuditState : undefined,
            failover: payload.failover && typeof payload.failover === 'object' ? payload.failover as DashboardFailoverState : undefined,
            routing: payload.routing && typeof payload.routing === 'object' ? payload.routing as DashboardRoutingState : undefined,
            billing: payload.billing && typeof payload.billing === 'object' ? payload.billing as DashboardBillingState : undefined,
            doctor: payload.doctor && typeof payload.doctor === 'object' ? payload.doctor as DashboardDoctorState : undefined,
            logs: payload.logs && typeof payload.logs === 'object' ? payload.logs as DashboardLogsState : undefined,
            plugins: payload.plugins && typeof payload.plugins === 'object' ? payload.plugins as DashboardPluginsState : undefined,
            templates: payload.templates && typeof payload.templates === 'object' ? payload.templates as DashboardTemplatesState : undefined,
            federation: payload.federation && typeof payload.federation === 'object' ? payload.federation as DashboardFederationState : undefined,
            settings: payload.settings && typeof payload.settings === 'object' ? payload.settings as DashboardSettingsState : undefined,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [applyInitialState, url]);
}

function useSSE(url: string) {
  const setConnected = useDashboardStore((state) => state.setConnected);
  const upsertSession = useDashboardStore((state) => state.upsertSession);
  const applyDoctorTick = useDashboardStore((state) => state.applyDoctorTick);
  const appendLogs = useDashboardStore((state) => state.appendLogs);

  React.useEffect(() => {
    let retry = 500;
    let closed = false;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      source = new EventSource(url);
      source.onopen = () => {
        retry = 500;
        setConnected(true);
      };
      const handleSessionChanged: EventListener = (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data);
          const session = payload.session ?? payload.data?.session;
          if (session?.id) {
            upsertSession(session);
          }
        } catch {
          return;
        }
      };
      const handleDoctorTick: EventListener = (event) => {
        try {
          applyDoctorTick(JSON.parse((event as MessageEvent).data));
        } catch {
          return;
        }
      };
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          const session = payload.session ?? payload.data?.session;
          if ((payload.type === 'session.changed' || event.type === 'message') && session?.id) {
            upsertSession(session);
          }
        } catch {
          return;
        }
      };
      source.addEventListener('session.changed', handleSessionChanged);
      source.addEventListener('summary.updated', handleSessionChanged);
      source.addEventListener('doctor.tick', handleDoctorTick);
      source.addEventListener('log.appended', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { lines?: unknown };
          if (Array.isArray(payload.lines)) appendLogs(payload.lines as DashboardLogLine[]);
        } catch {
          return;
        }
      });
      source.onerror = () => {
        setConnected(false);
        source?.close();
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    };

    connect();
    return () => {
      closed = true;
      setConnected(false);
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [appendLogs, applyDoctorTick, setConnected, upsertSession, url]);
}

function useDoctorRefresh(url: string) {
  const setDoctor = useDashboardStore((state) => state.setDoctor);
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      const res = await fetch(url).catch(() => null);
      if (!cancelled && res?.ok) setDoctor(await res.json() as DashboardDoctorState);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    timer = setInterval(() => void refresh(), 60_000);
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [setDoctor, url]);
}

function useSummaryRequests(sessions: DashboardSession[]) {
  const requested = React.useRef(new Set<string>());
  React.useEffect(() => {
    for (const session of sessions) {
      const stale = session.summaryStale ?? session.summary_stale ?? true;
      const summary = session.summaryOne ?? session.summary_one;
      if (!session.id || requested.current.has(session.id) || (!stale && summary)) continue;
      requested.current.add(session.id);
      fetch(`/dashboard/sessions/${encodeURIComponent(session.id)}/summary`, { method: 'POST' })
        .catch(() => {
          requested.current.delete(session.id);
        });
    }
  }, [sessions]);
}

function App() {
  useInitialState('/dashboard/state');
  useSSE('/dashboard/events');
  useDoctorRefresh('/dashboard/doctor');
  const { connected, sessions, doctorChecks, localMachine, workspaces, accounts, cost, audit, failover, routing, billing, doctor, logs, plugins, templates, federation, settings } = useDashboardStore();
  const updateWorkspace = useDashboardStore((state) => state.updateWorkspace);
  const applyAuditFix = useDashboardStore((state) => state.applyAuditFix);
  const clearCooldown = useDashboardStore((state) => state.clearCooldown);
  const setDoctor = useDashboardStore((state) => state.setDoctor);
  const setPlugins = useDashboardStore((state) => state.setPlugins);
  const setTemplates = useDashboardStore((state) => state.setTemplates);
  const setFederation = useDashboardStore((state) => state.setFederation);
  const setSettings = useDashboardStore((state) => state.setSettings);
  const applyInitialState = useDashboardStore((state) => state.applyInitialState);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [setupOpen, setSetupOpen] = React.useState(false);
  const refreshDashboardState = React.useCallback(async () => {
    const res = await fetch('/dashboard/state');
    if (!res.ok) return;
    const payload = await res.json() as DashboardInitialPayload;
    applyInitialState({
      sessions: Array.isArray(payload.sessions) ? payload.sessions as DashboardSession[] : undefined,
      machine: typeof payload.machine === 'string' ? payload.machine : undefined,
      workspaces: Array.isArray(payload.workspaces) ? payload.workspaces as DashboardWorkspace[] : undefined,
      accounts: Array.isArray(payload.accounts) ? payload.accounts as DashboardAccount[] : undefined,
      cost: payload.cost && typeof payload.cost === 'object' ? payload.cost as DashboardCostState : undefined,
      audit: payload.audit && typeof payload.audit === 'object' ? payload.audit as DashboardAuditState : undefined,
      failover: payload.failover && typeof payload.failover === 'object' ? payload.failover as DashboardFailoverState : undefined,
      routing: payload.routing && typeof payload.routing === 'object' ? payload.routing as DashboardRoutingState : undefined,
      billing: payload.billing && typeof payload.billing === 'object' ? payload.billing as DashboardBillingState : undefined,
      doctor: payload.doctor && typeof payload.doctor === 'object' ? payload.doctor as DashboardDoctorState : undefined,
      logs: payload.logs && typeof payload.logs === 'object' ? payload.logs as DashboardLogsState : undefined,
      plugins: payload.plugins && typeof payload.plugins === 'object' ? payload.plugins as DashboardPluginsState : undefined,
      templates: payload.templates && typeof payload.templates === 'object' ? payload.templates as DashboardTemplatesState : undefined,
      federation: payload.federation && typeof payload.federation === 'object' ? payload.federation as DashboardFederationState : undefined,
      settings: payload.settings && typeof payload.settings === 'object' ? payload.settings as DashboardSettingsState : undefined,
    });
  }, [applyInitialState]);
  const refreshFederation = React.useCallback(async () => {
    const res = await fetch('/dashboard/federation');
    if (res.ok) setFederation(await res.json() as DashboardFederationState);
  }, [setFederation]);
  const refreshDoctor = React.useCallback(async () => {
    const res = await fetch('/dashboard/doctor');
    if (res.ok) setDoctor(await res.json() as DashboardDoctorState);
  }, [setDoctor]);
  const pinRoute = React.useCallback(async (candidate: DashboardRouteCandidate) => {
    const res = await fetch('/dashboard/routing/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: candidate.commandName,
        cliType: candidate.cliType,
        model: candidate.model ?? undefined,
        cwd: routing.searchRoot,
      }),
    });
    if (res.ok) await refreshDashboardState();
  }, [refreshDashboardState, routing.searchRoot]);
  const unpinRoute = React.useCallback(async () => {
    const res = await fetch('/dashboard/routing/pin', { method: 'DELETE' });
    if (res.ok) await refreshDashboardState();
  }, [refreshDashboardState]);
  useSummaryRequests(sessions);
  const heroSessions = sessions.map((session) => ({
    ...session,
    summaryCostUsd: session.summaryCostUsd ?? session.summary_cost_usd ?? null,
    summaryAt: session.summaryAt ?? session.summary_at ?? null,
    launchedAt: session.launchedAt ?? session.launched_at ?? null,
  }));
  const heroStats = deriveHeroStats(heroSessions, doctor.checks?.length ? doctor.checks : doctorChecks);

  return (
    <ThemeProvider theme={themes.sweech}>
      <main className="dashboard-shell">
        <HeroStrip connected={connected} stats={heroStats} />

        <SessionsPanel sessions={sessions} connected={connected} localMachine={localMachine} onOpenSetupWizard={() => setSetupOpen(true)} />

        <section className="mid-grid" aria-label="Dashboard panels">
          <WorkspacesPanel workspaces={workspaces} onWorkspaceSaved={updateWorkspace} />
          <AccountsPanel accounts={accounts} />
          <CostPanel cost={cost} />
          <AuditPanel audit={audit} onAuditFixed={applyAuditFix} />
          <FailoverPanel failover={failover} onCooldownCleared={clearCooldown} />
          <RoutingPanel routing={routing} onPinSet={pinRoute} onPinUnset={unpinRoute} />
          <BillingPanel billing={billing} />
          <DoctorPanel doctor={doctor} onRefresh={refreshDoctor} />
          <LogsPanel logs={logs} />
          <PluginsPanel plugins={plugins} onPluginsChanged={setPlugins} />
          <TemplatesPanel templates={templates} onTemplatesChanged={setTemplates} />
          <FederationPanel federation={federation} onRefresh={refreshFederation} />
          <SettingsPanel settings={settings} onOpen={() => setSettingsOpen(true)} />
        </section>
        <SettingsDrawer open={settingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} onSave={setSettings} />
        <SetupWizard open={setupOpen} settings={settings} workspaces={workspaces} onClose={() => setSetupOpen(false)} />
      </main>
    </ThemeProvider>
  );
}

function mergeLogLines(existing: DashboardLogLine[], incoming: DashboardLogLine[]): DashboardLogLine[] {
  const byKey = new Map<string, DashboardLogLine>();
  for (const line of [...existing, ...incoming]) {
    byKey.set(`${line.index}:${line.message}`, line);
  }
  return [...byKey.values()].sort((a, b) => a.index - b.index);
}

function doctorChecksFromPayload(payload: unknown): DoctorCheck[] {
  if (!payload || typeof payload !== 'object') return [];
  const source = payload as { checks?: unknown; data?: { checks?: unknown }; ok?: boolean; status?: DoctorCheck['status'] };
  const checks = Array.isArray(source.checks)
    ? source.checks
    : Array.isArray(source.data?.checks)
      ? source.data.checks
      : undefined;
  if (checks) return checks.filter((check): check is DoctorCheck => Boolean(check && typeof check === 'object'));
  return [{ ok: source.ok, status: source.status }];
}

function doctorStateFromTick(payload: unknown, current: DashboardDoctorState): DashboardDoctorState {
  const checks = doctorChecksFromPayload(payload)
    .filter((check): check is DoctorCheck & { name?: string; detail?: string; category?: string } => Boolean(check && typeof check === 'object'))
    .map((check, index) => {
      const category: DashboardDoctorState['checks'][number]['category'] = check.category === 'network' ? 'network' : 'structural';
      const status: DashboardDoctorState['checks'][number]['status'] = check.status === 'error' || check.status === 'warn' || check.status === 'ok'
        ? check.status
        : check.ok === false
          ? 'error'
          : 'ok';
      return {
        name: typeof check.name === 'string' ? check.name : `Doctor check ${index + 1}`,
        status,
        detail: typeof check.detail === 'string' ? check.detail : check.ok === false ? 'Check failed' : 'Check passed',
        category,
      };
    });
  if (checks.length === 0) return current;
  return {
    ...current,
    generatedAt: new Date().toISOString(),
    status: checks.some((check) => check.status === 'error') ? 'error' : checks.some((check) => check.status === 'warn') ? 'warn' : 'ok',
    checks,
  };
}

createRoot(document.getElementById('root')!).render(<App />);
