#!/usr/bin/env node

/**
 * 🍭 Sweetch CLI - Switch between Claude accounts and AI providers
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager } from './config';
import { getProvider, getProviderList, PROVIDERS } from './providers';
import { interactiveAddProvider, confirmRemoveProvider } from './interactive';
import { getDefaultCLI, getCLI, SUPPORTED_CLIS } from './clis';
import { backupSweetch, restoreSweetch, backupClaude } from './backup';
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
import { getAccountInfo, getKnownAccounts, setMeta } from './subscriptions';
import { startSweechFedServer } from './fedServer';
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

      const binDir = config.getBinDir();
      const pathIncludesBin = (process.env.PATH || '').split(':').includes(binDir);

      if (!pathIncludesBin) {
        console.log(chalk.blue('\nℹ'), chalk.gray(`Add to your PATH:`));
        console.log(chalk.gray(`  export PATH="${binDir}:$PATH"`));
        console.log(chalk.gray(`  Add this to your ~/.zshrc or ~/.bashrc`));
      }

      console.log(chalk.green('\nNow run:'), chalk.bold(answers.commandName));
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
    const { execFileSync } = require('child_process');
    const os = require('os');
    const fs = require('fs');

    console.log(chalk.bold('\n🍭 Providers:\n'));

    // Show detected default CLIs
    for (const cli of Object.values(SUPPORTED_CLIS)) {
      let installed = false;
      try {
        execFileSync('which', [cli.command], { stdio: 'ignore' });
        installed = true;
      } catch {}

      if (!installed) continue;

      const configDir = path.join(os.homedir(), `.${cli.name}`);
      const hasConfig = fs.existsSync(configDir);
      const sharingProfiles = profiles.filter(p => p.sharedWith === cli.command);
      const reverseTag = sharingProfiles.length > 0
        ? chalk.gray(` (← shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`)
        : '';

      console.log(chalk.cyan('▸'), chalk.bold(cli.command) + chalk.gray(' [default]') + reverseTag);
      console.log(chalk.gray('  CLI:'), cli.displayName);
      console.log(chalk.gray('  Config:'), hasConfig ? `~/.${cli.name}/` : chalk.yellow('not configured'));
      console.log();
    }

    // Show sweech-managed profiles
    profiles.forEach(profile => {
      const provider = getProvider(profile.provider);
      const cli = getCLI(profile.cliType || 'claude');
      const sharedTag = profile.sharedWith ? chalk.magenta(` [shared ↔ ${profile.sharedWith}]`) : '';
      const sharingProfiles = profiles.filter(p => p.sharedWith === profile.commandName);
      const reverseTag = sharingProfiles.length > 0
        ? chalk.gray(` (← shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`)
        : '';
      console.log(chalk.cyan('▸'), chalk.bold(profile.commandName) + sharedTag + reverseTag);
      console.log(chalk.gray('  CLI:'), cli?.displayName || profile.cliType);
      console.log(chalk.gray('  Provider:'), provider?.displayName || profile.provider);
      console.log(chalk.gray('  Model:'), profile.model || 'default');
      console.log(chalk.gray('  Created:'), new Date(profile.createdAt).toLocaleDateString());
      console.log();
    });

    if (profiles.length === 0) {
      console.log(chalk.gray('No additional profiles configured. Run'), chalk.bold('sweech add'), chalk.gray('to create one.\n'));
    }
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

      // Warn if other profiles share data with this profile
      const dependents = profiles.filter(p => p.sharedWith === commandName);
      if (dependents.length > 0) {
        const depNames = dependents.map(p => p.commandName).join(', ');
        console.log(chalk.yellow(`\n⚠️  The following profiles are sharing data with this one: ${depNames}`));
        console.log(chalk.yellow('   Their symlinks will break.'));

        const { confirmDependents } = await import('inquirer').then(m => m.default.prompt([
          {
            type: 'confirm',
            name: 'confirmDependents',
            message: 'Remove anyway?',
            default: false
          }
        ]));
        if (!confirmDependents) {
          console.log(chalk.yellow('\nCancelled\n'));
          return;
        }
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

// Backup Claude command
program
  .command('backup-claude')
  .description('Zip ~/.claude/ (conversations, hooks, commands, settings) excluding cache and temp files')
  .option('-o, --output <file>', 'Output file path (default: claude-backup-YYYYMMDD.zip)')
  .action(async (options) => {
    try {
      await backupClaude(options.output);
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

// ── sweech serve ───────────────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start the fed integration server (exposes /fed/info, /fed/runs, /fed/widget)')
  .option('--port <number>', 'Port to listen on', '7854')
  .action(async (opts: { port: string }) => {
    const port = parseInt(opts.port, 10);
    try {
      await startSweechFedServer(port);
      console.log(chalk.green(`sweech federation server running on :${port}`));
      console.log(chalk.dim(`  /fed/info   — metadata`));
      console.log(chalk.dim(`  /fed/runs   — account list`));
      console.log(chalk.dim(`  /fed/widget — account-usage widget`));
      // Keep alive
      await new Promise(() => {});
    } catch (error: any) {
      console.error(chalk.red('Failed to start server:'), error.message);
      process.exit(1);
    }
  });

// ── sweech usage ───────────────────────────────────────────────────────────────
const usageCmd = program
  .command('usage')
  .description('Show account usage windows (5h rolling + 7d) for Claude and Codex accounts')
  .option('--json', 'Output machine-readable JSON')
  .option('--refresh', 'Force-refresh live usage instead of using cached data')
  .action(async (opts: { json?: boolean; refresh?: boolean }) => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();
    const accountList = getKnownAccounts(profiles);

    if (accountList.length === 0) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ accounts: [] }, null, 2) + '\n');
      } else {
        console.log(chalk.dim('\nNo accounts found. Run sweech add to get started.\n'));
      }
      return;
    }

    const accounts = await getAccountInfo(accountList, { refresh: opts.refresh });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ accounts }, null, 2) + '\n');
      return;
    }

    console.log(chalk.bold('\n  sweech · usage\n'));

    for (const a of accounts) {
      const planStr = a.meta.plan ? chalk.cyan(` [${a.meta.plan}]`) : '';
      const emailStr = a.emailAddress ? chalk.dim(` · ${a.emailAddress}`) : '';
      const cliStr = chalk.dim(` · ${a.cliType}`);
      console.log(`  ${chalk.bold(a.name)}${cliStr}${planStr}${emailStr}`);

      // 5-hour window — prefer live utilization % if available
      const cap5hStr = a.minutesUntilFirstCapacity !== undefined
        ? chalk.dim(` · first capacity in ${a.minutesUntilFirstCapacity}m`)
        : '';
      const live5hStr = a.live?.utilization5h !== undefined
        ? chalk.dim(` (${Math.round(a.live.utilization5h * 100)}% live)`)
        : '';
      console.log(`    5h window:  ${chalk.white(String(a.messages5h))} messages${live5hStr}${cap5hStr}`);

      // 7-day window
      const weeklyStr = a.hoursUntilWeeklyReset !== undefined
        ? chalk.dim(` · resets in ${a.hoursUntilWeeklyReset}h`)
        : chalk.dim(' · set plan to compute (from subscriptionCreatedAt)');
      const live7dStr = a.live?.utilization7d !== undefined
        ? chalk.dim(` (${Math.round(a.live.utilization7d * 100)}% live)`)
        : '';
      console.log(`    7d window:  ${chalk.white(String(a.messages7d))} messages${live7dStr}${weeklyStr}`);

      const lastStr = a.lastActive
        ? chalk.dim(`  last: ${new Date(a.lastActive).toLocaleString()}`)
        : '';
      if (lastStr) console.log(`   ${lastStr}`);
      console.log();
    }
  });

usageCmd
  .command('set-plan <account> <plan>')
  .description('Set the plan label for an account (e.g. "Max 5x", "Max 20x", "Pro")')
  .action((account: string, plan: string) => {
    const config = new ConfigManager();
    const known = getKnownAccounts(config.getProfiles());
    const profile = known.find(p => p.name === account || p.commandName === account);
    if (!profile) {
      console.error(chalk.red(`Account '${account}' not found`));
      console.log(chalk.dim('Available: ' + known.map(p => p.name).join(', ')));
      process.exit(1);
    }
    setMeta(profile.commandName, { plan });
    console.log(chalk.green(`✓ Plan set to "${plan}" for ${profile.name}`));
  });

usageCmd
  .command('set-limits <account> <5h> <7d>')
  .description('Set known message limits for progress bars (e.g. "Max 5x" = 225 5h, 2000 7d)')
  .action((account: string, limit5h: string, limit7d: string) => {
    const config = new ConfigManager();
    const known = getKnownAccounts(config.getProfiles());
    const profile = known.find(p => p.name === account || p.commandName === account);
    if (!profile) {
      console.error(chalk.red(`Account '${account}' not found`));
      process.exit(1);
    }
    setMeta(profile.commandName, { limits: { window5h: parseInt(limit5h), window7d: parseInt(limit7d) } });
    console.log(chalk.green(`✓ Limits set for ${profile.name}: 5h=${limit5h} 7d=${limit7d}`));
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

// Update command - Self-update sweech
program
  .command('update')
  .description('Update sweech to the latest version from GitHub')
  .action(async () => {
    try {
      console.log(chalk.bold('\n🔄 Updating sweech...\n'));
      const { execSync: execSyncUpdate } = require('child_process');
      execSyncUpdate('npm install -g github:vykeai/sweech', { stdio: 'inherit' });
      console.log(chalk.green('\n✓ sweech updated successfully\n'));
    } catch (error: any) {
      console.error(chalk.red('Update failed:'), error.message);
      process.exit(1);
    }
  });

// Resync command - re-apply shared symlinks for a profile
program
  .command('resync <command-name>')
  .description('Re-apply all shared symlinks for a profile (use after upgrading sweech)')
  .action((commandName: string) => {
    const config = new ConfigManager();
    const profile = config.getProfiles().find(p => p.commandName === commandName);
    if (!profile) {
      console.error(chalk.red(`Profile '${commandName}' not found`));
      process.exit(1);
    }
    if (!profile.sharedWith) {
      console.error(chalk.red(`Profile '${commandName}' is not in shared mode`));
      process.exit(1);
    }
    config.setupSharedDirs(commandName, profile.sharedWith, profile.cliType);
    console.log(chalk.green(`✓ Symlinks resynced for ${commandName} → ${profile.sharedWith}\n`));
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
