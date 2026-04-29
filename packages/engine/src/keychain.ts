import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SERVICE = 'sweech';
const MIGRATION_FLAG_PATH = join(homedir(), '.sweech', '.keychain-migrated');
const SAFE_ACCOUNT_RE = /^[a-zA-Z0-9_.-]+$/;

function validateAccount(account: string): void {
  if (!SAFE_ACCOUNT_RE.test(account)) {
    throw new Error(`Invalid keychain account name: "${account}"`);
  }
}

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

export function getKey(account: string): string | null {
  validateAccount(account);
  if (!isMacOS()) return null;
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', account, '-s', SERVICE, '-w'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim() || null;
  } catch {
    return null;
  }
}

export function setKey(account: string, key: string): void {
  validateAccount(account);
  if (!isMacOS()) return;
  // Delete first to avoid duplicates
  try {
    execFileSync('security', ['delete-generic-password', '-a', account, '-s', SERVICE], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // Didn't exist — fine
  }
  execFileSync('security', ['add-generic-password', '-a', account, '-s', SERVICE, '-w', key], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

export function deleteKey(account: string): boolean {
  validateAccount(account);
  if (!isMacOS()) return false;
  try {
    execFileSync('security', ['delete-generic-password', '-a', account, '-s', SERVICE], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function listKeys(): string[] {
  if (!isMacOS()) return [];
  try {
    const output = execFileSync(
      'security',
      ['dump-keychain'],
      { encoding: 'utf-8' },
    );
    const accounts: string[] = [];
    const re = /"svce"<blob>="sweech"/;
    const lines = output.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        // Look backwards for the account name
        for (let j = i; j >= Math.max(0, i - 5); j--) {
          const acctMatch = lines[j]!.match(/"acct"<blob>="([^"]+)"/);
          if (acctMatch) {
            accounts.push(acctMatch[1]!);
            break;
          }
        }
      }
    }
    return accounts;
  } catch {
    return [];
  }
}

export function keyExists(account: string): boolean {
  return getKey(account) !== null;
}

export async function needsMigration(): Promise<boolean> {
  try {
    await readFile(MIGRATION_FLAG_PATH, 'utf-8');
    return false;
  } catch {
    return true;
  }
}

export async function markMigrated(): Promise<void> {
  await mkdir(dirname(MIGRATION_FLAG_PATH), { recursive: true });
  await writeFile(MIGRATION_FLAG_PATH, new Date().toISOString(), 'utf-8');
}

/**
 * One-time migration: move API keys from profiles.json into the keychain.
 * Returns the number of keys migrated.
 */
export async function migrateFromConfig(): Promise<number> {
  if (!await needsMigration()) return 0;

  const profilesPath = join(homedir(), '.sweech', 'profiles.json');
  let raw: string;
  try {
    raw = await readFile(profilesPath, 'utf-8');
  } catch {
    await markMigrated();
    return 0;
  }

  const config = JSON.parse(raw) as Record<string, unknown>;
  let migrated = 0;

  for (const [key, value] of Object.entries(config)) {
    if (key === '_config' || key === 'schema' || key === 'version' || !value || typeof value !== 'object') continue;
    const profile = value as Record<string, unknown>;
    if (typeof profile.apiKey === 'string' && profile.apiKey.length > 0) {
      const account = (typeof profile.name === 'string' && profile.name) ? profile.name : key;
      // setKey is idempotent — safe to re-run if we crashed before config write
      setKey(account, profile.apiKey);
      // Verify key made it to keychain before removing from config
      if (keyExists(account)) {
        delete profile.apiKey;
        profile.keyInKeychain = true;
        migrated++;
      }
    }
  }

  // Write config (keys removed) BEFORE marking migration done.
  // If we crash here, next run will re-migrate (setKey is idempotent).
  if (migrated > 0) {
    await writeFile(profilesPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  await markMigrated();
  return migrated;
}
