/**
 * Workspace lifecycle CRUD (T-LU-010).
 *
 * Thin facade over ConfigManager that surfaces the disable / enable / hide /
 * unhide / delete / edit operations to both `sweech workspace ...` and the
 * SweechBar context-menu shellouts. Everything here is sync — the underlying
 * config.json writes are atomic and the credential-store calls (when
 * applicable) are fire-and-forget.
 *
 * Decoupling contract (non-negotiable):
 *   Workspace == ~/.<commandName>/ directory (conversation history, settings.json)
 *   Account   == identity in ~/.sweech/accounts.json + keychain blob
 *
 *   Deleting a workspace MUST NOT touch the vault. Deleting an account MUST NOT
 *   touch any workspace directory unless the caller explicitly asks. This
 *   module enforces only the workspace half; vault.ts owns the account half.
 *
 * Re-exposed via `sweech workspace <action>` (cli.ts) and the SweechBar
 * `workspaceShellCommand()` helper. Errors are surfaced as throw — callers
 * scrub + format for their respective surfaces.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager, ProfileConfig } from './config';

/**
 * Local copy of `isDefaultCLIDirectory` from reset.ts. We can't import that
 * module directly because it pulls inquirer at module load (interactive
 * prompts), which jest can't transform out of node_modules. Three paths
 * matter — ~/.claude, ~/.codex, ~/.kimi — and they belong to the upstream
 * CLI, not sweech.
 */
function isDefaultCLIDirectory(dirPath: string): boolean {
  const normalized = path.resolve(dirPath);
  const defaults = ['claude', 'codex', 'kimi'].map(name =>
    path.resolve(path.join(os.homedir(), `.${name}`))
  );
  return defaults.includes(normalized);
}

export type WorkspaceFlagAction = 'disable' | 'enable' | 'hide' | 'unhide';

export interface WorkspaceFlagResult {
  commandName: string;
  action: WorkspaceFlagAction;
  before: { disabled: boolean; hidden: boolean };
  after: { disabled: boolean; hidden: boolean };
  noop: boolean;
}

export interface WorkspaceDeleteOptions {
  /** Skip removal of ~/.<commandName>/. The profile record is still dropped. */
  keepData?: boolean;
  /**
   * When true (default), tolerates dependents (profiles with sharedWith
   * pointing at this one). When false, refuses with a list.
   */
  forceDependents?: boolean;
}

export interface WorkspaceDeleteResult {
  commandName: string;
  keptData: boolean;
  removedDependents: string[];
  profileDirRemoved: boolean;
}

export interface WorkspaceEditOptions {
  model?: string;
  baseUrl?: string;
  smallFastModel?: string;
  envOverrides?: Record<string, string>;
}

/**
 * Status helpers — small enough to share with the CLI rendering layer and the
 * SweechBar JSON shape without dragging in the full ConfigManager.
 */
export function profileFlags(p: ProfileConfig): { disabled: boolean; hidden: boolean } {
  return { disabled: Boolean(p.disabled), hidden: Boolean(p.hidden) };
}

/**
 * Sort profiles for display: visible-enabled first (alpha), then disabled
 * (alpha), then hidden (alpha). Hidden + disabled both sink — hidden wins.
 * Preserves the existing alpha ordering inside each tier so existing
 * `sweech list` muscle memory is unchanged for the active tier.
 */
export function sortProfilesByStatus(profiles: ProfileConfig[]): ProfileConfig[] {
  const tier = (p: ProfileConfig): number => {
    if (p.hidden) return 2;
    if (p.disabled) return 1;
    return 0;
  };
  return [...profiles].sort((a, b) => {
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    return a.commandName.localeCompare(b.commandName);
  });
}

/**
 * Returns true if the workspace should be excluded from automated work:
 *   - candidate enumeration in `sweech auto` / `failover`
 *   - background token refresh / liveUsage polling
 *   - the launchd serve daemon's idle scans
 *
 * Both flags imply skip. `disabled` is the explicit "don't touch" signal;
 * `hidden` is the cosmetic-but-also-don't-touch signal. Hide-as-stronger is
 * an intentional choice — a user hiding a workspace from view almost
 * certainly does not want it making network calls in the background.
 */
