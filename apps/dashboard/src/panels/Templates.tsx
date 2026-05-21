import React from 'react';
import { Card } from '@vykeai/vysual-react';
import { safeTestId, type DashboardTemplate, type DashboardTemplatesState } from '../components/panelViewModel';

export function TemplatesPanel({ templates, onTemplatesChanged }: { templates: DashboardTemplatesState; onTemplatesChanged?: (templates: DashboardTemplatesState) => void }) {
  const rows = templates.templates ?? [];
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<TemplateDraft>(() => emptyDraft());

  const cloneTemplate = async (template: DashboardTemplate) => {
    const nextName = nextTemplateCloneName(template.name, rows);
    setPending(template.name);
    setError(null);
    try {
      const res = await fetch('/dashboard/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...template, name: nextName, description: `${template.description} custom`, tags: template.tags ?? [] }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Template save failed');
      const refresh = await fetch('/dashboard/templates');
      if (refresh.ok) onTemplatesChanged?.(await refresh.json() as DashboardTemplatesState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const deleteTemplate = async (template: DashboardTemplate) => {
    setPending(template.name);
    setError(null);
    try {
      const res = await fetch(`/dashboard/templates/${encodeURIComponent(template.name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Template delete failed');
      const refresh = await fetch('/dashboard/templates');
      if (refresh.ok) onTemplatesChanged?.(await refresh.json() as DashboardTemplatesState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const saveTemplate = async () => {
    setPending('form');
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        description: draft.description.trim(),
        cliType: draft.cliType.trim(),
        provider: draft.provider.trim(),
        model: draft.model.trim() || undefined,
        baseUrl: draft.baseUrl.trim() || undefined,
        tags: tagsFromInput(draft.tags),
        overwrite: Boolean(draft.editing),
      };
      const res = await fetch('/dashboard/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Template save failed');
      const refresh = await fetch('/dashboard/templates');
      if (refresh.ok) onTemplatesChanged?.(await refresh.json() as DashboardTemplatesState);
      setDraft(emptyDraft());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const editTemplate = (template: DashboardTemplate) => {
    setDraft({
      name: template.name,
      description: template.description,
      cliType: template.cliType,
      provider: template.provider,
      model: template.model ?? '',
      baseUrl: template.baseUrl ?? '',
      tags: (template.tags ?? []).join(', '),
      editing: !template.builtIn,
    });
    setError(null);
  };

  return (
    <Card className="panel data-panel templates-panel">
      <div className="panel-heading">
        <h2>Templates</h2>
        <span>{templates.custom} custom · {templates.total} total</span>
      </div>
      <div className="template-form" data-testid="template-form">
        <input aria-label="Template name" placeholder="template-name" value={draft.name} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, name: event.target.value })} />
        <input aria-label="Template description" placeholder="Description" value={draft.description} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, description: event.target.value })} />
        <select aria-label="Template CLI" value={draft.cliType} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, cliType: event.target.value })}>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
          <option value="gemini">gemini</option>
          <option value="kimi">kimi</option>
        </select>
        <input aria-label="Template provider" placeholder="provider" value={draft.provider} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, provider: event.target.value })} />
        <input aria-label="Template model" placeholder="model" value={draft.model} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, model: event.target.value })} />
        <input aria-label="Template base URL" placeholder="base URL" value={draft.baseUrl} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, baseUrl: event.target.value })} />
        <input aria-label="Template tags" placeholder="tags" value={draft.tags} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, tags: event.target.value })} />
        <div className="row-actions">
          <button className="jump-button" data-testid="template-save" disabled={pending === 'form' || draft.name.trim().length === 0 || draft.provider.trim().length === 0} onClick={() => void saveTemplate()} type="button">
            {pending === 'form' ? 'Saving' : draft.editing ? 'Update' : 'Create'}
          </button>
          {draft.editing ? <button className="jump-button" onClick={() => setDraft(emptyDraft())} type="button">Cancel</button> : null}
        </div>
      </div>
      <div className="ops-list">
        {rows.length === 0 ? (
          <p className="empty-state compact">No templates available.</p>
        ) : rows.map((template) => (
          <div className="ops-row" data-testid={`template-row-${safeTestId(template.name)}`} key={template.name}>
            <div>
              <strong>{template.name}</strong>
              <span>{template.cliType} · {template.provider}</span>
              <p>{template.description}</p>
            </div>
            <div className="row-actions">
              <span className={`pill pill-${template.builtIn ? 'muted' : 'success'}`}>{template.builtIn ? 'built-in' : 'custom'}</span>
              {template.builtIn ? (
                <button className="jump-button" data-testid={`template-clone-${safeTestId(template.name)}`} disabled={pending === template.name} onClick={() => void cloneTemplate(template)} type="button">
                  {pending === template.name ? 'Saving' : 'Clone'}
                </button>
              ) : (
                <>
                  <button className="jump-button" data-testid={`template-edit-${safeTestId(template.name)}`} disabled={pending === template.name} onClick={() => editTemplate(template)} type="button">Edit</button>
                  <button className="jump-button danger-button" data-testid={`template-delete-${safeTestId(template.name)}`} disabled={pending === template.name} onClick={() => void deleteTemplate(template)} type="button">
                    {pending === template.name ? 'Removing' : 'Delete'}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {error ? <p className="restore-error">{error}</p> : null}
    </Card>
  );
}

type TemplateDraft = {
  name: string;
  description: string;
  cliType: string;
  provider: string;
  model: string;
  baseUrl: string;
  tags: string;
  editing: boolean;
};

function emptyDraft(): TemplateDraft {
  return { name: '', description: '', cliType: 'claude', provider: '', model: '', baseUrl: '', tags: '', editing: false };
}

function tagsFromInput(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function nextTemplateCloneName(name: string, templates: DashboardTemplate[]): string {
  const base = `${name.replace(/[^a-zA-Z0-9._-]/g, '-')}-custom`.slice(0, 56);
  const existing = new Set(templates.map((template) => template.name));
  if (!existing.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 64);
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 64);
}
