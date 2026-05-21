import React from 'react';
import { type DashboardSettingsState, type DashboardWorkspace } from './panelViewModel';

export function SetupWizard({
  open,
  settings,
  workspaces,
  onClose,
}: {
  open: boolean;
  settings: DashboardSettingsState;
  workspaces: DashboardWorkspace[];
  onClose: () => void;
}) {
  const [step, setStep] = React.useState(0);
  const [provider, setProvider] = React.useState('anthropic');
  const [workspace, setWorkspace] = React.useState(workspaces[0]?.commandName ?? 'claude-main');

  React.useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  if (!open) return null;
  const hasWorkspaces = workspaces.length > 0;
  const steps = ['Detect CLIs', 'Pick provider', 'Create workspace', 'Done'];

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <dialog className="session-detail-dialog setup-wizard" open aria-labelledby="setup-wizard-title" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div>
            <h2 id="setup-wizard-title">Setup Wizard</h2>
            <p>{steps[step]}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close setup wizard">x</button>
        </div>
        <ol className="wizard-steps" aria-label="Setup steps">
          {steps.map((label, index) => <li className={index === step ? 'active' : index < step ? 'done' : ''} key={label}>{label}</li>)}
        </ol>

        {step === 0 ? (
          <section className="wizard-body" data-testid="setup-step-detect">
            <h3>Detect CLIs</h3>
            <div className="ops-list">
              {['claude', 'codex', 'kimi'].map((cli) => <div className="ops-row" key={cli}><strong>{cli}</strong><span className="pill pill-success">available</span></div>)}
            </div>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="wizard-body" data-testid="setup-step-provider">
            <h3>Pick Provider</h3>
            <label>Provider
              <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="ollama">ollama</option>
              </select>
            </label>
            <p>Summaries use {settings.summaries.providerOrder[0] ?? 'auto'} first.</p>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="wizard-body" data-testid="setup-step-workspace">
            <h3>Create Workspace</h3>
            <label>Workspace command<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} /></label>
            <p>{hasWorkspaces ? 'Existing workspace selected for the first launch.' : `Ready to create ${provider} workspace settings.`}</p>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="wizard-body" data-testid="setup-step-done">
            <h3>Done</h3>
            <div className="ops-row">
              <div>
                <strong>{workspace}</strong>
                <span>{provider} · {settings.terminal.preferred} terminal</span>
                <p>{settings.tmux.enabled ? 'tmux launch enabled' : 'direct terminal launch'}</p>
              </div>
              <span className="pill pill-success">ready</span>
            </div>
          </section>
        ) : null}

        <div className="drawer-actions">
          <button className="jump-button" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))} type="button">Back</button>
          {step < steps.length - 1 ? (
            <button data-testid="setup-wizard-next" onClick={() => setStep((current) => Math.min(steps.length - 1, current + 1))} type="button">Next</button>
          ) : (
            <button data-testid="setup-wizard-finish" onClick={onClose} type="button">Finish</button>
          )}
        </div>
      </dialog>
    </div>
  );
}
