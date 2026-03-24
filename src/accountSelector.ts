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
import { getAccountInfo, getKnownAccounts, type AccountInfo } from './subscriptions';

export interface AccountEntry {
  name: string;
  commandName: string;
  cliType: string;
  configDir: string;
  isDefault: boolean;   // true for built-in claude/codex
  isManaged: boolean;   // true for sweech-managed profiles
}

export interface AccountRecommendation {
  account: AccountEntry;
  score: number;
  reason: string;
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

export function accountScore(info: AccountInfo): number {
  const live = info.live;
  const status = live?.status;
  if (status === 'rejected' || status === 'limit_reached') return Number.NEGATIVE_INFINITY;

  const weeklyUtil = live?.utilization7d ?? 0;
  const sessionUtil = live?.utilization5h ?? 0;
  const resetHours = info.hoursUntilWeeklyReset ?? 24 * 365;
  const resetUrgency = resetHours > 0 ? 1 / resetHours : 10;
  const firstCapacityMinutes = info.minutesUntilFirstCapacity ?? 0;
  const capacityPenalty = firstCapacityMinutes > 0 ? Math.min(firstCapacityMinutes / 600, 1) : 0;

  return (weeklyUtil * 100) + (sessionUtil * 20) + (resetUrgency * 50) - (capacityPenalty * 10);
}

export function accountReason(info: AccountInfo): string {
  const pieces: string[] = [];
  if (info.live?.status) pieces.push(`status=${info.live.status}`);
  if (info.hoursUntilWeeklyReset !== undefined) pieces.push(`weekly-reset=${info.hoursUntilWeeklyReset.toFixed(1)}h`);
  if (info.live?.utilization7d !== undefined) pieces.push(`7d=${Math.round(info.live.utilization7d * 100)}%`);
  if (info.live?.utilization5h !== undefined) pieces.push(`5h=${Math.round(info.live.utilization5h * 100)}%`);
  if (pieces.length === 0) return 'fallback order';
  return pieces.join(', ');
}

/**
 * Recommend the best account to use right now.
 *
 * Priority:
 * 1. Exclude accounts already rejected/at hard limit
 * 2. Prefer quota that resets sooner so expiring capacity gets used first
 * 3. Prefer accounts with higher weekly/session utilization if they are still healthy
 */
export async function suggestBestAccount(
  cliType?: string,
  profiles?: ProfileConfig[],
): Promise<AccountRecommendation | undefined> {
  const resolvedProfiles = profiles ?? new ConfigManager().getProfiles();
  const known = getKnownAccounts(resolvedProfiles);
  const infos = await getAccountInfo(known);
  const available = getAvailableAccounts(resolvedProfiles);
  const byCommand = new Map(available.map((entry) => [entry.commandName, entry]));

  const ranked = infos
    .filter((info) => !cliType || info.cliType === cliType)
    .map((info) => {
      const entry = byCommand.get(info.commandName);
      if (!entry) return null;
      return {
        account: entry,
        score: accountScore(info),
        reason: accountReason(info),
      };
    })
    .filter((value): value is AccountRecommendation => Boolean(value))
    .sort((a, b) => b.score - a.score);

  return ranked[0];
}
