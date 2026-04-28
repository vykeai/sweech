/**
 * Share / unshare commands — selective symlink management for profiles.
 *
 * `sweech share <profile>`   — interactively share dirs/files from a source profile
 * `sweech unshare <profile>` — remove shared symlinks and restore isolated dirs/files
 * `sweech share --status`    — show sharing status for all profiles
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigManager, SHAREABLE_DIRS, SHAREABLE_FILES, CODEX_SHAREABLE_DIRS, CODEX_SHAREABLE_FILES } from './config';

// ── Item categorization ──────────────────────────────────────────────────────

/** Skills-related items — default checked in the interactive picker */
export const SKILLS_ITEMS = ['commands', 'mcp.json', 'hooks', 'agents', 'CLAUDE.md'] as const;

/** Data items — default unchecked */
export const DATA_ITEMS = ['projects', 'plans', 'tasks', 'todos', 'teams', 'plugins', 'sessions'] as const;

type ShareableItem = string;

function getShareableItems(cliType?: string): ShareableItem[] {
  const isCodex = cliType === 'codex';
  const dirs = isCodex ? [...CODEX_SHAREABLE_DIRS] : [...SHAREABLE_DIRS];
  const files = isCodex ? [...CODEX_SHAREABLE_FILES] : [...SHAREABLE_FILES];
  return [...dirs, ...files];
}

function isSkillsItem(item: string): boolean {
  return (SKILLS_ITEMS as readonly string[]).includes(item);
}

function resolveSourceDir(source: string, config: ConfigManager): string {
  const defaultDirs = ['claude', 'codex'];
  return defaultDirs.includes(source)
    ? path.join(os.homedir(), `.${source}`)
    : config.getProfileDir(source);
}

function getSharedItems(profileDir: string, items: ShareableItem[]): Array<{ item: string; target: string }> {
  const shared: Array<{ item: string; target: string }> = [];
  for (const item of items) {
    const itemPath = path.join(profileDir, item);
    try {
      if (fs.lstatSync(itemPath).isSymbolicLink()) {
        shared.push({ item, target: fs.readlinkSync(itemPath) });
      }
    } catch {}
  }
  return shared;
}

// ── sweech share ─────────────────────────────────────────────────────────────

export async function runShare(
  profileName: string,
  opts: { from?: string; all?: boolean },
): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const profile = profiles.find(p => p.commandName === profileName);

  if (!profile) {
    console.error(chalk.red(`\nProfile '${profileName}' not found\n`));
    process.exit(1);
  }

  const source = opts.from || 'claude';
  const sourceDir = resolveSourceDir(source, config);

  if (!fs.existsSync(sourceDir)) {
    console.error(chalk.red(`\nSource profile directory not found: ${sourceDir}\n`));
    process.exit(1);
  }

  // Prevent circular sharing
  const sourceProfile = profiles.find(p => p.commandName === source);
  if (sourceProfile?.sharedWith === profileName) {
    console.error(chalk.red(`\nCircular sharing: '${source}' already shares from '${profileName}'\n`));
    process.exit(1);
  }

  const profileDir = config.getProfileDir(profileName);
  const items = getShareableItems(profile.cliType);
  const alreadyShared = getSharedItems(profileDir, items);
  const alreadySet = new Set(alreadyShared.map(s => s.item));

  // Determine which items to share
  let selected: string[];

  if (opts.all) {
    selected = items.filter(item => !alreadySet.has(item));
  } else {
    const choices = items.map(item => {
      const isShared = alreadySet.has(item);
      return {
        name: isShared ? `${item}  ${chalk.dim('(already shared)')}` : item,
        value: item,
        checked: isShared || isSkillsItem(item),
        disabled: isShared ? 'already shared' : false,
      };
    });

    const { items: picked } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'items',
        message: `Share from ${chalk.cyan(source)} → ${chalk.bold(profileName)}:`,
        choices,
      },
    ]);
    selected = picked;
  }

  if (selected.length === 0) {
    console.log(chalk.yellow('\nNothing to share\n'));
    return;
  }

  // Create symlinks
  let linked = 0;
  for (const item of selected) {
    const linkPath = path.join(profileDir, item);
    const targetPath = path.join(sourceDir, item);

    // Ensure target exists
    const isDirItem = !(SHAREABLE_FILES as readonly string[]).includes(item)
      && !(CODEX_SHAREABLE_FILES as readonly string[]).includes(item);

    if (!fs.existsSync(targetPath)) {
      if (isDirItem) {
        fs.mkdirSync(targetPath, { recursive: true, mode: 0o700 });
      } else {
        fs.writeFileSync(targetPath, '');
      }
    }

    // Remove existing item (backup real files/dirs)
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      } else {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {}

    fs.symlinkSync(targetPath, linkPath);
    linked++;
  }

  // Update sharedWith in config
  profile.sharedWith = source;
  const allProfiles = profiles.map(p => p.commandName === profileName ? profile : p);
  fs.writeFileSync(config.getConfigFile(), JSON.stringify(allProfiles, null, 2));

  console.log(chalk.green(`\n✓ Shared ${linked} item(s) from ${chalk.cyan(source)} → ${chalk.bold(profileName)}\n`));
  for (const item of selected) {
    console.log(chalk.dim(`  🔗 ${item}`));
  }
  console.log();
}

