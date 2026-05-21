import React from 'react';
import { type DashboardSettingsState } from './panelViewModel';

export function SettingsDrawer({
  open,
  settings,
  onClose,
  onSave,
}: {
  open: boolean;
  settings: DashboardSettingsState;
  onClose: () => void;
  onSave: (settings: DashboardSettingsState) => void;
}) {
  const [draft, setDraft] = React.useState<DashboardSettingsState>(settings);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  if (!open) return null;

  const updateSection = <K extends keyof DashboardSettingsState>(section: K, patch: Partial<DashboardSettingsState[K]>) => {
    setDraft((current) => ({ ...current, [section]: { ...(current[section] as object), ...patch } }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/dashboard/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsPatch(settings, draft)),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Settings save failed');
      onSave(await res.json() as DashboardSettingsState);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop drawer-backdrop" role="presentation" onClick={onClose}>
      <aside className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-drawer-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div>
            <h2 id="settings-drawer-title">Settings</h2>
            <p>{draft.general.machine}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings drawer">x</button>
        </div>

        <section className="settings-section">
          <h3>General</h3>
          <label>Machine<input value={draft.general.machine} onChange={(event) => updateSection('general', { machine: event.target.value })} /></label>
        </section>

        <section className="settings-section">
          <h3>tmux</h3>
          <label className="toggle-row"><input checked={draft.tmux.enabled} type="checkbox" onChange={(event) => updateSection('tmux', { enabled: event.target.checked })} /> Enabled</label>
          <label>Naming scheme<input value={draft.tmux.namingScheme} onChange={(event) => updateSection('tmux', { namingScheme: event.target.value })} /></label>
          <label>Suffix<input value={draft.tmux.suffix} onChange={(event) => updateSection('tmux', { suffix: event.target.value })} /></label>
        </section>

        <section className="settings-section">
          <h3>Terminal</h3>
          <label>Preferred terminal
            <select value={draft.terminal.preferred} onChange={(event) => updateSection('terminal', { preferred: event.target.value as DashboardSettingsState['terminal']['preferred'] })}>
              {['auto', 'ghostty', 'iterm2', 'terminal', 'alacritty', 'kitty', 'wezterm'].map((terminal) => <option key={terminal} value={terminal}>{terminal}</option>)}
            </select>
          </label>
        </section>

        <section className="settings-section">
          <h3>Summaries</h3>
          <label className="toggle-row"><input checked={draft.summaries.enabled} type="checkbox" onChange={(event) => updateSection('summaries', { enabled: event.target.checked })} /> Enabled</label>
          <label>Provider order<input value={draft.summaries.providerOrder.join(', ')} onChange={(event) => updateSection('summaries', { providerOrder: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label>
          <label>Model<input value={draft.summaries.model} onChange={(event) => updateSection('summaries', { model: event.target.value })} /></label>
          <label>Budget per summary<input type="number" min="0" step="0.01" value={draft.summaries.budgetPerSummaryUsd ?? ''} onChange={(event) => updateSection('summaries', { budgetPerSummaryUsd: nullableNumber(event.target.value) })} /></label>
          <label>Budget per day<input type="number" min="0" step="0.01" value={draft.summaries.budgetPerDayUsd ?? ''} onChange={(event) => updateSection('summaries', { budgetPerDayUsd: nullableNumber(event.target.value) })} /></label>
        </section>

        <section className="settings-section">
          <h3>Federation</h3>
          <label className="toggle-row"><input checked={draft.federation.enabled} type="checkbox" onChange={(event) => updateSection('federation', { enabled: event.target.checked })} /> Enabled</label>
          <label>Discovery method<input value={draft.federation.discoveryMethod} onChange={(event) => updateSection('federation', { discoveryMethod: event.target.value })} /></label>
        </section>

        <section className="settings-section">
          <h3>Retention</h3>
          <label className="toggle-row"><input checked={draft.retention.autoWipe} type="checkbox" onChange={(event) => updateSection('retention', { autoWipe: event.target.checked })} /> Auto wipe</label>
          <label>Wipe older than days<input type="number" min="0" value={draft.retention.wipeOlderThanDays ?? ''} onChange={(event) => updateSection('retention', { wipeOlderThanDays: nullableNumber(event.target.value) })} /></label>
        </section>

        <section className="settings-section">
          <h3>Refresh</h3>
          <label>Sessions ms<input type="number" min="500" value={draft.refresh.sessionsMs} onChange={(event) => updateSection('refresh', { sessionsMs: Number(event.target.value) })} /></label>
          <label>Peers ms<input type="number" min="5000" value={draft.refresh.peersMs} onChange={(event) => updateSection('refresh', { peersMs: Number(event.target.value) })} /></label>
          <label>Doctor ms<input type="number" min="10000" value={draft.refresh.doctorNetworkMs} onChange={(event) => updateSection('refresh', { doctorNetworkMs: Number(event.target.value) })} /></label>
        </section>

        {error ? <p className="restore-error">{error}</p> : null}
        <div className="drawer-actions">
          <button className="jump-button" onClick={onClose} type="button">Cancel</button>
          <button data-testid="settings-save" disabled={saving} onClick={() => void save()} type="button">{saving ? 'Saving' : 'Save'}</button>
        </div>
      </aside>
    </div>
  );
}

function nullableNumber(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

function settingsPatch(previous: DashboardSettingsState, next: DashboardSettingsState): Partial<DashboardSettingsState> {
  const patch: Partial<DashboardSettingsState> = {};
  for (const key of ['general', 'tmux', 'terminal', 'summaries', 'federation', 'retention', 'refresh'] as Array<keyof DashboardSettingsState>) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      patch[key] = next[key] as never;
    }
  }
  return patch;
}
