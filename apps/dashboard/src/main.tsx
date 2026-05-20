import React from 'react';
import { createRoot } from 'react-dom/client';
import { Card, ThemeProvider, themes } from '@vykeai/vysual-react';
import { create } from 'zustand';
import './styles.css';

type SessionStatus = 'live' | 'tmux-detached' | 'crash-recoverable' | 'closed';

type DashboardSession = {
  id: string;
  workspace: string;
  cwd: string;
  machine: string;
  status: SessionStatus;
  lastActiveAt: number;
};

type DashboardState = {
  sessions: DashboardSession[];
  connected: boolean;
  panels: Record<string, 'idle' | 'loading' | 'ready'>;
  setConnected: (connected: boolean) => void;
  applySessions: (sessions: DashboardSession[]) => void;
};

const useDashboardStore = create<DashboardState>((set) => ({
  sessions: [],
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
}));

function useSSE(url: string) {
  const setConnected = useDashboardStore((state) => state.setConnected);

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
  }, [setConnected, url]);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
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
  useSSE('/dashboard/events');
  const { connected, sessions } = useDashboardStore();
  const liveCount = sessions.filter((session) => session.status === 'live').length;
  const recoverableCount = sessions.filter((session) => session.status === 'crash-recoverable').length;

  return (
    <ThemeProvider theme={themes.sweech}>
      <main className="dashboard-shell">
        <section className="hero-strip" aria-label="Dashboard summary">
          <div>
            <p className="eyebrow">sweech control panel</p>
            <h1>Sessions, accounts, routing, and recovery</h1>
          </div>
          <Metric label="Doctor" value={connected ? 'streaming' : 'waiting'} />
          <Metric label="Live" value={String(liveCount)} />
          <Metric label="Recoverable" value={String(recoverableCount)} />
          <Metric label="Cost MTD" value="$0.00" />
        </section>

        <Card className="sessions-panel">
          <div className="panel-heading">
            <h2>Sessions</h2>
            <span>{connected ? 'SSE connected' : 'SSE reconnecting'}</span>
          </div>
          <div className="empty-state">
            <strong>No sessions yet</strong>
            <p>Launch a workspace to create the first durable session tile.</p>
            <button type="button">Setup</button>
          </div>
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

createRoot(document.getElementById('root')!).render(<App />);
