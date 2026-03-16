/**
 * Git-based config sync for sweech profiles.
 *
 * Copies non-secret config files into ~/.sweech/sync/ and manages a git
 * repo there so profiles can be pushed/pulled across machines.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// ── Constants ────────────────────────────────────────────────────────────────

const SWEECH_DIR = path.join(os.homedir(), '.sweech');
const SYNC_DIR = path.join(SWEECH_DIR, 'sync');
const SYNC_META = path.join(SYNC_DIR, '.sync-meta.json');

/** Config files that are safe to sync (no tokens or secrets). */
const SYNCABLE_FILES = [
  'config.json',
  'subscriptions.json',
  'webhooks.json',
  'routing.json',
];

/** Files that must never be committed. */
const GITIGNORE_CONTENT = `# sweech sync — never commit secrets
tokens.json
*.key
*.pem
.env
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function git(args: string, cwd: string = SYNC_DIR): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readMeta(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SYNC_META, 'utf-8'));
  } catch {
    return {};
  }
}

function writeMeta(meta: Record<string, string>): void {
  fs.writeFileSync(SYNC_META, JSON.stringify(meta, null, 2));
}

/**
 * Copy every syncable file that exists in ~/.sweech/ into the sync directory.
 */
function copySyncableFiles(): void {
  for (const file of SYNCABLE_FILES) {
    const src = path.join(SWEECH_DIR, file);
    const dest = path.join(SYNC_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the sync directory as a git repo and optionally add a remote.
 *
 * - Creates ~/.sweech/sync/ if it doesn't exist.
 * - Runs `git init` (idempotent).
 * - Writes a .gitignore that excludes tokens.json and other secrets.
 * - Copies current config files into the sync dir.
 * - Adds the remote origin if `remoteUrl` is provided.
 */
export async function initSync(remoteUrl?: string): Promise<void> {
  ensureDir(SYNC_DIR);

  // Initialise repo (safe to call on an existing repo)
  git('init', SYNC_DIR);

  // Write .gitignore
  fs.writeFileSync(path.join(SYNC_DIR, '.gitignore'), GITIGNORE_CONTENT);

  // Copy syncable config files
  copySyncableFiles();

  // Stage everything
  git('add -A');

  // Initial commit (skip if nothing to commit)
  try {
    git('diff --cached --quiet');
  } catch {
    // There are staged changes — commit them
    git('commit -m "sweech: initial sync"');
  }

  // Set remote
  if (remoteUrl) {
    try {
      git('remote remove origin');
    } catch {
      // No existing origin — that's fine
    }
    git(`remote add origin ${remoteUrl}`);
  }

  // Record initialisation time
  const meta = readMeta();
  meta.initializedAt = new Date().toISOString();
  if (remoteUrl) {
    meta.remote = remoteUrl;
  }
  writeMeta(meta);
}

/**
 * Stage current config files, commit, and push to remote.
 */
export async function pushSync(): Promise<void> {
  if (!fs.existsSync(path.join(SYNC_DIR, '.git'))) {
    throw new Error('Sync not initialised. Run initSync() first.');
  }

  // Refresh files
  copySyncableFiles();

  git('add -A');

  // Check if there's anything to commit
  try {
    git('diff --cached --quiet');
    // No changes — but still push in case local is ahead of remote
  } catch {
    const timestamp = new Date().toISOString();
    git(`commit -m "sweech: sync ${timestamp}"`);
  }

  git('push origin HEAD');

  // Update meta
  const meta = readMeta();
  meta.lastSync = new Date().toISOString();
  writeMeta(meta);
}

/**
 * Pull latest changes from remote, rebasing local commits on top.
 */
export async function pullSync(): Promise<void> {
  if (!fs.existsSync(path.join(SYNC_DIR, '.git'))) {
    throw new Error('Sync not initialised. Run initSync() first.');
  }

  git('pull --rebase origin HEAD');

  // Copy synced files back into ~/.sweech/
  for (const file of SYNCABLE_FILES) {
    const src = path.join(SYNC_DIR, file);
    const dest = path.join(SWEECH_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  // Update meta
  const meta = readMeta();
  meta.lastSync = new Date().toISOString();
  writeMeta(meta);
}

/**
 * Return the current sync status without performing any git operations that
 * touch the network.
 */
export function getSyncStatus(): { initialized: boolean; remote?: string; lastSync?: string } {
  const initialized = fs.existsSync(path.join(SYNC_DIR, '.git'));

  if (!initialized) {
    return { initialized: false };
  }

  let remote: string | undefined;
  try {
    remote = git('remote get-url origin') || undefined;
  } catch {
    // No remote configured
  }

  const meta = readMeta();

  return {
    initialized: true,
    remote,
    lastSync: meta.lastSync,
  };
}
