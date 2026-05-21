import { Card } from '@vykeai/vysual-react';
import { safeTestId, type DashboardPluginsState } from '../components/panelViewModel';
import React from 'react';

export function PluginsPanel({ plugins, onPluginsChanged }: { plugins: DashboardPluginsState; onPluginsChanged?: (plugins: DashboardPluginsState) => void }) {
  const rows = plugins.plugins ?? [];
  const [npmPackage, setNpmPackage] = React.useState('');
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const install = async () => {
    const nextPackage = npmPackage.trim();
    if (!nextPackage) return;
    setPending('install');
    setError(null);
    try {
      const res = await fetch('/dashboard/plugins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: nextPackage }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Plugin install failed');
      onPluginsChanged?.(await res.json() as DashboardPluginsState);
      setNpmPackage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const uninstall = async (name: string) => {
    setPending(name);
    setError(null);
    try {
      const res = await fetch(`/dashboard/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Plugin remove failed');
      onPluginsChanged?.(await res.json() as DashboardPluginsState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <Card className="panel data-panel plugins-panel">
      <div className="panel-heading">
        <h2>Plugins</h2>
        <span>{plugins.enabled}/{plugins.total} enabled</span>
      </div>
      <div className="inline-form">
        <input aria-label="Plugin package" data-testid="plugin-package-input" placeholder="@scope/sweech-plugin" value={npmPackage} onChange={(event: { target: { value: string } }) => setNpmPackage(event.target.value)} />
        <button className="jump-button" data-testid="plugin-install" disabled={pending === 'install' || npmPackage.trim().length === 0} onClick={() => void install()} type="button">
          {pending === 'install' ? 'Installing' : 'Install'}
        </button>
      </div>
      <div className="ops-list">
        {rows.length === 0 ? (
          <p className="empty-state compact">No plugins installed.</p>
        ) : rows.map((plugin) => (
          <div className="ops-row" data-testid={`plugin-row-${safeTestId(plugin.name)}`} key={plugin.name}>
            <div>
              <strong>{plugin.name}</strong>
              <span>v{plugin.version}</span>
            </div>
            <div className="row-actions">
              <span className={`pill pill-${plugin.enabled ? 'success' : 'muted'}`}>{plugin.enabled ? 'enabled' : 'disabled'}</span>
              <button className="jump-button danger-button" data-testid={`plugin-remove-${safeTestId(plugin.name)}`} disabled={pending === plugin.name} onClick={() => void uninstall(plugin.name)} type="button">
                {pending === plugin.name ? 'Removing' : 'Remove'}
              </button>
            </div>
          </div>
        ))}
      </div>
      {error ? <p className="restore-error">{error}</p> : null}
    </Card>
  );
}
