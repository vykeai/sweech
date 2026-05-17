/**
 * Account lifecycle CRUD (T-LU-010 half 2).
 *
 * Wraps the existing vault primitives in vault.ts with the same surface the
 * workspaceCrud module exposes for workspaces: hide / unhide / logout / delete
 * / edit, by email-or-id, with strict decoupling from workspace data.
 *
 * Decoupling contract (mirrors workspaceCrud.ts):
 *   Deleting an account here removes its row from accounts.json + drops the
 *   keychain secret, and OPTIONALLY (when --keep-workspaces is omitted)
 *   clears `.sweech-account` marker files inside every workspace that had
 *   it mounted. It NEVER touches ~/.<workspace>/ directory contents. To
 *   delete a workspace, the caller uses `sweech workspace delete`.
 *
 *   Logout drops the keychain secret but keeps the row visible — the user
 *   can re-import the same identity later without losing the (kind, email,
 *   orgId) → id mapping. This is what the user asked for when they said
 *   "claude-ted is free so cannot be used with claude code keeps showing
 *   i would like to just log it out maybe completely or somethibg".
 */

import {
  AccountMeta,
  AccountKind,
  listAccounts,
  getAccount,
  updateAccountMeta,
  removeAccount,
  setActiveAccountId,
  findWorkspacesUsingAccount,
} from './vault';
import { getCredentialStore } from './credentialStore';

export type AccountHideAction = 'hide' | 'unhide';

export interface AccountFlagResult {
  id: string;
  email: string;
  action: AccountHideAction;
  before: { hidden: boolean };
  after: { hidden: boolean };
  noop: boolean;
}

export interface AccountLogoutResult {
  id: string;
  email: string;
  /** Whether a keychain entry actually existed before the call. */
  hadSecret: boolean;
  /** Workspaces whose `.sweech-account` marker was cleared. */
  unmountedWorkspaces: string[];
}

export interface AccountDeleteOptions {
  /**
   * When true, preserve the workspace `.sweech-account` marker files so the
   * directories remain "claimed" by the now-deleted account id. Default
   * false — markers pointing at a missing account are confusing.
   */
  keepWorkspaceMarkers?: boolean;
}

export interface AccountDeleteResult {
  id: string;
  email: string;
  hadSecret: boolean;
  unmountedWorkspaces: string[];
}

export interface AccountEditPatch {
  displayName?: string;
  plan?: string;
  rateLimitTier?: string;
  orgName?: string;
}

/**
 * Resolve an `email-or-id` argument to an AccountMeta. Accepts either:
 *   - the 12-char id slice produced by idFor()
 *   - an email address (case-insensitive). If multiple kinds/orgs share the
 *     same email, the caller can disambiguate with the optional `kind` arg.
 *
 * Returns null when there is no unambiguous match — the CLI surfaces the
 * candidates so the user can re-run with `--kind <oauth-kind>` or the id.
 */
export function resolveAccount(
  emailOrId: string,
  kind?: AccountKind,
): { resolved: AccountMeta } | { ambiguous: AccountMeta[] } | { notFound: true } {
  const trimmed = emailOrId.trim();
  if (!trimmed) return { notFound: true };

  // Try id first (deterministic — 12 hex chars).
  if (/^[0-9a-f]{12}$/.test(trimmed)) {
    const byId = getAccount(trimmed);
    if (byId) return { resolved: byId };
  }

  const lowered = trimmed.toLowerCase();
  const all = listAccounts();
  const matches = all.filter(a => {
    if (kind && a.kind !== kind) return false;
    return a.email.toLowerCase() === lowered;
  });

  if (matches.length === 0) return { notFound: true };
  if (matches.length === 1) return { resolved: matches[0] };
  return { ambiguous: matches };
}

function readMeta(): AccountMeta[] {
  return listAccounts();
}

export function setAccountHidden(
  emailOrId: string,
  action: AccountHideAction,
  kind?: AccountKind,
): AccountFlagResult {
  const resolution = resolveAccount(emailOrId, kind);
  if ('notFound' in resolution) {
    throw new Error(`Account '${emailOrId}' not found`);
  }
  if ('ambiguous' in resolution) {
    throw new Error(
      `Account '${emailOrId}' is ambiguous (${resolution.ambiguous.length} matches). ` +
      `Pass the 12-char id or --kind <anthropic|openai>.`,
    );
  }
  const account = resolution.resolved;
  const before = { hidden: Boolean(account.hidden) };
  const next = action === 'hide';

  if (before.hidden === next) {
    return {
      id: account.id, email: account.email, action,
      before, after: before, noop: true,
    };
  }

  // updateAccountMeta merges; pass `hidden: undefined` to clear is not
  // supported by the partial-merge contract, so write false directly. The
  // accounts.json schema tolerates a `false` value and it's a tiny field.
  updateAccountMeta(account.id, { hidden: next });
  return {
    id: account.id, email: account.email, action,
    before, after: { hidden: next }, noop: false,
  };
}