// ── sweech unshare ───────────────────────────────────────────────────────────

export async function runUnshare(
  profileName: string,
  opts: { all?: boolean },
): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const profile = profiles.find(p => p.commandName === profileName);

  if (!profile) {
    console.error(chalk.red(`\nProfile '${profileName}' not found\n`));
    process.exit(1);
  }

  const profileDir = config.getProfileDir(profileName);
  const items = getShareableItems(profile.cliType);
  const shared = getSharedItems(profileDir, items);

  if (shared.length === 0) {
    console.log(chalk.dim(`\n  ${profileName} has no shared items\n`));
    return;
  }

  let selected: string[];

  if (opts.all) {
    selected = shared.map(s => s.item);
  } else {
    const choices = shared.map(s => ({
      name: `${s.item}  ${chalk.dim(`→ ${s.target}`)}`,
      value: s.item,
      checked: true,
    }));

    const { items: picked } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'items',
        message: `Unshare from ${chalk.bold(profileName)}:`,
        choices,
      },
    ]);
    selected = picked;
  }

  if (selected.length === 0) {
    console.log(chalk.yellow('\nNothing to unshare\n'));
    return;
  }

  let unlinked = 0;
  for (const item of selected) {
    const linkPath = path.join(profileDir, item);

    try {
      fs.unlinkSync(linkPath);
    } catch {}

    // Restore empty dir or file
    const isDirItem = !(SHAREABLE_FILES as readonly string[]).includes(item)
      && !(CODEX_SHAREABLE_FILES as readonly string[]).includes(item);

    if (isDirItem) {
      fs.mkdirSync(linkPath, { recursive: true, mode: 0o700 });
    } else {
      fs.writeFileSync(linkPath, '');
    }

    unlinked++;
  }

  // Check if anything is still shared
  const remaining = getSharedItems(profileDir, items);
  if (remaining.length === 0 && profile.sharedWith) {
    delete profile.sharedWith;
    const allProfiles = profiles.map(p => p.commandName === profileName ? profile : p);
    fs.writeFileSync(config.getConfigFile(), JSON.stringify(allProfiles, null, 2));
  }

  console.log(chalk.green(`\n✓ Unshared ${unlinked} item(s) from ${chalk.bold(profileName)}`));
  if (remaining.length > 0) {
    console.log(chalk.dim(`  ${remaining.length} item(s) still shared`));
  }
  console.log();
}

// ── sweech share --status ────────────────────────────────────────────────────

export async function runShareStatus(): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();

  console.log(chalk.bold('\n  sweech · share status\n'));

  if (profiles.length === 0) {
    console.log(chalk.dim('  No profiles configured.\n'));
    return;
  }

  // Build reverse map: source → profiles sharing from it
  const reverseMap = new Map<string, string[]>();
  for (const p of profiles) {
    if (p.sharedWith) {
      if (!reverseMap.has(p.sharedWith)) reverseMap.set(p.sharedWith, []);
      reverseMap.get(p.sharedWith)!.push(p.commandName);
    }
  }

  // Show default CLIs that have dependents
  for (const defaultName of ['claude', 'codex']) {
    const dependents = reverseMap.get(defaultName);
    if (dependents) {
      console.log(`  ${chalk.bold(defaultName)} ${chalk.dim('[default]')}`);
      console.log(`    ${chalk.dim('← shared by:')} ${dependents.join(', ')}`);
      console.log();
    }
  }

  for (const profile of profiles) {
    const profileDir = config.getProfileDir(profile.commandName);
    const items = getShareableItems(profile.cliType);
    const shared = getSharedItems(profileDir, items);
    const dependents = reverseMap.get(profile.commandName);

    console.log(`  ${chalk.bold(profile.commandName)}`);

    if (dependents) {
      console.log(`    ${chalk.dim('← shared by:')} ${dependents.join(', ')}`);
    }

    if (shared.length > 0) {
      const source = profile.sharedWith || '?';
      const itemList = shared.map(s => s.item).join(', ');
      console.log(`    ${chalk.dim('→')} ${chalk.cyan(source)}  ${chalk.dim(itemList)}  ${chalk.dim(`(${shared.length} items)`)}`);
    } else {
      console.log(`    ${chalk.dim('(isolated — no shared items)')}`);
    }

    console.log();
  }
}
