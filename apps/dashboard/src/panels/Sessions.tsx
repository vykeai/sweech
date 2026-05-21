import React from 'react';
import { Card } from '@vykeai/vysual-react';
import { SessionTile } from '../components/SessionTile';
import {
  filterSessions,
  normalizeSession,
  sessionFilterOptions,
  sortSessions,
  type DashboardSession,
  type NormalizedSession,
  type SessionFilters,
  type SessionSort,
  type SessionStatus,
} from '../components/sessionViewModel';

type SessionsPanelProps = {
  sessions: DashboardSession[];
  connected: boolean;
  localMachine: string;
  onOpenSetupWizard?: () => void;
};

type RestoreState = {
  state: 'idle' | 'restoring' | 'error';
  error?: string;
};

const STATUS_OPTIONS: Array<{ value: 'all' | SessionStatus; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'live', label: 'Live' },
  { value: 'tmux-detached', label: 'Detached' },
  { value: 'crash-recoverable', label: 'Recoverable' },
  { value: 'closed', label: 'Closed' },
];

const SORT_OPTIONS: Array<{ value: SessionSort; label: string }> = [
  { value: 'last-active', label: 'Last active' },
  { value: 'launched', label: 'Launched' },
  { value: 'messages', label: 'Messages' },
  { value: 'workspace', label: 'Workspace' },
];

export function SessionsPanel({ sessions, connected, localMachine, onOpenSetupWizard }: SessionsPanelProps) {
  const normalized = React.useMemo(() => sessions.map(normalizeSession), [sessions]);
  const options = React.useMemo(() => sessionFilterOptions(normalized), [normalized]);
  const [filters, setFilters] = React.useState<SessionFilters>({ machine: '', status: 'all', workspace: '', search: '' });
  const [sort, setSort] = React.useState<SessionSort>('last-active');
  const [selected, setSelected] = React.useState<NormalizedSession | null>(null);
  const [restore, setRestore] = React.useState<Record<string, RestoreState>>({});

  const visibleSessions = React.useMemo(
    () => sortSessions(filterSessions(normalized, filters), sort),
    [filters, normalized, sort],
  );

  const updateFilter = <K extends keyof SessionFilters>(key: K, value: SessionFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const jumpToSession = async (session: NormalizedSession) => {
    if (!canJumpToSession(session, localMachine)) return;
    setRestore((current) => ({ ...current, [session.id]: { state: 'restoring' } }));
    try {
      const response = await fetch(`/dashboard/sessions/${encodeURIComponent(session.id)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; reason?: string };
      if (!response.ok || body.ok === false) {
        throw new Error(body.error ?? body.reason ?? 'Unable to open session');
      }
      setRestore((current) => ({ ...current, [session.id]: { state: 'idle' } }));
    } catch (error) {
      setRestore((current) => ({
        ...current,
        [session.id]: {
          state: 'error',
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  return (
    <Card className="sessions-panel">
      <div className="panel-heading">
        <div>
          <h2>Sessions</h2>
          <span>{connected ? 'SSE connected' : 'SSE reconnecting'}</span>
        </div>
        <div className="session-count" aria-label={`${visibleSessions.length} visible sessions`}>
          {visibleSessions.length} / {normalized.length}
        </div>
      </div>

      {normalized.length === 0 ? (
        <div className="empty-state" data-testid="sessions-empty-state">
          <strong>No sessions yet</strong>
          <p>Launch a workspace to create the first durable session tile.</p>
          <button data-testid="setup-wizard-open" onClick={onOpenSetupWizard} type="button">Setup wizard</button>
        </div>
      ) : (
        <>
          <div className="session-toolbar" aria-label="Session filters">
            <label>
              Search
              <input
                value={filters.search}
                onChange={(event: { target: { value: string } }) => updateFilter('search', event.target.value)}
                placeholder="workspace, path, summary"
                data-testid="session-search"
              />
            </label>
            <label>
              Machine
              <select value={filters.machine} onChange={(event: { target: { value: string } }) => updateFilter('machine', event.target.value)}>
                <option value="">All machines</option>
                {options.machines.map((machine) => <option key={machine} value={machine}>{machine}</option>)}
              </select>
            </label>
            <label>
              Status
              <select value={filters.status} onChange={(event: { target: { value: string } }) => updateFilter('status', event.target.value as SessionFilters['status'])}>
                {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              Workspace
              <select value={filters.workspace} onChange={(event: { target: { value: string } }) => updateFilter('workspace', event.target.value)}>
                <option value="">All workspaces</option>
                {options.workspaces.map((workspace) => <option key={workspace} value={workspace}>{workspace}</option>)}
              </select>
            </label>
            <label>
              Sort
              <select value={sort} onChange={(event: { target: { value: string } }) => setSort(event.target.value as SessionSort)}>
                {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>

          {visibleSessions.length === 0 ? (
            <div className="empty-state compact" data-testid="sessions-filter-empty">
              <strong>No matching sessions</strong>
              <p>Clear a filter or search for another workspace.</p>
              <button type="button" onClick={() => setFilters({ machine: '', status: 'all', workspace: '', search: '' })}>Clear filters</button>
            </div>
          ) : (
            <div className="session-grid">
              {visibleSessions.map((session) => (
                <SessionTile
                  key={session.id}
                  session={session}
                  localMachine={localMachine}
                  restoreState={restore[session.id]?.state}
                  restoreError={restore[session.id]?.error}
                  jumpDisabled={!canJumpToSession(session, localMachine)}
                  jumpLabel={jumpLabelForSession(session, localMachine)}
                  onJump={jumpToSession}
                  onOpen={setSelected}
                />
              ))}
            </div>
          )}
        </>
      )}

      {selected && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setSelected(null)}>
          <dialog className="session-detail-dialog" open aria-labelledby="session-detail-title" onClick={(event: { stopPropagation: () => void }) => event.stopPropagation()}>
            <div className="dialog-heading">
              <div>
                <h2 id="session-detail-title">{selected.workspace}</h2>
                <p>{selected.cwd}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setSelected(null)} aria-label="Close session details">×</button>
            </div>
            <dl className="session-detail-grid">
              <div><dt>Status</dt><dd>{selected.status}</dd></div>
              <div><dt>Machine</dt><dd>{selected.machine}</dd></div>
              <div><dt>tmux</dt><dd>{selected.tmuxName ?? 'none'}</dd></div>
              <div><dt>pid / tty</dt><dd>{selected.pid ? `${selected.pid}${selected.tty ? ` ${selected.tty}` : ''}` : 'none'}</dd></div>
              <div><dt>Messages</dt><dd>{selected.messageCount}</dd></div>
              <div><dt>Viewers</dt><dd>{selected.attachClients}</dd></div>
            </dl>
            <section className="detail-timeline" aria-label="Recent activity">
              <h3>Recent activity</h3>
              <ol>
                {(selected.summaryBullets.length ? selected.summaryBullets : ['Summary pending']).map((activity) => (
                  <li key={activity}>{activity}</li>
                ))}
              </ol>
            </section>
          </dialog>
        </div>
      )}
    </Card>
  );
}

function canJumpToSession(session: NormalizedSession, localMachine: string): boolean {
  return Boolean(localMachine && session.machine === localMachine && session.status !== 'closed');
}

function jumpLabelForSession(session: NormalizedSession, localMachine: string): string {
  if (!localMachine || session.machine !== localMachine) return 'Remote';
  if (session.status === 'closed') return 'Closed';
  return '↗ Jump';
}
