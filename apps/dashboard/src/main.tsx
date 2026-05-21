import React from 'react';
import { createRoot } from 'react-dom/client';
import { Card, ThemeProvider, themes } from '@vykeai/vysual-react';
import { create } from 'zustand';
import { FreshnessChip, HeroStrip, ViewerCountBadge } from './components/HeroStrip';
import { type DoctorCheck, deriveHeroStats } from './components/heroStats';
import './styles.css';

type SessionStatus = 'live' | 'tmux-detached' | 'crash-recoverable' | 'closed';

type DashboardSession = {
  id: string;
  workspace: string;
  cwd: string;
  machine: string;
  status: SessionStatus;
  lastActiveAt?: number;
  last_active_at?: number;
  launchedAt?: number | null;
  launched_at?: number | null;
  summaryCostUsd?: number | null;
  summary_cost_usd?: number | null;
  summaryAt?: number | null;
  summary_at?: number | null;
  summaryStale?: boolean;
  summary_stale?: boolean;
  summaryOne?: string | null;
  summary_one?: string | null;
  summaryBullets?: string[] | string | null;
  summary_bullets?: string[] | string | null;
  attachClients?: number;
  attach_clients?: number;
};

type DashboardState = {
  sessions: DashboardSession[];
  doctorChecks: DoctorCheck[];
  connected: boolean;
  panels: Record<string, 'idle' | 'loading' | 'ready'>;
  setConnected: (connected: boolean) => void;
  applySessions: (sessions: DashboardSession[]) => void;
  upsertSession: (session: DashboardSession) => void;
  applyDoctorTick: (payload: unknown) => void;
};

const useDashboardStore = create<DashboardState>((set) => ({
  sessions: [],
  doctorChecks: [],
  connected: false,
  panels: {
    sessions: 'idle',
    workspaces: 'idle',
    accounts: 'idle',
    cost: 'idle',
    audit: 'idle',
    failover: 'idle',
  },
  setConnected: (connected) => set({ connected }),
  applySessions: (sessions) => set({ sessions, panels: { sessions: 'ready' } }),
  upsertSession: (session) => set((state) => ({
    sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
    panels: { ...state.panels, sessions: 'ready' },
  })),
  applyDoctorTick: (payload) => set((state) => ({
    doctorChecks: doctorChecksFromPayload(payload),
    panels: { ...state.panels, audit: 'ready' },
  })),
}));

function useInitialState(url: string) {
  const applySessions = useDashboardStore((state) => state.applySessions);

  React.useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!cancelled && Array.isArray(data?.sessions)) applySessions(data.sessions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [applySessions, url]);
}

function useSSE(url: string) {
  const setConnected = useDashboardStore((state) => state.setConnected);
  const upsertSession = useDashboardStore((state) => state.upsertSession);
  const applyDoctorTick = useDashboardStore((state) => state.applyDoctorTick);

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
      const handleSessionChanged = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data);
          const session = payload.session ?? payload.data?.session;
          if (session?.id) {
            upsertSession(session);
          }
        } catch {
          return;
        }
      };
      const handleDoctorTick = (event: MessageEvent) => {
        try {
          applyDoctorTick(JSON.parse(event.data));
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
  }, [applyDoctorTick, setConnected, upsertSession, url]);
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

function PlaceholderPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <Card className="panel">
      <h2>{title}</h2>
      <p>{detail}</p>
    </Card>
  );
}

function App() {
  useInitialState('/dashboard/state');
  useSSE('/dashboard/events');
  const { connected, sessions, doctorChecks } = useDashboardStore();
  useSummaryRequests(sessions);
  const heroSessions = sessions.map((session) => ({
    ...session,
    summaryCostUsd: session.summaryCostUsd ?? session.summary_cost_usd ?? null,
    summaryAt: session.summaryAt ?? session.summary_at ?? null,
    launchedAt: session.launchedAt ?? session.launched_at ?? null,
  }));
  const heroStats = deriveHeroStats(heroSessions, doctorChecks);

  return (
    <ThemeProvider theme={themes.sweech}>
      <main className="dashboard-shell">
        <HeroStrip connected={connected} stats={heroStats} />

        <Card className="sessions-panel">
          <div className="panel-heading">
            <h2>Sessions</h2>
            <span>{connected ? 'SSE connected' : 'SSE reconnecting'}</span>
          </div>
          {sessions.length === 0 ? (
            <div className="empty-state">
              <strong>No sessions yet</strong>
              <p>Launch a workspace to create the first durable session tile.</p>
              <button type="button">Setup</button>
            </div>
          ) : (
            <div className="session-grid">
              {sessions.map((session) => (
                <article className="session-tile" key={session.id}>
                  <span className={`status-dot status-${session.status}`} />
                  <strong>{session.workspace}</strong>
                  <p>{session.cwd}</p>
                  <p className="session-summary">{session.summaryOne ?? session.summary_one ?? 'Summary pending'}</p>
                  {normalizeBullets(session.summaryBullets ?? session.summary_bullets).length > 0 && (
                    <ul className="session-activities">
                      {normalizeBullets(session.summaryBullets ?? session.summary_bullets).map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  )}
                  <div className="session-meta">
                    <span>{session.machine}</span>
                    <FreshnessChip state={session.summaryStale ?? session.summary_stale ? 'stale' : 'fresh'} />
                    <ViewerCountBadge count={session.attachClients ?? session.attach_clients ?? 0} />
                  </div>
                </article>
              ))}
            </div>
          )}
        </Card>

        <section className="mid-grid" aria-label="Dashboard panels">
          <PlaceholderPanel title="Workspaces" detail="Workspace health and launch controls land here." />
          <PlaceholderPanel title="Accounts" detail="Vault, plan, and rate-limit state land here." />
          <PlaceholderPanel title="Cost" detail="Spend and usage mix land here." />
          <PlaceholderPanel title="Audit" detail="Fixable profile findings land here." />
          <PlaceholderPanel title="Failover" detail="Cooldowns and routing decisions land here." />
          <PlaceholderPanel title="Billing" detail="Renewal calendar and balance gaps land here." />
        </section>
      </main>
    </ThemeProvider>
  );
}

function normalizeBullets(value: DashboardSession['summaryBullets']): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    return value.split(/\n+/).map((item) => item.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  }
  return [];
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

createRoot(document.getElementById('root')!).render(<App />);
