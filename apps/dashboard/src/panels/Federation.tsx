import { Card } from '@vykeai/vysual-react';
import { federationTone, safeTestId, type DashboardFederationState } from '../components/panelViewModel';

export function FederationPanel({ federation, onRefresh }: { federation: DashboardFederationState; onRefresh?: () => void }) {
  const peers = federation.peers ?? [];
  const online = peers.filter((peer) => peer.status === 'online').length;
  return (
    <Card className="panel data-panel federation-panel">
      <div className="panel-heading">
        <h2>Federation</h2>
        <span>{federation.enabled ? `${online} online · ${peers.length} peers` : 'disabled'}</span>
      </div>
      <div className="status-summary">
        <span className={`pill pill-${federation.enabled ? 'success' : 'muted'}`}>{federation.enabled ? 'enabled' : 'disabled'}</span>
        <button className="jump-button" data-testid="federation-refresh" onClick={onRefresh} type="button">Refresh</button>
      </div>
      <div className="ops-list">
        {peers.length === 0 ? (
          <p className="empty-state compact">No dashboard peers have checked in.</p>
        ) : peers.map((peer) => (
          <div className="ops-row federation-peer-card" data-testid={`federation-peer-${safeTestId(peer.hostname)}`} key={`${peer.url}-${peer.hostname}`}>
            <div>
              <strong>{peer.hostname}</strong>
              <span>{peer.url}</span>
              <p>{peer.sessionCount} sessions · last seen {formatLastSeen(peer.lastSeen)}</p>
              <div className="capability-row" aria-label={`${peer.hostname} capabilities`}>
                {(peer.capabilities.length ? peer.capabilities : ['no capabilities']).slice(0, 4).map((capability) => (
                  <span className="pill pill-muted" key={capability}>{capability}</span>
                ))}
              </div>
            </div>
            <span className={`pill pill-${federationTone(peer.status)}`}>{peer.status}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function formatLastSeen(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return 'never';
  return new Date(millis).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