/**
 * Logout = drop the keychain secret only. The accounts.json row stays so
 * the user can later re-import the same identity (the id derivation is
 * deterministic from kind+email+orgId, so a fresh OAuth flow lands on the
 * same row). Workspace markers pointing at the now-credential-less account
 * are cleared so background refresh stops trying to use it.
 */
export async function logoutAccount(
  emailOrId: string,
  workspaces: Array<{ commandName: string }>,
  kind?: AccountKind,
): Promise<AccountLogoutResult> {
  const resolution = resolveAccount(emailOrId, kind);
  if ('notFound' in resolution) {
    throw new Error(`Account '${emailOrId}' not found`);
  }
  if ('ambiguous' in resolution) {
    throw new Error(
      `Account '${emailOrId}' is ambiguous (${resolution.ambiguous.length} matches). ` +
      `Pass the 12-char id or --kind <anthropic|openai>.`,
    );
  }
  const account = resolution.resolved;
  const store = getCredentialStore();
  const service = `sweech-vault-${account.kind}-${account.id}`;

  // Check existence first so we can report it back to the caller.
  let hadSecret = false;
  try {
    const existing = await store.get(service, 'sweech-vault');
    hadSecret = Boolean(existing);
  } catch {
    hadSecret = false;
  }

  if (hadSecret) {
    try { await store.delete(service, 'sweech-vault'); } catch {}
  }

  // Clear any workspace marker pointing at this account so the daemon
  // stops refreshing a now-credential-less identity.
  const mounted = findWorkspacesUsingAccount(account.id, workspaces);
  for (const cmd of mounted) {
    setActiveAccountId(cmd, null);
  }

  // Mark status as unauthorized so list surfaces show "logged out" not "ok".
  updateAccountMeta(account.id, { status: 'unauthorized' });

  return {
    id: account.id,
    email: account.email,
    hadSecret,
    unmountedWorkspaces: mounted,
  };
}

/**
 * Delete the account row + the keychain secret. By default also clears the
 * workspace markers (so `sweech list` doesn't show a dangling id pointer);
 * pass `keepWorkspaceMarkers: true` to preserve them.
 *
 * Note: workspace DATA (the ~/.<commandName>/ directory) is NEVER touched
 * here. To remove the workspace dir, use `sweech workspace delete`.
 */
export async function deleteAccount(
  emailOrId: string,
  workspaces: Array<{ commandName: string }>,
  opts: AccountDeleteOptions = {},
  kind?: AccountKind,
): Promise<AccountDeleteResult> {
  const resolution = resolveAccount(emailOrId, kind);
  if ('notFound' in resolution) {
    throw new Error(`Account '${emailOrId}' not found`);
  }
  if ('ambiguous' in resolution) {
    throw new Error(
      `Account '${emailOrId}' is ambiguous (${resolution.ambiguous.length} matches). ` +
      `Pass the 12-char id or --kind <anthropic|openai>.`,
    );
  }
  const account = resolution.resolved;

  const store = getCredentialStore();
  const service = `sweech-vault-${account.kind}-${account.id}`;
  let hadSecret = false;
  try {
    const existing = await store.get(service, 'sweech-vault');
    hadSecret = Boolean(existing);
  } catch {}

  const mounted = findWorkspacesUsingAccount(account.id, workspaces);
  if (!opts.keepWorkspaceMarkers) {
    for (const cmd of mounted) {
      setActiveAccountId(cmd, null);
    }
  }

  await removeAccount(account.id);

  return {
    id: account.id,
    email: account.email,
    hadSecret,
    unmountedWorkspaces: opts.keepWorkspaceMarkers ? [] : mounted,
  };
}

export function editAccount(
  emailOrId: string,
  patch: AccountEditPatch,
  kind?: AccountKind,
): AccountMeta {
  const resolution = resolveAccount(emailOrId, kind);
  if ('notFound' in resolution) {
    throw new Error(`Account '${emailOrId}' not found`);
  }
  if ('ambiguous' in resolution) {
    throw new Error(
      `Account '${emailOrId}' is ambiguous (${resolution.ambiguous.length} matches). ` +
      `Pass the 12-char id or --kind <anthropic|openai>.`,
    );
  }
  const account = resolution.resolved;
  const merged = updateAccountMeta(account.id, patch);
  if (!merged) {
    throw new Error(`Account '${account.id}' disappeared mid-edit`);
  }
  return merged;
}

/**
 * Visible / hidden split for `sweech accounts list`. Hidden entries are
 * still returned but tagged so renderers can sink them to a section at
 * the bottom — same UX as `sortProfilesByStatus` for workspaces.
 */
export function partitionByHidden(accounts: AccountMeta[]): {
  visible: AccountMeta[];
  hidden: AccountMeta[];
} {
  const visible: AccountMeta[] = [];
  const hidden: AccountMeta[] = [];
  for (const a of accounts) {
    (a.hidden ? hidden : visible).push(a);
  }
  return { visible, hidden };
}

/** Convenience: emit the audit-log payload shape so cli.ts stays terse. */
export function flagChangeAudit(result: AccountFlagResult): Record<string, unknown> {
  return {
    accountId: result.id,
    email: result.email,
    flagAction: result.action,
    before: result.before,
    after: result.after,
    noop: result.noop,
  };
}
