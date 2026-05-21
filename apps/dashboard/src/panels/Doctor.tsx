import { Card } from '@vykeai/vysual-react';
import { doctorTone, type DashboardDoctorState } from '../components/panelViewModel';

export function DoctorPanel({ doctor, onRefresh }: { doctor: DashboardDoctorState; onRefresh?: () => void }) {
  const checks = doctor.checks ?? [];
  return (
    <Card className="panel data-panel doctor-panel">
      <div className="panel-heading">
        <h2>Doctor</h2>
        <span>{checks.length} checks · next network tick {formatTime(doctor.nextNetworkRefreshAt)}</span>
      </div>
      <div className="status-summary">
        <span className={`pill pill-${doctorTone(doctor.status)}`}>{doctor.status}</span>
        <button className="jump-button" data-testid="doctor-refresh" onClick={onRefresh} type="button">Refresh</button>
      </div>
      <div className="ops-list">
        {checks.length === 0 ? (
          <p className="empty-state compact">No doctor checks yet.</p>
        ) : checks.map((check) => (
          <div className="ops-row" data-testid={`doctor-check-${check.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} key={`${check.category}-${check.name}`}>
            <div>
              <strong>{check.name}</strong>
              <span>{check.category}</span>
              <p>{check.detail}</p>
            </div>
            <span className={`pill pill-${doctorTone(check.status)}`}>{check.status}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function formatTime(value: string | undefined): string {
  if (!value) return 'paused';
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return 'paused';
  return new Date(millis).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
