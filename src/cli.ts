#!/usr/bin/env node

/**
 * 🍭 Sweetch CLI - Switch between Claude accounts and AI providers
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from './config';
import { getProvider, getProviderList, PROVIDERS } from './providers';
import { interactiveAddProvider, confirmRemoveProvider } from './interactive';
import { getDefaultCLI, getCLI } from './clis';
import { backupSweetch, restoreSweetch } from './backup';
import { UsageTracker } from './usage';
import { AliasManager } from './aliases';
import { generateBashCompletion, generateZshCompletion } from './completion';
import { confirmChatBackupBeforeRemoval, backupChatHistory } from './chatBackup';
import { isDefaultCLIDirectory } from './reset';
import { runDoctor, runPath, runTest, runEdit, runClone, runRename } from './utilityCommands';
import { runReset } from './reset';
import { runInit } from './init';
import { createProfile } from './profileCreation';
import { runLauncher } from './launcher';
import * as path from 'path';
import * as fs from 'fs';

// Read version from package.json
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

const program = new Command();

program
  .name('sweech')
  .description('🍭 Switch between Claude accounts and external AI providers')
  .version(version, '-v, --version', 'Output the current version');

// Interactive onboarding
program
  .command('init')
  .description('Interactive onboarding for first-time setup')
  .action(async () => {
    try {
      await runInit();
    } catch (error: any) {
      console.error(chalk.red('Error during initialization:', error.message));
      process.exit(1);
    }
  });

// Add provider command
program
  .command('add')
  .description('Add a new provider with interactive setup')
  .action(async () => {
    try {
      const config = new ConfigManager();
      const existingProfiles = config.getProfiles();
      const answers = await interactiveAddProvider(existingProfiles);

      // Use custom provider config if provided, otherwise get from registry
      const provider = answers.customProviderConfig || getProvider(answers.provider);
      if (!provider) {
        console.error(chalk.red(`Provider '${answers.provider}' not found`));
        process.exit(1);
      }

      // Get CLI config from answers
      const cli = getCLI(answers.cliType);
      if (!cli) {
        console.error(chalk.red(`CLI '${answers.cliType}' not found`));
        process.exit(1);
      }

      // Create profile with OAuth or API key
      await createProfile(answers, provider, cli, config);

      console.log(chalk.cyan('Config dir:'), config.getProfileDir(answers.commandName));

      console.log(chalk.yellow('\n⚠️  Add to your PATH:'));
      console.log(chalk.gray(`   export PATH="${config.getBinDir()}:$PATH"`));
      console.log(chalk.gray(`   Add this to your ~/.zshrc or ~/.bashrc\n`));

      console.log(chalk.green('Now run:'), chalk.bold(answers.commandName));
      console.log();
      console.log(chalk.gray('💡 Tip: You can add multiple accounts for the same provider!'));
      console.log(chalk.gray('   Example: claude-mini, minimax-work, minimax-personal, etc.'));
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// List providers command
program
  .command('list')
  .alias('ls')
  .description('List all configured providers')
  .action(() => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();

    if (profiles.length === 0) {
      console.log(chalk.yellow('\n🍭 No providers configured yet. Run:'), chalk.bold('sweetch add'));
      console.log();
      return;
    }

    console.log(chalk.bold('\n🍭 Configured Providers:\n'));

    profiles.forEach(profile => {
      const provider = getProvider(profile.provider);
      const cli = getCLI(profile.cliType || 'claude');
      const sharedTag = profile.sharedWith ? chalk.magenta(` [shared ↔ ${profile.sharedWith}]`) : '';
      console.log(chalk.cyan('▸'), chalk.bold(profile.commandName) + sharedTag);
      console.log(chalk.gray('  CLI:'), cli?.displayName || profile.cliType);
      console.log(chalk.gray('  Provider:'), provider?.displayName || profile.provider);
      console.log(chalk.gray('  Model:'), profile.model || 'default');
      console.log(chalk.gray('  Created:'), new Date(profile.createdAt).toLocaleDateString());
      console.log();
    });

    console.log(chalk.gray('Default Claude account is in ~/.claude/ (use "claude" command)\n'));
  });

// Remove provider command
program
  .command('remove <command-name>')
  .alias('rm')
  .description('Remove a configured provider')
  .action(async (commandName: string) => {
    try {
      const config = new ConfigManager();
      const profiles = config.getProfiles();

      const profile = profiles.find(p => p.commandName === commandName);
      if (!profile) {
        console.error(chalk.red(`Provider '${commandName}' not found`));
        process.exit(1);
      }

      const profileDir = config.getProfileDir(commandName);

      // PROTECTION: Never allow removal of default CLI directories
      if (isDefaultCLIDirectory(profileDir)) {
        console.error(chalk.red(`\n✗ Cannot remove default CLI directory: ${profileDir}`));
        console.log(chalk.yellow(`  This is a system default and should not be managed by sweetch.`));
        console.log(chalk.gray(`  To backup: sweetch backup-chats ${commandName}\n`));
        process.exit(1);
      }

      // Check for chat history and offer backup
      const shouldProceed = await confirmChatBackupBeforeRemoval(commandName, profileDir);
      if (!shouldProceed) {
        console.log(chalk.yellow('\nCancelled\n'));
        return;
      }

      const confirmed = await confirmRemoveProvider(commandName);
      if (!confirmed) {
        console.log(chalk.yellow('Cancelled'));
        return;
      }

      config.removeProfile(commandName);
      console.log(chalk.green(`\n✓ Removed '${commandName}' successfully\n`));
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Info command
program
  .command('info')
  .description('Show sweetch configuration info')
  .action(() => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();
    console.log(chalk.bold('\n🍭 Sweetch Configuration:\n'));
    console.log(chalk.cyan('Version:'), '0.1.0');
    console.log(chalk.cyan('Config directory:'), config.getBinDir().replace('/bin', ''));
    console.log(chalk.cyan('Wrapper scripts:'), config.getBinDir());
    console.log(chalk.cyan('Profiles:'), profiles.length);
    console.log(chalk.cyan('Default Claude:'), path.join(require('os').homedir(), '.claude'));
    console.log();
    console.log(chalk.gray('💡 Run'), chalk.bold('sweetch list'), chalk.gray('to see all providers'));
    console.log();
  });

// Update wrappers command (hidden, for maintenance)
program
  .command('update-wrappers')
  .description('Regenerate wrapper scripts for all profiles')
  .action(() => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();

    console.log(chalk.bold('\n🔄 Updating wrapper scripts...\n'));

    profiles.forEach(profile => {
      const cli = getCLI(profile.cliType);
      if (cli) {
        config.createWrapperScript(profile.commandName, cli);
        console.log(chalk.green('✓'), profile.commandName);
      }
    });

    console.log(chalk.green('\n✓ All wrapper scripts updated\n'));
  });

// Backup command
program
  .command('backup')
  .description('Create a password-protected backup of all sweetch configurations')
  .option('-o, --output <file>', 'Output file path (default: sweetch-backup-YYYYMMDD.zip)')
  .action(async (options) => {
    try {
      await backupSweetch(options.output);
    } catch (error: any) {
      console.error(chalk.red('Backup failed:'), error.message);
      process.exit(1);
    }
  });

// Restore command
program
  .command('restore <backup-file>')
  .description('Restore sweetch configuration from a backup')
  .action(async (backupFile: string) => {
    try {
      await restoreSweetch(backupFile);
    } catch (error: any) {
      console.error(chalk.red('Restore failed:'), error.message);
      process.exit(1);
    }
  });

// Stats command
program
  .command('stats [command-name]')
  .description('Show usage statistics for providers')
  .action((commandName?: string) => {
    const tracker = new UsageTracker();
    const stats = tracker.getStats(commandName);

    if (stats.length === 0) {
      console.log(chalk.yellow('\n📊 No usage data yet. Start using your providers!\n'));
      return;
    }

    console.log(chalk.bold('\n📊 Usage Statistics:\n'));

    stats.forEach(stat => {
      const lastUsed = new Date(stat.lastUsed);
      const firstUsed = new Date(stat.firstUsed);
      const daysSinceFirst = Math.floor(
        (Date.now() - firstUsed.getTime()) / (1000 * 60 * 60 * 24)
      );
      const avgPerDay = daysSinceFirst > 0 ? (stat.totalUses / daysSinceFirst).toFixed(1) : stat.totalUses;

      console.log(chalk.cyan('▸'), chalk.bold(stat.commandName));
      console.log(chalk.gray('  Total uses:'), stat.totalUses);
      console.log(chalk.gray('  Last used:'), lastUsed.toLocaleString());
      console.log(chalk.gray('  First used:'), firstUsed.toLocaleDateString());
      console.log(chalk.gray('  Avg per day:'), avgPerDay);
      console.log();
    });
  });

// Show command
program
  .command('show <command-name>')
  .description('Show detailed information about a provider')
  .action((commandName: string) => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();
    const aliasManager = new AliasManager();
    const tracker = new UsageTracker();

    // Resolve alias if needed
    const resolvedName = aliasManager.resolveAlias(commandName);
    const profile = profiles.find(p => p.commandName === resolvedName);

    if (!profile) {
      console.error(chalk.red(`Provider '${commandName}' not found`));
      process.exit(1);
    }

    const provider = getProvider(profile.provider);
    const cli = getCLI(profile.cliType);
    const stats = tracker.getStats(profile.commandName);
    const stat = stats.find(s => s.commandName === profile.commandName);

    console.log(chalk.bold(`\n🍭 ${profile.commandName}\n`));
    console.log(chalk.cyan('Provider:'), provider?.displayName || profile.provider);
    console.log(chalk.cyan('CLI:'), cli?.displayName || profile.cliType);
    console.log(chalk.cyan('Model:'), profile.model || 'default');
    if (profile.smallFastModel) {
      console.log(chalk.cyan('Fast model:'), profile.smallFastModel);
    }
    console.log(chalk.cyan('API endpoint:'), profile.baseUrl || 'default');
    console.log(chalk.cyan('Config dir:'), config.getProfileDir(profile.commandName));
    console.log(chalk.cyan('Created:'), new Date(profile.createdAt).toLocaleDateString());

    if (stat) {
      console.log();
      console.log(chalk.bold('Usage:'));
      console.log(chalk.gray('  Total uses:'), stat.totalUses);
      console.log(chalk.gray('  Last used:'), new Date(stat.lastUsed).toLocaleString());
    }

    // Show aliases pointing to this command
    const aliases = aliasManager.getAliases();
    const pointingAliases = Object.entries(aliases)
      .filter(([_, cmd]) => cmd === profile.commandName)
      .map(([alias]) => alias);

    if (pointingAliases.length > 0) {
      console.log();
      console.log(chalk.bold('Aliases:'), pointingAliases.join(', '));
    }

    console.log();
  });

// Alias command
program
  .command('alias [action] [value]')
  .description('Manage command aliases (list, add: work=claude-mini, remove: work)')
  .action((action?: string, value?: string) => {
    const aliasManager = new AliasManager();
    const config = new ConfigManager();

    // List aliases
    if (!action || action === 'list') {
      const aliases = aliasManager.getAliases();

      if (Object.keys(aliases).length === 0) {
        console.log(chalk.yellow('\n🔗 No aliases configured yet\n'));
        console.log(chalk.gray('Add an alias with:'), chalk.bold('sweetch alias work=claude-mini'));
        console.log();
        return;
      }

      console.log(chalk.bold('\n🔗 Command Aliases:\n'));
      Object.entries(aliases).forEach(([alias, command]) => {
        console.log(chalk.cyan('  ' + alias), chalk.gray('→'), command);
      });
      console.log();
      return;
    }

    // Remove alias
    if (action === 'remove') {
      if (!value) {
        console.error(chalk.red('Error: Alias name required'));
        console.log(chalk.gray('Usage:'), chalk.bold('sweetch alias remove <alias>'));
        process.exit(1);
      }

      try {
        aliasManager.removeAlias(value);
        console.log(chalk.green(`\n✓ Removed alias '${value}'\n`));
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
      return;
    }

    // Add alias (format: short=command)
    if (action.includes('=')) {
      const [alias, command] = action.split('=');

      if (!alias || !command) {
        console.error(chalk.red('Error: Invalid alias format'));
        console.log(chalk.gray('Usage:'), chalk.bold('sweetch alias work=claude-mini'));
        process.exit(1);
      }

      // Verify command exists
      const profiles = config.getProfiles();
      if (!profiles.find(p => p.commandName === command)) {
        console.error(chalk.red(`Error: Command '${command}' not found`));
        process.exit(1);
      }

      try {
        aliasManager.addAlias(alias, command);
        console.log(chalk.green(`\n✓ Added alias: ${alias} → ${command}\n`));
        console.log(chalk.gray('Now you can use:'), chalk.bold(alias));
        console.log();
      } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
      }
      return;
    }

    console.error(chalk.red('Error: Invalid action'));
    console.log();
    console.log(chalk.bold('Usage:'));
    console.log(chalk.gray('  sweetch alias'), chalk.dim('# List all aliases'));
    console.log(chalk.gray('  sweetch alias list'), chalk.dim('# List all aliases'));
    console.log(chalk.gray('  sweetch alias work=claude-mini'), chalk.dim('# Add alias'));
    console.log(chalk.gray('  sweetch alias remove work'), chalk.dim('# Remove alias'));
    console.log();
    process.exit(1);
  });

// Discover command
program
  .command('discover')
  .description('Discover available AI providers')
  .action(() => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();
    const configuredProviders = new Set(profiles.map(p => p.provider));

    console.log(chalk.bold('\n🔍 Available AI Providers:\n'));

    Object.values(PROVIDERS).forEach(provider => {
      const isConfigured = configuredProviders.has(provider.name);
      const icon = isConfigured ? chalk.green('✓') : chalk.gray('○');

      console.log(icon, chalk.bold(provider.displayName));
      console.log(chalk.gray('  ' + provider.description));
      if (provider.pricing) {
        console.log(chalk.gray('  Pricing:'), provider.pricing);
      }
      console.log(chalk.gray('  Default model:'), provider.defaultModel);

      if (isConfigured) {
        const userProfiles = profiles.filter(p => p.provider === provider.name);
        console.log(
          chalk.gray('  Your commands:'),
          userProfiles.map(p => chalk.cyan(p.commandName)).join(', ')
        );
      }
      console.log();
    });

    console.log(chalk.gray('💡 Add a provider with:'), chalk.bold('sweetch add'));
    console.log();
  });

// Completion command
program
  .command('completion <shell>')
  .description('Generate shell completion script (bash or zsh)')
  .action((shell: string) => {
    if (shell !== 'bash' && shell !== 'zsh') {
      console.error(chalk.red('Error: Unsupported shell. Use "bash" or "zsh"'));
      process.exit(1);
    }

    const completion = shell === 'bash' ? generateBashCompletion() : generateZshCompletion();
    console.log(completion);

    // Show installation instructions
    console.error(); // stderr to not interfere with script output
    console.error(chalk.bold.cyan('📝 Installation Instructions:'));
    console.error();

    if (shell === 'bash') {
      console.error(chalk.gray('1. Save the completion script:'));
      console.error(chalk.yellow('   sweetch completion bash > ~/.sweech-completion.bash'));
      console.error();
      console.error(chalk.gray('2. Add to your ~/.bashrc or ~/.bash_profile:'));
      console.error(chalk.yellow('   source ~/.sweech-completion.bash'));
    } else {
      console.error(chalk.gray('1. Save the completion script:'));
      console.error(chalk.yellow('   sweetch completion zsh > ~/.sweech-completion.zsh'));
      console.error();
      console.error(chalk.gray('2. Add to your ~/.zshrc:'));
      console.error(chalk.yellow('   source ~/.sweech-completion.zsh'));
    }

    console.error();
    console.error(chalk.gray('3. Reload your shell:'));
    console.error(chalk.yellow(`   source ~/.${shell === 'bash' ? 'bashrc' : 'zshrc'}`));
    console.error();
  });

// Doctor command - Health check
program
  .command('doctor')
  .description('Check sweetch installation and configuration')
  .action(async () => {
    try {
      await runDoctor();
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Path command - PATH configuration helper
program
  .command('path')
  .description('Show and configure PATH for sweetch commands')
  .action(async () => {
    try {
      await runPath();
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Test command - Test provider connection
program
  .command('test <command-name>')
  .description('Test provider configuration and connection')
  .action(async (commandName: string) => {
    try {
      await runTest(commandName);
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Edit command - Edit profile configuration
program
  .command('edit <command-name>')
  .description('Edit an existing profile configuration')
  .action(async (commandName: string) => {
    try {
      await runEdit(commandName);
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Clone command - Clone an existing profile
program
  .command('clone <source> <target>')
  .description('Clone an existing profile with a new name')
  .action(async (source: string, target: string) => {
    try {
      await runClone(source, target);
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Rename command - Rename a profile
program
  .command('rename <old-name> <new-name>')
  .description('Rename an existing profile')
  .action(async (oldName: string, newName: string) => {
    try {
      await runRename(oldName, newName);
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Backup chats command - Backup chat history
program
  .command('backup-chats <command-name>')
  .description('Backup chat history for a profile')
  .option('-o, --output <file>', 'Output file path')
  .action(async (commandName: string, options) => {
    try {
      const config = new ConfigManager();
      const profiles = config.getProfiles();
      const profile = profiles.find(p => p.commandName === commandName);

      if (!profile) {
        console.error(chalk.red(`\nProfile '${commandName}' not found\n`));
        process.exit(1);
      }

      const profileDir = config.getProfileDir(commandName);
      await backupChatHistory(commandName, profileDir, options.output);
    } catch (error: any) {
      console.error(chalk.red('Backup failed:'), error.message);
      process.exit(1);
    }
  });

// Reset command - Uninstall sweetch
program
  .command('reset')
  .description('Uninstall sweetch (removes all sweetch-managed profiles)')
  .action(async () => {
    try {
      await runReset();
    } catch (error: any) {
      console.error(chalk.red('Error:'), error.message);
      process.exit(1);
    }
  });

// Default action: interactive launcher when no command given
if (process.argv.length <= 2) {
  runLauncher().catch(err => {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  });
} else {
  program.parse();
}
