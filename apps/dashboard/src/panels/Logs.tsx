import { Card } from '@vykeai/vysual-react';
import { logTone, safeTestId, type DashboardLogsState } from '../components/panelViewModel';
import React from 'react';

export function LogsPanel({ logs }: { logs: DashboardLogsState }) {
  const lines = logs.lines ?? [];
  const events = Array.from(new Set(lines.map((line) => line.event).filter((event): event is string => Boolean(event)))).sort();
  const [eventFilter, setEventFilter] = React.useState('all');
  const visibleLines = eventFilter === 'all' ? lines : lines.filter((line) => line.event === eventFilter);
  return (
    <Card className="panel data-panel logs-panel">
      <div className="panel-heading">
        <h2>Logs</h2>
        <span>{visibleLines.length}/{lines.length} lifecycle entries</span>
      </div>
      <div className="compact-form">
        <label>
          Event
          <select data-testid="logs-event-filter" value={eventFilter} onChange={(event: { target: { value: string } }) => setEventFilter(event.target.value)}>
            <option value="all">All events</option>
            {events.map((event) => <option key={event} value={event}>{event}</option>)}
          </select>
        </label>
      </div>
      <div className="log-tail" data-testid="logs-tail">
        {visibleLines.length === 0 ? (
          <p className="empty-state compact">No lifecycle events yet.</p>
        ) : visibleLines.slice(-10).map((line) => (
          <div className="log-row" data-testid={`log-row-${line.index}`} key={`${line.index}-${safeTestId(line.message)}`}>
            <span className={`pill pill-${logTone(line.severity)}`}>{line.severity}</span>
            <div>
              <strong>{line.event ?? 'event'}</strong>
              <p>{line.message}</p>
              <small>{line.profile ? `${line.profile} · ` : ''}{formatTime(line.at)}</small>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function formatTime(value: string | undefined): string {
  if (!value) return 'just now';
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return value;
  return new Date(millis).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
