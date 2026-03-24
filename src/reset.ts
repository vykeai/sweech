/**
 * Reset/uninstall sweetch
 * Removes all sweetch-managed profiles while protecting default CLI setups
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigManager } from './config';
import { getProvider } from './providers';
import { backupSweetch } from './backup';

/**
 * Get default config directories for known CLIs
 * These should NEVER be touched by sweetch reset
 */
function getDefaultCLIDirectories(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.claude'),           // Claude Code default
    path.join(home, '.codex'),            // Codex default
    path.join(home, '.config', 'claude'), // Alt Claude location
  ];
}

/**
 * Check if a directory is a default CLI directory
 */
export function isDefaultCLIDirectory(dirPath: string): boolean {
  const normalized = path.resolve(dirPath);
  const defaults = getDefaultCLIDirectories().map(d => path.resolve(d));
  return defaults.includes(normalized);
}

/**
 * Check if a profile is using a default CLI directory
 */
export function isDefaultProfile(profileName: string, configDir: string): boolean {
  // Check if config dir is a default directory
  if (isDefaultCLIDirectory(configDir)) {
    return true;
  }

  // Check if profile name suggests it's default (like "claude" without suffix)
  const defaultNames = ['claude', 'codex'];
  if (defaultNames.includes(profileName.toLowerCase())) {
    return true;
  }

  return false;
}

/**
 * sweetch reset - Complete uninstall
 */
export async function runReset(): Promise<void> {
  console.log(chalk.bold.red('\n⚠️  Sweetch Reset (Uninstall)\n'));

  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const sweetchDir = config.getConfigDir();
  const binDir = config.getBinDir();

  // Show what will be affected
  console.log(chalk.bold('Your setup:'));

  if (profiles.length === 0) {
    console.log(chalk.gray('  No profiles configured\n'));
  } else {
    profiles.forEach(profile => {
      const provider = getProvider(profile.provider);
      const profileDir = config.getProfileDir(profile.commandName);
      const isDefault = isDefaultCLIDirectory(profileDir);

      if (isDefault) {
        console.log(chalk.gray(`  • ${profile.commandName} (${provider?.displayName}) [DEFAULT - will be preserved]`));
      } else {
        console.log(chalk.cyan(`  • ${profile.commandName} (${provider?.displayName})`));
      }
    });
    console.log();
  }

  console.log(chalk.bold('This will NOT affect:'));
  const defaultDirs = getDefaultCLIDirectories().filter(d => fs.existsSync(d));
  if (defaultDirs.length > 0) {
    defaultDirs.forEach(dir => {
      console.log(chalk.green(`  ✓ ${dir} (default CLI setup)`));
    });
  } else {
    console.log(chalk.green('  ✓ All default CLI configurations (~/.claude/, ~/.codex/, etc.)'));
  }
  console.log(chalk.green('  ✓ Installed CLIs (claude, codex, etc.)'));
  console.log();

  console.log(chalk.bold('This will remove:'));
  console.log(chalk.red(`  ✗ ${sweetchDir}/ (sweetch configuration)`));
  console.log(chalk.red(`  ✗ ${binDir}/ (wrapper scripts)`));
  console.log(chalk.red('  ✗ All sweetch-managed profiles'));
  console.log(chalk.red('  ✗ Usage statistics'));
  console.log(chalk.red('  ✗ Aliases'));
  console.log();

  // Offer backup
  const { createBackup } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'createBackup',
      message: 'Would you like to create a backup first?',
      default: true
    }
  ]);

  if (createBackup) {
    try {
      console.log();
      await backupSweetch();
      console.log();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Backup failed:', msg));
      const { continueAnyway } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAnyway',
          message: 'Backup failed. Continue with reset anyway?',
          default: false
        }
      ]);

      if (!continueAnyway) {
        console.log(chalk.yellow('\nReset cancelled\n'));
        return;
      }
    }
  }

  // Final confirmation
  const { confirmReset } = await inquirer.prompt([
    {
      type: 'input',
      name: 'confirmReset',
      message: `Type "reset" to confirm complete uninstall:`,
      validate: (input: string) => {
        if (input.toLowerCase() === 'reset') {
          return true;
        }
        return 'Please type "reset" to confirm';
      }
    }
  ]);

  if (confirmReset.toLowerCase() !== 'reset') {
    console.log(chalk.yellow('\nReset cancelled\n'));
    return;
  }

  console.log(chalk.cyan('\n🗑️  Removing sweetch...\n'));

  // Remove sweetch directory
  if (fs.existsSync(sweetchDir)) {
    try {
      fs.rmSync(sweetchDir, { recursive: true, force: true });
      console.log(chalk.green(`  ✓ Removed ${sweetchDir}`));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`  ✗ Failed to remove ${sweetchDir}:`, msg));
    }
  }

  // Note about PATH
  console.log();
  console.log(chalk.yellow('⚠️  Note: You may want to remove sweetch from your PATH'));
  console.log(chalk.gray(`   Remove this line from your shell RC file (~/.zshrc or ~/.bashrc):`));
  console.log(chalk.gray(`   export PATH="$HOME/.sweech/bin:$PATH"`));
  console.log();

  console.log(chalk.green('✓ Sweetch has been uninstalled\n'));
  console.log(chalk.gray('Your default CLI configurations remain untouched.'));
  console.log(chalk.gray('To reinstall: npm install -g sweetch\n'));
}