export function isWorkspaceInactive(p: ProfileConfig): boolean {
  return Boolean(p.disabled) || Boolean(p.hidden);
}

function findProfile(commandName: string, config: ConfigManager): ProfileConfig {
  const profile = config.getProfiles().find(p => p.commandName === commandName);
  if (!profile) {
    throw new Error(`Workspace '${commandName}' not found`);
  }
  return profile;
}

export function setWorkspaceFlag(
  commandName: string,
  action: WorkspaceFlagAction,
  config = new ConfigManager(),
): WorkspaceFlagResult {
  const profile = findProfile(commandName, config);
  const before = profileFlags(profile);

  let flag: 'disabled' | 'hidden';
  let value: boolean;
  switch (action) {
    case 'disable': flag = 'disabled'; value = true;  break;
    case 'enable':  flag = 'disabled'; value = false; break;
    case 'hide':    flag = 'hidden';   value = true;  break;
    case 'unhide':  flag = 'hidden';   value = false; break;
  }

  const currentlySet = Boolean(profile[flag]);
  if (currentlySet === value) {
    return { commandName, action, before, after: before, noop: true };
  }

  const updated = config.setProfileFlag(commandName, flag, value);
  return {
    commandName,
    action,
    before,
    after: profileFlags(updated),
    noop: false,
  };
}

export function deleteWorkspace(
  commandName: string,
  opts: WorkspaceDeleteOptions = {},
  config = new ConfigManager(),
): WorkspaceDeleteResult {
  const profiles = config.getProfiles();
  const target = profiles.find(p => p.commandName === commandName);
  if (!target) {
    throw new Error(`Workspace '${commandName}' not found`);
  }

  // Reject default CLI dirs — ~/.claude / ~/.codex / ~/.kimi belong to the
  // upstream CLI, not to sweech. They were never created by `sweech add` and
  // removing them would wipe the user's primary identity.
  const profileDir = config.getProfileDir(commandName);
  if (isDefaultCLIDirectory(profileDir)) {
    throw new Error(`Cannot delete default CLI workspace: ${profileDir}`);
  }

  const dependents = profiles
    .filter(p => p.sharedWith === commandName)
    .map(p => p.commandName);

  if (dependents.length > 0 && !opts.forceDependents) {
    throw new Error(
      `Workspace '${commandName}' is shared by: ${dependents.join(', ')}. ` +
      `Re-run with --force-dependents to remove anyway.`
    );
  }

  const profileDirExisted = fs.existsSync(profileDir);
  config.removeProfile(commandName, { keepData: opts.keepData });

  return {
    commandName,
    keptData: Boolean(opts.keepData),
    removedDependents: dependents,
    profileDirRemoved: profileDirExisted && !opts.keepData,
  };
}

export function editWorkspace(
  commandName: string,
  patch: WorkspaceEditOptions,
  config = new ConfigManager(),
): ProfileConfig {
  // Surface a clear error before delegating, so a typo in commandName lands
  // here instead of inside ConfigManager.editProfile.
  findProfile(commandName, config);
  return config.editProfile(commandName, patch);
}

/**
 * Bonus: enumerate workspaces with a denormalised status tag for renderers.
 * Used by `sweech workspace list` and SweechBar's hidden-section layout.
 */
export interface WorkspaceStatusRow {
  commandName: string;
  cliType: string;
  provider: string;
  disabled: boolean;
  hidden: boolean;
  /** ~/.<commandName>/ path; helpful when surfacing "delete will remove X". */
  profileDir: string;
  /** True if the profile dir exists on disk right now. */
  profileDirExists: boolean;
}

export function listWorkspaces(config = new ConfigManager()): WorkspaceStatusRow[] {
  return sortProfilesByStatus(config.getProfiles()).map(p => {
    const profileDir = config.getProfileDir(p.commandName);
    return {
      commandName: p.commandName,
      cliType: p.cliType,
      provider: p.provider,
      disabled: Boolean(p.disabled),
      hidden: Boolean(p.hidden),
      profileDir,
      profileDirExists: safeExists(profileDir),
    };
  });
}

function safeExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// Suppress the unused-import warning for path/os when reading this file in
// isolation — they are reserved for future expansions (delete --archive
// would move to ~/.sweech/archive/<timestamp>/).
void path; void os;
