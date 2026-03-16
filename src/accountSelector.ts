/**
 * Reusable account enumeration for sweech.
 *
 * Extracts the launcher's account-building logic into standalone helpers
 * so that other modules (server, CLI commands, tests) can list and filter
 * accounts without depending on the TUI.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { ConfigManager, ProfileConfig } from './config';
import { CLIType } from './providers';
import { SUPPORTED_CLIS, getCLI } from './clis';

export interface AccountEntry {
  name: string;
  commandName: string;
  cliType: string;
  configDir: string;
  isDefault: boolean;   // true for built-in claude/codex
  isManaged: boolean;   // true for sweech-managed profiles
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Check whether a CLI binary is reachable on the PATH. */
function isInstalled(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Default config directory for a built-in CLI (e.g. ~/.claude, ~/.codex). */
function defaultConfigDir(command: string): string {
  return path.join(os.homedir(), `.${command}`);
}

// ─── Core enumeration ───────────────────────────────────────────────

/**
 * Build the full list of known accounts — both built-in defaults and
 * sweech-managed profiles.
 *
 * When `profiles` is omitted the current on-disk config is read
 * automatically via ConfigManager.
 */
export function enumerateAccounts(profiles?: ProfileConfig[]): AccountEntry[] {
  const resolvedProfiles = profiles ?? new ConfigManager().getProfiles();

  const entries: AccountEntry[] = [];
  const seen = new Set<string>();

  // 1. Default accounts for every installed CLI
  for (const cli of Object.values(SUPPORTED_CLIS)) {
    if (!isInstalled(cli.command)) continue;

    entries.push({
      name: cli.command,
      commandName: cli.command,
      cliType: cli.name,
      configDir: defaultConfigDir(cli.command),
      isDefault: true,
      isManaged: false,
    });
    seen.add(cli.command);
  }

  // 2. Sweech-managed profiles
  for (const p of resolvedProfiles) {
    if (seen.has(p.commandName)) continue;

    const cliType = p.cliType === 'codex' ? 'codex' : 'claude';
    entries.push({
      name: p.name || p.commandName,
      commandName: p.commandName,
      cliType,
      configDir: path.join(os.homedir(), `.${p.commandName}`),
      isDefault: false,
      isManaged: true,
    });
    seen.add(p.commandName);
  }

  // 3. Group: claude (defaults first, then profiles), then codex
  return [
    ...entries.filter(e => e.cliType !== 'codex' && e.isDefault),
    ...entries.filter(e => e.cliType !== 'codex' && !e.isDefault),
    ...entries.filter(e => e.cliType === 'codex' && e.isDefault),
    ...entries.filter(e => e.cliType === 'codex' && !e.isDefault),
  ];
}

// ─── Filtered views ─────────────────────────────────────────────────

/**
 * Same as `enumerateAccounts` but only returns entries whose config
 * directory actually exists on disk.
 */
export function getAvailableAccounts(profiles?: ProfileConfig[]): AccountEntry[] {
  return enumerateAccounts(profiles).filter(e => fs.existsSync(e.configDir));
}

/**
 * Return accounts that match a specific CLI type (e.g. "claude" or "codex").
 */
export function getAccountsByType(cliType: string, profiles?: ProfileConfig[]): AccountEntry[] {
  return enumerateAccounts(profiles).filter(e => e.cliType === cliType);
}

/**
 * Return the "best" account to use right now.
 *
 * Placeholder implementation: returns the first account from the
 * enumerated list. A future version will consult usage/limit data and
 * skip accounts that have hit their rate-limit window.
 */
export function getBestAccount(profiles?: ProfileConfig[]): AccountEntry | undefined {
  const accounts = enumerateAccounts(profiles);
  return accounts[0];
}
