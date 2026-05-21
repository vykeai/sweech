import { Card } from '@vykeai/vysual-react';
import { type DashboardSettingsState } from '../components/panelViewModel';

export function SettingsPanel({ settings, onOpen }: { settings: DashboardSettingsState; onOpen: () => void }) {
  return (
    <Card className="panel data-panel settings-panel">
      <div className="panel-heading">
        <h2>Settings</h2>
        <span>{settings.terminal.preferred} terminal · {settings.tmux.enabled ? 'tmux on' : 'tmux off'}</span>
      </div>
      <div className="ops-list">
        <div className="ops-row" data-testid="settings-summary-row">
          <div>
            <strong>{settings.general.machine}</strong>
            <span>summaries {settings.summaries.enabled ? 'enabled' : 'disabled'} · federation {settings.federation.enabled ? 'enabled' : 'disabled'}</span>
            <p>{settings.refresh.sessionsMs}ms sessions · {settings.refresh.peersMs}ms peers</p>
          </div>
          <button className="jump-button" data-testid="settings-open" onClick={onOpen} type="button">Open</button>
        </div>
      </div>
    </Card>
  );
}
