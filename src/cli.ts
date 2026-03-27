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
import { summarizeAccountsForTelemetry } from './usage';
import { AliasManager } from './aliases';
import { generateBashCompletion, generateZshCompletion, handleComplete } from './completion';
import { confirmChatBackupBeforeRemoval, backupChatHistory } from './chatBackup';
import { isDefaultCLIDirectory } from './reset';
import { runDoctor, runPath, runTest, runEdit, runClone, runRename } from './utilityCommands';
import { runReset } from './reset';
import { runInit, isFirstRun } from './init';
import { createProfile } from './profileCreation';
import { runLauncher } from './launcher';
import { getAccountInfo, getKnownAccounts, setMeta } from './subscriptions';
import { appendSnapshot, allAccountSparklines } from './usageHistory';
import { startSweechFedServerWithShutdown } from './fedServer';
import { checkForUpdate, fetchChangelog } from './updateChecker';
import { asciiBar, barColor } from './charts';
import { installPlugin, uninstallPlugin, listPlugins } from './plugins';
import { getAllTemplates, findTemplate, saveCustomTemplate, loadCustomTemplates, deleteCustomTemplate, BUILT_IN_TEMPLATES, ProfileTemplate } from './templates';
import * as path from 'path';
import * as fs from 'fs';

// Read version from package.json
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;

// ── Dynamic completion handler (must run before Commander) ────────────────────
const completeIdx = process.argv.indexOf('--complete');
if (completeIdx !== -1) {
  const line = process.argv[completeIdx + 1] || '';
  const completions = handleComplete(line);
  if (completions.length > 0) {
    process.stdout.write(completions.join('\n') + '\n');
  }
  process.exit(0);
}

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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error during initialization:', msg));
      process.exit(1);
    }
  });

// Add provider command
program
  .command('add')
  .description('Add a new provider with interactive setup')
  .option('-t, --template <name>', 'Use a profile template for quick setup')
  .action(async (opts: { template?: string }) => {
    try {
      const config = new ConfigManager();
      const existingProfiles = config.getProfiles();

      // If --template is provided, use template to pre-fill answers
      if (opts.template) {
        const tpl = findTemplate(opts.template);
        if (!tpl) {
          console.error(chalk.red(`Template '${opts.template}' not found`));
          console.log(chalk.dim('Available templates: ' + getAllTemplates().map(t => t.name).join(', ')));
          process.exit(1);
        }

        console.log(chalk.cyan('Using template:'), chalk.bold(tpl.name), chalk.dim(`— ${tpl.description}`));

        // Pre-fill answers from template
        const commandName = tpl.name;
        const provider = getProvider(tpl.provider);
        if (!provider) {
          console.error(chalk.red(`Template provider '${tpl.provider}' not found`));
          process.exit(1);
        }

        const cli = getCLI(tpl.cliType);
        if (!cli) {
          console.error(chalk.red(`Template CLI type '${tpl.cliType}' not found`));
          process.exit(1);
        }

        // Apply template overrides to provider
        const templateProvider = { ...provider };
        if (tpl.model) templateProvider.defaultModel = tpl.model;
        if (tpl.baseUrl) templateProvider.baseUrl = tpl.baseUrl;

        const answers = {
          cliType: tpl.cliType,
          provider: tpl.provider,
          commandName,
          authMethod: 'oauth' as const,
        };

        await createProfile(answers, templateProvider, cli, config);

        const binDir = config.getBinDir();
        const pathIncludesBin = (process.env.PATH || '').split(':').includes(binDir);
        if (!pathIncludesBin) {
          console.log(chalk.blue('\nℹ'), chalk.gray(`Add to your PATH:`));
          console.log(chalk.gray(`  export PATH="${binDir}:$PATH"`));
          console.log(chalk.gray(`  Add this to your ~/.zshrc or ~/.bashrc`));
        }

        console.log(chalk.green('\nNow run:'), chalk.bold(commandName));
        return;
      }

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
      console.log(chalk.gray('Tip: You can add multiple accounts for the same provider!'));
      console.log(chalk.gray('   Example: claude-mini, minimax-work, minimax-personal, etc.'));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
      process.exit(1);
    }
  });

// List providers command
program
  .command('list')
  .alias('ls')
  .description('List all configured providers')
  .action(async () => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();
    const { execFileSync } = require('child_process');
    const os = require('os');
    const fs = require('fs');

    // Helper: format a timestamp as a relative string (e.g. "2h ago", "3d ago")
    const relativeTime = (isoStr?: string): string => {
      if (!isoStr) return chalk.dim('never');
      const diffMs = Date.now() - new Date(isoStr).getTime();
      if (diffMs < 0) return chalk.dim('just now');
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return chalk.dim('just now');
      if (mins < 60) return chalk.dim(`${mins}m ago`);
      const hours = Math.floor(mins / 60);
      if (hours < 24) return chalk.dim(`${hours}h ago`);
      const days = Math.floor(hours / 24);
      if (days < 30) return chalk.dim(`${days}d ago`);
      const months = Math.floor(days / 30);
      return chalk.dim(`${months}mo ago`);
    };

    // Helper: colored status dot based on live status
    const statusDot = (live?: { status?: string }, needsReauth?: boolean): string => {
      if (needsReauth) return chalk.red('●');
      if (!live?.status) return chalk.gray('●');
      switch (live.status) {
        case 'allowed': return chalk.green('●');
        case 'allowed_warning':
        case 'warning': return chalk.yellow('●');
        case 'rejected':
        case 'limit_reached': return chalk.red('●');
        default: return chalk.gray('●');
      }
    };

    // Collect all account refs for getAccountInfo
    const accountRefs: Array<{ name: string; commandName: string; cliType?: string; isDefault?: boolean }> = [];

    // Default CLIs
    const installedDefaults: typeof SUPPORTED_CLIS[keyof typeof SUPPORTED_CLIS][] = [];
    for (const cli of Object.values(SUPPORTED_CLIS)) {
      let installed = false;
      try {
        execFileSync('which', [cli.command], { stdio: 'ignore' });
        installed = true;
      } catch {}
      if (installed) {
        installedDefaults.push(cli);
        accountRefs.push({ name: cli.command, commandName: cli.name, cliType: cli.name, isDefault: true });
      }
    }

    // Sweech-managed profiles
    for (const profile of profiles) {
      accountRefs.push({ name: profile.name, commandName: profile.commandName, cliType: profile.cliType });
    }

    // Fetch account info (status, lastActive) for all accounts
    const accountInfoMap = new Map<string, Awaited<ReturnType<typeof getAccountInfo>>[number]>();
    try {
      const infos = await getAccountInfo(accountRefs);
      for (const info of infos) {
        accountInfoMap.set(info.commandName, info);
      }
    } catch { /* proceed without live data */ }

    console.log(chalk.bold('\n  sweech · profiles\n'));

    // Show detected default CLIs
    for (const cli of installedDefaults) {
      const configDir = path.join(os.homedir(), `.${cli.name}`);
      const hasConfig = fs.existsSync(configDir);
      const sharingProfiles = profiles.filter(p => p.sharedWith === cli.command);
      const reverseTag = sharingProfiles.length > 0
        ? chalk.dim(` (shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`)
        : '';
      const info = accountInfoMap.get(cli.name);
      const dot = statusDot(info?.live, info?.needsReauth);
      const planStr = info?.meta?.plan ? chalk.cyan(` [${info.meta.plan}]`) : '';
      const lastStr = relativeTime(info?.lastActive);
      const configTag = hasConfig ? '' : chalk.yellow(' (not configured)');

      console.log(`  ${dot} ${chalk.bold(cli.command)}${chalk.gray(' [default]')}${planStr}${configTag}  ${lastStr}${reverseTag}`);
    }

    // Show sweech-managed profiles
    for (const profile of profiles) {
      const provider = getProvider(profile.provider);
      const cli = getCLI(profile.cliType || 'claude');
      const info = accountInfoMap.get(profile.commandName);
      const dot = statusDot(info?.live, info?.needsReauth);
      const sharedTag = profile.sharedWith ? chalk.magenta(` [shared -> ${profile.sharedWith}]`) : '';
      const sharingProfiles = profiles.filter(p => p.sharedWith === profile.commandName);
      const reverseTag = sharingProfiles.length > 0
        ? chalk.dim(` (shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`)
        : '';
      const providerStr = chalk.dim(` ${provider?.displayName || profile.provider}`);
      const modelStr = profile.model ? chalk.dim(` · ${profile.model}`) : '';
      const planStr = info?.meta?.plan ? chalk.cyan(` [${info.meta.plan}]`) : '';
      const lastStr = relativeTime(info?.lastActive);

      console.log(`  ${dot} ${chalk.bold(profile.commandName)}${planStr}${providerStr}${modelStr}${sharedTag}  ${lastStr}${reverseTag}`);
    }

    if (installedDefaults.length === 0 && profiles.length === 0) {
      console.log(chalk.gray('  No profiles configured. Run'), chalk.bold('sweech add'), chalk.gray('to create one.'));
    }

    console.log();
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
      process.exit(1);
    }
  });

// Info command
program
  .command('info')
  .description('Show sweech configuration info')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();
    const os = require('os');
    const configDir = config.getBinDir().replace('/bin', '');
    const binDir = config.getBinDir();
    const cacheFile = path.join(os.homedir(), '.sweech', 'rate-limit-cache.json');
    let cacheAge: string | null = null;
    try {
      const stat = fs.statSync(cacheFile);
      const mins = Math.floor((Date.now() - stat.mtimeMs) / 60000);
      cacheAge = mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
    } catch {}

    const claudeProfiles = profiles.filter(p => p.cliType !== 'codex');
    const codexProfiles = profiles.filter(p => p.cliType === 'codex');

    // Include update info (uses cached check — fast, no network if fresh)
    const updateResult = await checkForUpdate(version).catch(() => null);
    const updateInfo = updateResult ? {
      latestVersion: updateResult.latest,
      updateAvailable: updateResult.updateAvailable,
    } : null;

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        version: packageJson.version,
        configDir, binDir, cacheAge,
        profiles: { total: profiles.length, claude: claudeProfiles.length, codex: codexProfiles.length },
        platform: process.platform, node: process.version,
        ...(updateInfo && { latestVersion: updateInfo.latestVersion, updateAvailable: updateInfo.updateAvailable }),
      }, null, 2) + '\n');
      return;
    }

    console.log(chalk.bold('\n🍭 sweech\n'));
    console.log(chalk.cyan('  Version:'), packageJson.version);
    if (updateInfo?.updateAvailable) {
      console.log(chalk.yellow('  Update: '), `${version} → ${updateInfo.latestVersion} — run \`sweech update\``);
    }
    console.log(chalk.cyan('  Node:'), process.version);
    console.log(chalk.cyan('  Platform:'), process.platform);
    console.log(chalk.cyan('  Config:'), configDir);
    console.log(chalk.cyan('  Wrappers:'), binDir);
    console.log(chalk.cyan('  Profiles:'), `${profiles.length} total (${claudeProfiles.length} Claude, ${codexProfiles.length} Codex)`);
    if (cacheAge) console.log(chalk.cyan('  Cache:'), `updated ${cacheAge}`);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Backup failed:'), msg);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Backup failed:'), msg);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Restore failed:'), msg);
      process.exit(1);
    }
  });

// Stats command
program
  .command('stats [command-name]')
  .description('Show usage statistics for providers')
  .option('--json', 'Output as JSON')
  .option('--sort <field>', 'Sort by: uses (default), recent, name', 'uses')
  .action((commandName: string | undefined, opts: { json?: boolean; sort: string }) => {
    const tracker = new UsageTracker();
    const stats = tracker.getStats(commandName);

    if (stats.length === 0) {
      if (opts.json) { process.stdout.write(JSON.stringify({ stats: [] }) + '\n'); return; }
      console.log(chalk.yellow('\n📊 No usage data yet. Start using your providers!\n'));
      return;
    }

    // Sort
    const sorted = [...stats].sort((a, b) => {
      if (opts.sort === 'recent') return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
      if (opts.sort === 'name') return a.commandName.localeCompare(b.commandName);
      return b.totalUses - a.totalUses; // default: uses
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify({ stats: sorted }, null, 2) + '\n');
      return;
    }

    console.log(chalk.bold('\n📊 Usage Statistics:\n'));

    const timeAgo = (iso: string): string => {
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    };

    // Find max for bar rendering
    const maxUses = Math.max(...sorted.map(s => s.totalUses));

    sorted.forEach(stat => {
      const firstUsed = new Date(stat.firstUsed);
      const daysSinceFirst = Math.max(1, Math.floor(
        (Date.now() - firstUsed.getTime()) / (1000 * 60 * 60 * 24)
      ));
      const avgPerDay = (stat.totalUses / daysSinceFirst).toFixed(1);
      const barWidth = 20;
      const filled = Math.round((stat.totalUses / maxUses) * barWidth);
      const bar = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(barWidth - filled));

      console.log(chalk.cyan('▸'), chalk.bold(stat.commandName));
      console.log(`  ${bar} ${chalk.white(stat.totalUses)} launches`);
      console.log(chalk.gray(`  Last: ${timeAgo(stat.lastUsed)}  ·  First: ${firstUsed.toLocaleDateString()}  ·  ${avgPerDay}/day`));
      console.log();
    });
  });

// Compare command — side-by-side profile comparison
program
  .command('compare <a> <b>')
  .description('Compare two profiles side-by-side (usage, plan, score)')
  .action(async (a: string, b: string) => {
    try {
      const config = new ConfigManager();
      const profiles = config.getProfiles();
      const aliasManager = new AliasManager();

      // Resolve aliases
      const nameA = aliasManager.resolveAlias(a);
      const nameB = aliasManager.resolveAlias(b);

      // Build account refs for the two profiles
      const accountList = getKnownAccounts(profiles);
      const refA = accountList.find(p => p.commandName === nameA || p.name === nameA);
      const refB = accountList.find(p => p.commandName === nameB || p.name === nameB);

      if (!refA) {
        console.error(chalk.red(`Profile '${a}' not found`));
        console.log(chalk.dim('Available: ' + accountList.map(p => p.name).join(', ')));
        process.exit(1);
      }
      if (!refB) {
        console.error(chalk.red(`Profile '${b}' not found`));
        console.log(chalk.dim('Available: ' + accountList.map(p => p.name).join(', ')));
        process.exit(1);
      }

      // Fetch live usage for both
      const [infoA, infoB] = await Promise.all([
        getAccountInfo([refA]).then(r => r[0]),
        getAccountInfo([refB]).then(r => r[0]),
      ]);

      // Smart score helper (same as usage command)
      const smartScore = (acct: typeof infoA): number => {
        if (acct.needsReauth) return -2;
        if (acct.live?.status === 'limit_reached') return -1;
        const remaining7d = 1 - (acct.live?.utilization7d ?? 0);
        const reset7dAt = acct.live?.reset7dAt;
        if (!reset7dAt) return remaining7d / 7;
        const hoursLeft = Math.max(0.5, (reset7dAt - Date.now() / 1000) / 3600);
        const daysLeft = hoursLeft / 24;
        const baseScore = remaining7d / daysLeft;
        if (hoursLeft < 72 && remaining7d > 0) return 100 + baseScore;
        return baseScore;
      };

      // Time-ago helper
      const timeAgo = (iso: string | undefined): string => {
        if (!iso) return 'n/a';
        const diff = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
      };

      // Status string
      const statusStr = (acct: typeof infoA): string => {
        if (acct.needsReauth) return chalk.red('reauth needed');
        if (acct.live?.status === 'limit_reached') return chalk.red('limit reached');
        if (acct.live?.status === 'warning') return chalk.yellow('warning');
        return chalk.green('ok');
      };

      // Column widths
      const colW = 24;
      const padVal = (s: string) => s.padEnd(colW);

      console.log(chalk.bold(`\n  sweech compare · ${nameA} vs ${nameB}\n`));

      // Header
      console.log(`${''.padEnd(18)}${chalk.bold(padVal(nameA))}${chalk.bold(nameB)}`);

      // Plan
      const planA = infoA.meta.plan || 'unknown';
      const planB = infoB.meta.plan || 'unknown';
      console.log(`  ${'Plan:'.padEnd(16)}${padVal(planA)}${planB}`);

      // Status
      console.log(`  ${'Status:'.padEnd(16)}${padVal(statusStr(infoA))}${statusStr(infoB)}`);

      // 5h usage bars
      const barW = 14;
      const u5hA = infoA.live?.utilization5h ?? 0;
      const u5hB = infoB.live?.utilization5h ?? 0;
      const bar5hA = asciiBar({ label: '', value: u5hA, max: 1, width: barW, color: barColor(u5hA) });
      const bar5hB = asciiBar({ label: '', value: u5hB, max: 1, width: barW, color: barColor(u5hB) });
      console.log(`  ${'5h:'.padEnd(7)}${bar5hA.padEnd(colW)}${bar5hB}`);

      // 7d usage bars
      const u7dA = infoA.live?.utilization7d ?? 0;
      const u7dB = infoB.live?.utilization7d ?? 0;
      const bar7dA = asciiBar({ label: '', value: u7dA, max: 1, width: barW, color: barColor(u7dA) });
      const bar7dB = asciiBar({ label: '', value: u7dB, max: 1, width: barW, color: barColor(u7dB) });
      console.log(`  ${'Week:'.padEnd(7)}${bar7dA.padEnd(colW)}${bar7dB}`);

      // Score
      const scoreA = smartScore(infoA).toFixed(2);
      const scoreB = smartScore(infoB).toFixed(2);
      console.log(`  ${'Score:'.padEnd(16)}${padVal(scoreA)}${scoreB}`);

      // Last active
      const lastA = timeAgo(infoA.lastActive);
      const lastB = timeAgo(infoB.lastActive);
      console.log(`  ${'Last:'.padEnd(16)}${padVal(lastA)}${lastB}`);

      // Total messages
      const msgsA = String(infoA.totalMessages);
      const msgsB = String(infoB.totalMessages);
      console.log(`  ${'Messages:'.padEnd(16)}${padVal(msgsA)}${msgsB}`);

      console.log();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
      process.exit(1);
    }
  });

// Show command
program
  .command('show <command-name>')
  .description('Show detailed information about a provider')
  .action(async (commandName: string) => {
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
      const timeAgo = (iso: string): string => {
        const diff = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
      };
      console.log();
      console.log(chalk.bold('Usage:'));
      console.log(chalk.gray('  Total launches:'), stat.totalUses);
      console.log(chalk.gray('  Last used:'), timeAgo(stat.lastUsed));
    }

    // Show live rate limits if available
    const { getAccountInfo, getKnownAccounts } = require('./subscriptions');
    const accountList = getKnownAccounts(profiles);
    const acctRef = accountList.find((a: any) => a.commandName === profile.commandName);
    if (acctRef) {
      try {
        const [acctInfo] = await getAccountInfo([acctRef]);
        if (acctInfo?.live) {
          const { asciiBar } = require('./charts');
          const barColor = (r: number) => r <= 0.5 ? chalk.green : r <= 0.8 ? chalk.yellow : chalk.red;
          console.log();
          console.log(chalk.bold('Live rate limits:'));
          if (acctInfo.live.utilization5h !== undefined) {
            console.log('  ' + asciiBar({ label: '  5h', value: acctInfo.live.utilization5h, max: 1, width: 25, color: barColor(acctInfo.live.utilization5h) }));
          }
          if (acctInfo.live.utilization7d !== undefined) {
            console.log('  ' + asciiBar({ label: 'week', value: acctInfo.live.utilization7d, max: 1, width: 25, color: barColor(acctInfo.live.utilization7d) }));
          }
          if (acctInfo.live.status) {
            const statusColor = acctInfo.live.status === 'allowed' ? chalk.green : acctInfo.live.status === 'limit_reached' ? chalk.red : chalk.yellow;
            console.log(chalk.gray('  Status:'), statusColor(acctInfo.live.status));
          }
        }
      } catch {}
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

// Use command — launch a profile's CLI directly
program
  .command('use <command-name>')
  .description('Launch a profile CLI with its config directory')
  .allowUnknownOption(true)
  .action((commandName: string, _opts: any, cmd: any) => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();
    const aliasManager = new AliasManager();

    const resolvedName = aliasManager.resolveAlias(commandName);
    const profile = profiles.find(p => p.commandName === resolvedName);
    const cliConfig = profile ? getCLI(profile.cliType) : getCLI(resolvedName);

    if (!profile && !cliConfig) {
      console.error(chalk.red(`Profile '${commandName}' not found`));
      process.exit(1);
    }
    const cli = cliConfig!; // safe: guarded above
    const profileDir = profile
      ? config.getProfileDir(profile.commandName)
      : path.join(require('os').homedir(), `.${cli.name}`);

    // Passthrough args (everything after the profile name)
    const passthroughArgs = cmd.args.slice(1);

    // Set config dir env var and exec the CLI
    const env = { ...process.env, [cli.configDirEnvVar]: profileDir };
    // Strip nesting vars per AGENTS.md
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    try {
      const { execFileSync } = require('child_process');
      execFileSync(cli.command, passthroughArgs, { env, stdio: 'inherit' });
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error) {
        process.exit((error as { status: number }).status ?? 1);
      }
      process.exit(1);
    }
  });

// Auth command — re-authenticate a profile
program
  .command('auth <command-name>')
  .description('Re-authenticate a profile (trigger OAuth flow)')
  .action(async (commandName: string) => {
    const config = new ConfigManager();
    const profiles = config.getProfiles();
    const aliasManager = new AliasManager();

    const resolvedName = aliasManager.resolveAlias(commandName);
    const profile = profiles.find(p => p.commandName === resolvedName);

    if (!profile) {
      console.error(chalk.red(`Profile '${commandName}' not found`));
      process.exit(1);
    }

    const cli = getCLI(profile.cliType);
    if (!cli) {
      console.error(chalk.red(`CLI type '${profile.cliType}' not supported`));
      process.exit(1);
    }

    console.log(chalk.bold(`\nRe-authenticating ${resolvedName}...\n`));

    try {
      const { getOAuthToken, oauthTokenToEnv } = require('./oauth');
      const token = await getOAuthToken(profile.cliType, profile.provider);
      const envVars = oauthTokenToEnv(token, profile.cliType);

      // Update profile settings.json with new auth token (create if missing)
      const profileDir = config.getProfileDir(resolvedName);
      fs.mkdirSync(profileDir, { recursive: true });
      const settingsPath = path.join(profileDir, 'settings.json');
      const settings = fs.existsSync(settingsPath)
        ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        : { env: {} };
      if (!settings.env) settings.env = {};
      Object.assign(settings.env, envVars);
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

      console.log(chalk.green(`\n  ✓ Successfully re-authenticated ${resolvedName}\n`));
      if (token.expiresAt) {
        console.log(chalk.gray(`  Token expires: ${new Date(token.expiresAt).toLocaleString()}\n`));
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Authentication failed:'), msg);
      process.exit(1);
    }
  });

// Promo command — manage active promotions (e.g. "2x Tokens Live")
program
  .command('promo [action]')
  .description('Manage provider promotions (list, add, remove, clear)')
  .option('--cli <type>', 'CLI type: claude, codex, or * for all', '*')
  .option('--label <text>', 'Promotion label, e.g. "2x Tokens"')
  .option('--multiplier <n>', 'Usage multiplier, e.g. 2', parseFloat)
  .option('--expires <date>', 'Expiry date (ISO format or relative like "in 7d")')
  .action((action: string | undefined, opts: { cli: string; label?: string; multiplier?: number; expires?: string }) => {
    const promoFile = path.join(require('os').homedir(), '.sweech', 'promotions.json');
    const load = (): any[] => { try { return JSON.parse(fs.readFileSync(promoFile, 'utf-8')); } catch { return []; } };
    const save = (p: any[]) => { fs.mkdirSync(path.dirname(promoFile), { recursive: true }); fs.writeFileSync(promoFile, JSON.stringify(p, null, 2)); };

    if (!action || action === 'list') {
      const promos = load();
      if (promos.length === 0) {
        console.log(chalk.dim('\n  No active promotions.\n'));
        console.log(chalk.gray('  Add one: sweech promo add --cli claude --label "2x Tokens" --multiplier 2 --expires "2026-04-01"\n'));
        return;
      }
      console.log(chalk.bold('\n  Active Promotions:\n'));
      for (const p of promos) {
        const expired = p.expiresAt && new Date(p.expiresAt).getTime() < Date.now();
        const expiry = p.expiresAt ? (expired ? chalk.red('expired') : chalk.green(`until ${p.expiresAt}`)) : chalk.dim('no expiry');
        const icon = expired ? chalk.red('✗') : chalk.green('✓');
        console.log(`  ${icon} ${chalk.bold(p.label)} · ${p.cliType} · ${p.multiplier || '?'}x · ${expiry}`);
      }
      console.log();
      return;
    }

    if (action === 'add') {
      if (!opts.label) { console.error(chalk.red('--label required')); process.exit(1); }
      const promos = load();
      const entry: any = { cliType: opts.cli, label: opts.label };
      if (opts.multiplier) entry.multiplier = opts.multiplier;
      if (opts.expires) {
        // Support relative dates like "in 7d"
        const match = opts.expires.match(/^in\s+(\d+)([dhm])$/);
        if (match) {
          const n = parseInt(match[1]);
          const unit = match[2] === 'd' ? 86400000 : match[2] === 'h' ? 3600000 : 60000;
          entry.expiresAt = new Date(Date.now() + n * unit).toISOString();
        } else {
          entry.expiresAt = opts.expires;
        }
      }
      promos.push(entry);
      save(promos);
      console.log(chalk.green(`\n  ✓ Added promotion: ${entry.label} (${entry.cliType})\n`));
      return;
    }

    if (action === 'clear') {
      save([]);
      console.log(chalk.green('\n  ✓ All promotions cleared.\n'));
      return;
    }

    if (action === 'remove') {
      const promos = load();
      const idx = promos.findIndex((p: any) => p.label === opts.label || p.cliType === opts.cli);
      if (idx === -1) { console.error(chalk.red('Promotion not found')); process.exit(1); }
      const removed = promos.splice(idx, 1)[0];
      save(promos);
      console.log(chalk.green(`\n  ✓ Removed: ${removed.label}\n`));
      return;
    }

    console.error(chalk.red(`Unknown action: ${action}. Use: list, add, remove, clear`));
    process.exit(1);
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
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red('Error:'), msg);
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
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red('Error:'), msg);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
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
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Backup failed:'), msg);
      process.exit(1);
    }
  });

// ── sweech serve ───────────────────────────────────────────────────────────────
program
  .command('serve')
  .description('Start the fed integration server (exposes /healthz, /fed/info, /fed/runs, /fed/widget)')
  .option('--port <number>', 'Port to listen on', '7854')
  .option('--install', 'Install as launchd daemon (macOS)')
  .option('--uninstall', 'Uninstall launchd daemon (macOS)')
  .action(async (opts: { port: string; install?: boolean; uninstall?: boolean }) => {
    if (opts.install) {
      const { installLaunchd } = await import('./launchd');
      await installLaunchd(parseInt(opts.port, 10));
      return;
    }
    if (opts.uninstall) {
      const { uninstallLaunchd } = await import('./launchd');
      await uninstallLaunchd();
      return;
    }
    const port = parseInt(opts.port, 10);
    try {
      await startSweechFedServerWithShutdown(port);
      console.log(chalk.green(`sweech federation server running on :${port}`));
      console.log(chalk.dim(`  /healthz    — health check`));
      console.log(chalk.dim(`  /fed/info   — metadata`));
      console.log(chalk.dim(`  /fed/runs   — account list`));
      console.log(chalk.dim(`  /fed/widget — account-usage widget`));
      console.log(chalk.dim(`  SIGTERM/SIGINT for graceful shutdown`));
      // Keep alive
      await new Promise(() => {});
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Failed to start server:'), msg);
      process.exit(1);
    }
  });

// ── sweech usage ───────────────────────────────────────────────────────────────
const usageCmd = program
  .command('usage')
  .description('Show account usage windows (5h rolling + 7d) for Claude and Codex accounts')
  .option('--json', 'Output machine-readable JSON')
  .option('--refresh', 'Force-refresh live usage instead of using cached data')
  .option('--sort <mode>', 'Sort order: smart (default), status, manual', 'smart')
  .option('--no-group', 'Show all accounts in one list instead of grouped by provider')
  .option('-m, --models', 'Show per-model bucket breakdowns (e.g. Sonnet only, Codex Spark)')
  .option('--history', 'Show 24h sparkline history per account')
  .action(async (opts: { json?: boolean; refresh?: boolean; sort: string; group: boolean; models?: boolean; history?: boolean }) => {
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

    // Record history snapshot (non-blocking, max once per hour)
    try { appendSnapshot(accounts); } catch {}

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        summary: summarizeAccountsForTelemetry(accounts),
        accounts,
      }, null, 2) + '\n');
      return;
    }

    // --history: show 24h sparkline per account and exit
    if (opts.history) {
      console.log(chalk.bold('\n  sweech · usage history (24h)\n'));
      const sparklines = allAccountSparklines(24, 'u7d');
      if (sparklines.size === 0) {
        console.log(chalk.dim('  No history data yet. Usage snapshots are recorded hourly.\n'));
        return;
      }
      const maxNameLen = Math.max(...Array.from(sparklines.keys()).map(n => n.length));
      for (const [name, spark] of sparklines) {
        console.log(`  ${chalk.bold(name.padEnd(maxNameLen))}  ${spark}  ${chalk.dim('(24h trend)')}`);
      }
      console.log();
      return;
    }

    console.log(chalk.bold('\n  sweech · usage\n'));

    // Scoring helpers
    const smartScore = (a: typeof accounts[0]): number => {
      if (a.needsReauth) return -2;
      if (a.live?.status === 'limit_reached') return -1;
      const remaining7d = 1 - (a.live?.utilization7d ?? 0);
      const reset7dAt = a.live?.reset7dAt;
      if (!reset7dAt) return remaining7d / 7;
      const hoursLeft = Math.max(0.5, (reset7dAt - Date.now() / 1000) / 3600);
      const daysLeft = hoursLeft / 24;
      const baseScore = remaining7d / daysLeft;
      // Tier boost: profiles with expiring capacity (resets < 3d, > 10% left) always
      // rank above non-expiring ones — "don't waste what resets soonest"
      if (hoursLeft < 72 && remaining7d > 0) return 100 + baseScore;
      return baseScore;
    };

    const statusRank = (a: typeof accounts[0]): number => {
      if (a.needsReauth) return 4;
      if (a.live?.status === 'limit_reached') return 3;
      if (a.live?.status === 'warning') return 2;
      if (a.live?.status === 'allowed') return 0;
      return 1;
    };

    const applySort = (list: typeof accounts): typeof accounts => {
      if (opts.sort === 'status') return [...list].sort((a, b) => statusRank(a) - statusRank(b));
      if (opts.sort === 'manual') return list;
      return [...list].sort((a, b) => smartScore(b) - smartScore(a)); // smart
    };

    // Group or flat
    let groups: Array<{ name: string; items: typeof accounts }>;
    if (opts.group !== false) {
      const map = new Map<string, typeof accounts>();
      for (const a of accounts) {
        const g = a.cliType ?? 'claude';
        if (!map.has(g)) map.set(g, []);
        map.get(g)!.push(a);
      }
      const groupOrder = ['claude', ...Array.from(map.keys()).filter(k => k !== 'claude').sort()];
      groups = groupOrder.filter(g => map.has(g)).map(g => ({ name: g, items: applySort(map.get(g)!) }));
    } else {
      groups = [{ name: '', items: applySort(accounts) }];
    }

    const sortLabel = opts.sort === 'status' ? ' · by status' : opts.sort === 'manual' ? ' · manual' : ' · smart';
    console.log(chalk.dim(`  sort${sortLabel}${opts.group !== false ? '' : ' · ungrouped'}\n`));

    for (const { name, items: sorted } of groups) {
      if (name) console.log(chalk.bold.dim(`  ── ${name} ──`));
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        const planStr = a.meta.plan ? chalk.cyan(` [${a.meta.plan}]`) : '';
        const emailStr = a.emailAddress ? chalk.dim(` · ${a.emailAddress}`) : '';
        const recommendedStr = i === 0 && smartScore(a) >= 0
          ? chalk.cyan(' ⚡ use first')
          : '';
        // Token status indicator for OAuth accounts
        let tokenStr = '';
        if (a.tokenStatus === 'refreshed') {
          tokenStr = chalk.green(' 🔑 token refreshed');
        } else if (a.tokenStatus === 'expired') {
          tokenStr = chalk.red(' 🔑 token expired');
        } else if (a.tokenStatus === 'valid' && a.tokenExpiresAt) {
          const hoursLeft = Math.max(0, (a.tokenExpiresAt - Date.now()) / 3600000);
          if (hoursLeft < 1) {
            tokenStr = chalk.yellow(` 🔑 expires in ${Math.round(hoursLeft * 60)}m`);
          } else if (hoursLeft < 24) {
            tokenStr = chalk.dim(` 🔑 expires in ${Math.round(hoursLeft)}h`);
          }
        } else if (a.tokenStatus === 'no_token' && a.cliType === 'claude') {
          tokenStr = chalk.dim(' 🔑 no token');
        }
        console.log(`  ${chalk.bold(a.name)}${planStr}${emailStr}${recommendedStr}${tokenStr}`);

        // 5h window
        const cap5hStr = a.minutesUntilFirstCapacity !== undefined
          ? chalk.yellow(` · capacity in ${a.minutesUntilFirstCapacity}m`)
          : '';
        const live5hStr = a.live?.utilization5h !== undefined
          ? ` (${Math.round(a.live.utilization5h * 100)}% used)`
          : '';
        const reset5hStr = a.live?.reset5hAt !== undefined
          ? (() => {
              const mins = Math.round((a.live!.reset5hAt! - Date.now() / 1000) / 60);
              if (mins < 30) return chalk.red(` · resets in ${mins}m`);
              if (mins < 120) return chalk.yellow(` · resets in ${mins}m`);
              const h = Math.floor(mins / 60), m = mins % 60;
              return chalk.cyan(` · resets in ${h}h ${m}m`);
            })()
          : '';
        console.log(`    5h:   ${chalk.white(String(a.messages5h))} messages${live5hStr}${reset5hStr}${cap5hStr}`);

        // week window + expiry alert
        const reset7dAt = a.live?.reset7dAt;
        const weeklyResetStr = reset7dAt !== undefined
          ? (() => {
              const h = Math.round((reset7dAt - Date.now() / 1000) / 3600);
              const d = Math.floor(h / 24), hr = h % 24;
              const label = d > 0 ? `${d}d ${hr}h` : `${h}h`;
              return chalk.cyan(` · resets in ${label}`);
            })()
          : a.hoursUntilWeeklyReset !== undefined
            ? chalk.cyan(` · resets in ${a.hoursUntilWeeklyReset}h`)
            : chalk.dim(' · set plan to compute');
        const live7dStr = a.live?.utilization7d !== undefined
          ? ` (${Math.round(a.live.utilization7d * 100)}% used)`
          : '';
        // Expiry alert: >10% remaining and resetting in <72h
        let expiryAlertStr = '';
        if (reset7dAt) {
          const hoursLeft = (reset7dAt - Date.now() / 1000) / 3600;
          const remaining = 1 - (a.live?.utilization7d ?? 0);
          if (remaining > 0 && hoursLeft > 0 && hoursLeft < 72) {
            const pct = Math.round(remaining * 100);
            const label = hoursLeft < 24 ? `${Math.round(hoursLeft)}h` : `${Math.floor(hoursLeft / 24)}d`;
            expiryAlertStr = chalk.cyan(` ⚡ ${pct}% expiring in ${label}`);
          }
        }
        console.log(`    week: ${chalk.white(String(a.messages7d))} messages${live7dStr}${weeklyResetStr}${expiryAlertStr}`);

        // Per-model bucket breakdowns (--models flag)
        if (opts.models && a.live?.buckets && a.live.buckets.length > 1) {
          const sorted = [...a.live.buckets].sort((x, y) =>
            (x.label === 'All models' ? 0 : 1) - (y.label === 'All models' ? 0 : 1)
          );
          for (const bucket of sorted) {
            if (bucket.label === 'All models') continue; // already shown above
            console.log(chalk.dim(`    ── ${bucket.label} ──`));
            if (bucket.session) {
              const u = Math.round(bucket.session.utilization * 100);
              const r = bucket.session.resetsAt
                ? (() => { const m = Math.round((bucket.session.resetsAt - Date.now() / 1000) / 60); return m < 60 ? chalk.cyan(` · resets in ${m}m`) : chalk.cyan(` · resets in ${Math.floor(m / 60)}h ${m % 60}m`); })()
                : '';
              console.log(`      5h:   ${u}% used${r}`);
            }
            if (bucket.weekly) {
              const u = Math.round(bucket.weekly.utilization * 100);
              const r = bucket.weekly.resetsAt
                ? (() => { const h = Math.round((bucket.weekly.resetsAt - Date.now() / 1000) / 3600); const d = Math.floor(h / 24); return d > 0 ? chalk.cyan(` · resets in ${d}d ${h % 24}h`) : chalk.cyan(` · resets in ${h}h`); })()
                : '';
              console.log(`      week: ${u}% used${r}`);
            }
          }
        }

        const lastStr = a.lastActive
          ? chalk.dim(`  last: ${new Date(a.lastActive).toLocaleString()}`)
          : '';
        if (lastStr) console.log(`   ${lastStr}`);
        console.log();
      }
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

// ── sweech plugins ────────────────────────────────────────────────────────────
const pluginsCmd = program
  .command('plugins')
  .description('Manage sweech plugins');

pluginsCmd
  .command('list')
  .alias('ls')
  .description('List installed plugins')
  .action(() => {
    const plugins = listPlugins();
    if (plugins.length === 0) {
      console.log(chalk.dim('\nNo plugins installed. Use `sweech plugins install <package>` to add one.\n'));
      return;
    }
    console.log(chalk.bold('\n  sweech · plugins\n'));
    for (const p of plugins) {
      const status = p.enabled ? chalk.green('enabled') : chalk.red('disabled');
      console.log(`  ${chalk.bold(p.name)} ${chalk.dim(`v${p.version}`)} [${status}]`);
    }
    console.log();
  });

pluginsCmd
  .command('install <package>')
  .description('Install an npm package as a sweech plugin')
  .action(async (npmPackage: string) => {
    try {
      console.log(chalk.dim(`Installing plugin "${npmPackage}"...`));
      await installPlugin(npmPackage);
      console.log(chalk.green(`\n✓ Plugin "${npmPackage}" installed and enabled.\n`));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
      process.exit(1);
    }
  });

pluginsCmd
  .command('uninstall <name>')
  .description('Uninstall a sweech plugin')
  .action(async (name: string) => {
    try {
      await uninstallPlugin(name);
      console.log(chalk.green(`\n✓ Plugin "${name}" uninstalled.\n`));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
      process.exit(1);
    }
  });

// ── sweech templates ──────────────────────────────────────────────────────────
const templatesCmd = program
  .command('templates')
  .description('Manage profile templates');

templatesCmd
  .command('list')
  .alias('ls')
  .description('List available profile templates')
  .action(() => {
    const all = getAllTemplates();
    const custom = loadCustomTemplates();
    const customNames = new Set(custom.map(t => t.name));

    console.log(chalk.bold('\n  sweech · templates\n'));

    console.log(chalk.cyan('  Built-in:\n'));
    for (const t of BUILT_IN_TEMPLATES) {
      const overridden = customNames.has(t.name) ? chalk.yellow(' [overridden]') : '';
      const modelStr = t.model ? chalk.dim(` model=${t.model}`) : '';
      console.log(`    ${chalk.bold(t.name)}  ${chalk.dim(t.description)}${modelStr}${overridden}`);
    }

    if (custom.length > 0) {
      console.log(chalk.cyan('\n  Custom:\n'));
      for (const t of custom) {
        const modelStr = t.model ? chalk.dim(` model=${t.model}`) : '';
        console.log(`    ${chalk.bold(t.name)}  ${chalk.dim(t.description)}${modelStr}`);
      }
    }

    console.log(chalk.dim(`\n  Use: sweech add --template <name>\n`));
  });

templatesCmd
  .command('save <name>')
  .description('Save a custom template')
  .requiredOption('--cli <type>', 'CLI type (claude or codex)')
  .requiredOption('--provider <name>', 'Provider name')
  .option('--description <text>', 'Template description', '')
  .option('--model <model>', 'Default model')
  .option('--base-url <url>', 'Base URL for API')
  .option('--tags <tags>', 'Comma-separated tags')
  .action((name: string, opts: { cli: string; provider: string; description: string; model?: string; baseUrl?: string; tags?: string }) => {
    const tpl: ProfileTemplate = {
      name,
      description: opts.description || `Custom template: ${name}`,
      cliType: opts.cli,
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      tags: opts.tags ? opts.tags.split(',').map(t => t.trim()) : [name],
    };
    saveCustomTemplate(tpl);
    console.log(chalk.green(`\n✓ Template "${name}" saved.\n`));
  });

templatesCmd
  .command('remove <name>')
  .description('Remove a custom template')
  .action((name: string) => {
    const custom = loadCustomTemplates();
    if (!custom.find(t => t.name === name)) {
      console.error(chalk.red(`Custom template '${name}' not found.`));
      const builtIn = BUILT_IN_TEMPLATES.find(t => t.name === name);
      if (builtIn) {
        console.log(chalk.dim('Note: Built-in templates cannot be removed.'));
      }
      process.exit(1);
    }
    deleteCustomTemplate(name);
    console.log(chalk.green(`\n✓ Template "${name}" removed.\n`));
  });

// Reset command - Uninstall sweetch
program
  .command('reset')
  .description('Uninstall sweetch (removes all sweetch-managed profiles)')
  .action(async () => {
    try {
      await runReset();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Error:'), msg);
      process.exit(1);
    }
  });

// Update command - Self-update sweech
program
  .command('update')
  .description('Update sweech to the latest version from GitHub')
  .option('--check', 'Only check for updates, do not install')
  .action(async (opts: { check?: boolean }) => {
    try {
      console.log(chalk.bold('\n🔄 Checking for updates...\n'));

      const result = await checkForUpdate(version);
      if (!result) {
        console.log(chalk.yellow('  Could not reach the update server. Check your network connection.\n'));
        if (!opts.check) process.exit(1);
        return;
      }

      console.log(chalk.cyan('  Current:'), result.current);
      console.log(chalk.cyan('  Latest: '), result.latest);

      if (!result.updateAvailable) {
        console.log(chalk.green('\n  ✓ You are on the latest version.\n'));
        return;
      }

      console.log(chalk.yellow(`\n  Update available: ${result.current} → ${result.latest}\n`));

      // Fetch and display changelog
      const changelog = await fetchChangelog(result.current, result.latest);
      if (changelog) {
        console.log(chalk.bold('  What\'s new:\n'));
        for (const line of changelog.split('\n')) {
          console.log(chalk.dim(`    ${line}`));
        }
        console.log();
      }

      if (opts.check) return;

      console.log(chalk.bold('  Installing update...\n'));
      const { execSync: execSyncUpdate } = require('child_process');
      execSyncUpdate('npm install -g github:vykeai/sweech', { stdio: 'inherit' });
      console.log(chalk.green('\n✓ sweech updated to ' + result.latest + '\n'));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Update failed:'), msg);
      process.exit(1);
    }
  });

// resync intentionally removed — it caused data loss by replacing real files with symlinks

// ── sweech sessions ─────────────────────────────────────────────────────────────
program
  .command('sessions')
  .description('List active CLI sessions across all accounts')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    const { detectActiveSessions } = await import('./sessions');
    const sessions = detectActiveSessions();
    if (opts.json) {
      process.stdout.write(JSON.stringify({ sessions }, null, 2) + '\n');
      return;
    }
    if (sessions.length === 0) {
      console.log(chalk.dim('\n  No active CLI sessions.\n'));
      return;
    }
    console.log(chalk.bold(`\n  ${sessions.length} active session(s)\n`));
    for (const s of sessions) {
      console.log(`  ${chalk.white(s.commandName || s.cliType)} ${chalk.dim(`pid=${s.pid}`)} ${chalk.dim(s.command)}`);
    }
    console.log();
  });

// ── sweech sync ─────────────────────────────────────────────────────────────────
const syncCmd = program
  .command('sync')
  .description('Git-based config sync');

syncCmd
  .command('init')
  .description('Initialize config sync with optional git remote')
  .argument('[remote]', 'Git remote URL')
  .action(async (remote?: string) => {
    const { initSync } = await import('./sync');
    await initSync(remote);
    console.log(chalk.green('✓ Sync initialized'));
  });

syncCmd
  .command('push')
  .description('Push config changes to remote')
  .action(async () => {
    const { pushSync } = await import('./sync');
    await pushSync();
    console.log(chalk.green('✓ Config pushed'));
  });

syncCmd
  .command('pull')
  .description('Pull config changes from remote')
  .action(async () => {
    const { pullSync } = await import('./sync');
    await pullSync();
    console.log(chalk.green('✓ Config pulled'));
  });

syncCmd
  .command('status')
  .description('Show sync status')
  .action(async () => {
    const { getSyncStatus } = await import('./sync');
    const status = getSyncStatus();
    if (!status.initialized) {
      console.log(chalk.dim('\n  Sync not initialized. Run: sweech sync init [remote]\n'));
      return;
    }
    console.log(chalk.bold('\n  sync status'));
    if (status.remote) console.log(`  remote: ${chalk.cyan(status.remote)}`);
    if (status.lastSync) console.log(`  last sync: ${chalk.dim(status.lastSync)}`);
    console.log();
  });

// ── sweech audit ────────────────────────────────────────────────────────────────
program
  .command('audit')
  .description('View the audit log')
  .option('--limit <n>', 'Number of entries to show', '20')
  .option('--action <type>', 'Filter by action type')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts: { limit: string; action?: string; json?: boolean }) => {
    const { readAuditLog } = await import('./auditLog');
    const entries = readAuditLog({ limit: parseInt(opts.limit), action: opts.action });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ entries }, null, 2) + '\n');
      return;
    }
    if (entries.length === 0) {
      console.log(chalk.dim('\n  No audit entries.\n'));
      return;
    }
    console.log(chalk.bold(`\n  audit log (${entries.length} entries)\n`));
    for (const e of entries) {
      const acct = e.account ? chalk.cyan(` [${e.account}]`) : '';
      console.log(`  ${chalk.dim(e.timestamp)} ${chalk.white(e.action)}${acct}`);
    }
    console.log();
  });

// ── sweech team ─────────────────────────────────────────────────────────────────
const teamCmd = program
  .command('team')
  .description('Team management');

teamCmd
  .command('join <invite-code>')
  .description('Join a team using an invite code')
  .option('--hub <url>', 'Team hub URL (omit for local-only mode)')
  .action(async (inviteCode: string, opts: { hub?: string }) => {
    if (opts.hub) {
      const { joinTeam } = await import('./team');
      await joinTeam(inviteCode, opts.hub);
    } else {
      const { joinTeamLocal } = await import('./team');
      joinTeamLocal(inviteCode);
    }
    console.log(chalk.green('✓ Joined team'));
  });

teamCmd
  .command('leave')
  .description('Leave the current team')
  .option('--hub', 'Notify hub before leaving')
  .action(async (opts: { hub?: boolean }) => {
    if (opts.hub) {
      const { leaveTeam } = await import('./team');
      await leaveTeam();
    } else {
      const { leaveTeamLocal } = await import('./team');
      leaveTeamLocal();
    }
    console.log(chalk.green('✓ Left team'));
  });

teamCmd
  .command('invite <email>')
  .description('Invite a member to the team')
  .option('--hub', 'Send invite via hub (requires admin)')
  .action(async (email: string, opts: { hub?: boolean }) => {
    if (opts.hub) {
      const { inviteMember } = await import('./team');
      await inviteMember(email);
    } else {
      const { addLocalInvite } = await import('./team');
      addLocalInvite(email);
    }
    console.log(chalk.green(`✓ Invite sent to ${email}`));
  });

teamCmd
  .command('members')
  .description('List team members')
  .option('--hub', 'Fetch members from hub')
  .action(async (opts: { hub?: boolean }) => {
    if (opts.hub) {
      const { listMembers } = await import('./team');
      const members = await listMembers();
      console.log(chalk.bold(`\n  team members (${members.length})\n`));
      for (const m of members) {
        console.log(`  ${chalk.white(m.name)} ${chalk.dim(`[${m.role}]`)} ${chalk.dim(`${m.accounts} accounts`)} ${chalk.dim(`last seen: ${m.lastSeen}`)}`);
      }
    } else {
      const { getLocalMembers, loadTeamConfig } = await import('./team');
      const members = getLocalMembers();
      const config = loadTeamConfig();
      console.log(chalk.bold(`\n  team members (${members.length})\n`));
      for (const m of members) {
        console.log(`  ${chalk.white(m.name)} ${chalk.dim(`[${m.role}]`)} ${chalk.dim(m.email)} ${chalk.dim(`joined: ${m.joinedAt}`)}`);
      }
      if (config && config.pendingInvites.length > 0) {
        console.log(chalk.bold(`\n  pending invites (${config.pendingInvites.length})\n`));
        for (const email of config.pendingInvites) {
          console.log(`  ${chalk.yellow('○')} ${email}`);
        }
      }
    }
    console.log();
  });

// ── sweech webhooks ─────────────────────────────────────────────────────────────
const webhooksCmd = program
  .command('webhooks')
  .description('Manage webhook notifications');

webhooksCmd
  .command('list')
  .description('Show configured webhooks and recent deliveries')
  .action(async () => {
    const { loadWebhookConfig, getDeliveryLog } = await import('./webhooks');
    const hooks = loadWebhookConfig();
    if (hooks.length === 0) {
      console.log(chalk.dim('\n  No webhooks configured. Add them to ~/.sweech/webhooks.json\n'));
      console.log(chalk.dim('  Example config:'));
      console.log(chalk.dim('  ['));
      console.log(chalk.dim('    {'));
      console.log(chalk.dim('      "url": "https://example.com/webhook",'));
      console.log(chalk.dim('      "events": ["*"],'));
      console.log(chalk.dim('      "name": "my-hook"'));
      console.log(chalk.dim('    }'));
      console.log(chalk.dim('  ]\n'));
      return;
    }
    console.log(chalk.bold(`\n  ${hooks.length} webhook(s)\n`));
    for (const h of hooks) {
      const name = h.name ? chalk.white(h.name) : chalk.dim('unnamed');
      const evts = h.events.includes('*') ? chalk.yellow('*') : chalk.dim(h.events.join(', '));
      const secret = h.secret ? chalk.green(' [signed]') : '';
      console.log(`  ${name} → ${chalk.cyan(h.url)} [${evts}]${secret}`);
    }

    const log = getDeliveryLog();
    if (log.length > 0) {
      console.log(chalk.bold(`\n  recent deliveries (${log.length})\n`));
      for (const d of log.slice(0, 10)) {
        const status = d.status === 'success' ? chalk.green('ok') : chalk.red('fail');
        const attempts = d.attempts > 1 ? chalk.dim(` (${d.attempts} attempts)`) : '';
        console.log(`  ${status} ${chalk.dim(d.event)} → ${chalk.dim(d.url)}${attempts} ${chalk.dim(d.timestamp)}`);
      }
    }
    console.log();
  });

webhooksCmd
  .command('test [url]')
  .description('Send a test webhook to verify delivery')
  .action(async (url?: string) => {
    const { loadWebhookConfig, deliverWebhook } = await import('./webhooks');
    const hooks = loadWebhookConfig();

    const targets = url
      ? [{ url, events: ['*'], name: 'test' } as import('./webhooks').WebhookConfig]
      : hooks;

    if (targets.length === 0) {
      console.log(chalk.dim('\n  No webhooks to test. Configure ~/.sweech/webhooks.json or pass a URL.\n'));
      return;
    }

    console.log(chalk.bold(`\n  Testing ${targets.length} webhook(s)...\n`));
    for (const hook of targets) {
      const name = hook.name || hook.url;
      const result = await deliverWebhook(hook, 'test', { message: 'sweech webhook test' }, 1);
      if (result.success) {
        console.log(`  ${chalk.green('ok')} ${name} (HTTP ${result.statusCode})`);
      } else {
        console.log(`  ${chalk.red('fail')} ${name}: ${result.error}`);
      }
    }
    console.log();
  });

// Backwards compat: `sweech webhooks` with no subcommand shows the list
webhooksCmd.action(async () => {
  await webhooksCmd.commands.find(c => c.name() === 'list')?.parseAsync([], { from: 'user' });
});

// ── sweech peers ────────────────────────────────────────────────────────────────
const peersCmd = program
  .command('peers')
  .description('Manage federation peers');

peersCmd
  .command('list')
  .description('List configured federation peers with connectivity status')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts: { json?: boolean }) => {
    const { loadFedPeers, fetchPeerHealth, updatePeerLastSeen } = await import('./fedClient');
    const peers = loadFedPeers();
    if (peers.length === 0) {
      if (opts.json) {
        process.stdout.write(JSON.stringify({ peers: [] }, null, 2) + '\n');
      } else {
        console.log(chalk.dim('\n  No peers configured. Run: sweech peers add <name> <host> <port>\n'));
      }
      return;
    }

    const results = await Promise.all(peers.map(async p => {
      const health = await fetchPeerHealth(p);
      if (health?.ok) updatePeerLastSeen(p.name);
      return { peer: p, health };
    }));

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        peers: results.map(r => ({
          name: r.peer.name,
          host: r.peer.host,
          port: r.peer.port,
          addedAt: r.peer.addedAt,
          lastSeen: r.peer.lastSeen,
          status: r.health?.ok ? 'ok' : 'down',
          latencyMs: r.health?.latencyMs ?? null,
        })),
      }, null, 2) + '\n');
      return;
    }

    console.log(chalk.bold(`\n  ${peers.length} peer(s)\n`));
    for (const { peer: p, health } of results) {
      const status = health?.ok ? chalk.green('ok') : chalk.red('down');
      const latency = health?.latencyMs ? chalk.dim(`${health.latencyMs}ms`) : '';
      const addedStr = p.addedAt ? chalk.dim(` added ${new Date(p.addedAt).toLocaleDateString()}`) : '';
      const lastStr = p.lastSeen ? chalk.dim(` last seen ${new Date(p.lastSeen).toLocaleString()}`) : '';
      console.log(`  ${chalk.white(p.name)} ${chalk.dim(`${p.host}:${p.port}`)} ${status} ${latency}${addedStr}${lastStr}`);
    }
    console.log();
  });

peersCmd
  .command('add <name> <host> <port>')
  .description('Add a federation peer')
  .option('--secret <secret>', 'Shared secret for auth')
  .action(async (name: string, host: string, port: string, opts: { secret?: string }) => {
    const { addPeer } = await import('./fedClient');
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      console.error(chalk.red('Error: Port must be a number between 1 and 65535'));
      process.exit(1);
    }
    addPeer({ name, host, port: portNum, secret: opts.secret, addedAt: new Date().toISOString() });
    console.log(chalk.green(`✓ Peer '${name}' added (${host}:${portNum})`));
  });

peersCmd
  .command('remove <name>')
  .description('Remove a federation peer')
  .action(async (name: string) => {
    const { loadFedPeers, removePeer } = await import('./fedClient');
    const peers = loadFedPeers();
    if (!peers.find(p => p.name === name)) {
      console.error(chalk.red(`Peer '${name}' not found`));
      process.exit(1);
    }
    removePeer(name);
    console.log(chalk.green(`✓ Peer '${name}' removed`));
  });

// ── sweech export / import ───────────────────────────────────────────────────
program
  .command('export <name>')
  .description('Export a profile as a shareable JSON template (sensitive fields stripped)')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action(async (name: string, opts: { output?: string }) => {
    try {
      const config = new ConfigManager();
      const profiles = config.getProfiles();
      const aliasManager = new AliasManager();

      const resolvedName = aliasManager.resolveAlias(name);
      const profile = profiles.find(p => p.commandName === resolvedName);

      if (!profile) {
        console.error(chalk.red(`Profile '${name}' not found`));
        process.exit(1);
      }

      // Build template — strip sensitive fields (apiKey, oauth, accessToken, refreshToken)
      const template: Record<string, unknown> = {
        commandName: profile.commandName,
        cliType: profile.cliType,
        provider: profile.provider,
      };
      if (profile.model) template.model = profile.model;
      if (profile.smallFastModel) template.smallFastModel = profile.smallFastModel;
      if (profile.baseUrl) template.baseUrl = profile.baseUrl;
      if (profile.sharedWith) template.sharedWith = profile.sharedWith;

      const json = JSON.stringify(template, null, 2) + '\n';

      if (opts.output) {
        fs.writeFileSync(opts.output, json);
        console.error(chalk.green(`✓ Exported '${resolvedName}' to ${opts.output}`));
      } else {
        process.stdout.write(json);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Export failed:'), msg);
      process.exit(1);
    }
  });

program
  .command('import <file>')
  .description('Import a profile from a JSON template')
  .action(async (file: string) => {
    try {
      if (!fs.existsSync(file)) {
        console.error(chalk.red(`File not found: ${file}`));
        process.exit(1);
      }

      const raw = fs.readFileSync(file, 'utf-8');
      let template: Record<string, unknown>;
      try {
        template = JSON.parse(raw);
      } catch {
        console.error(chalk.red('Invalid JSON in template file'));
        process.exit(1);
      }

      // Validate required fields
      const required = ['commandName', 'cliType', 'provider'];
      const missing = required.filter(f => !template[f]);
      if (missing.length > 0) {
        console.error(chalk.red(`Missing required fields: ${missing.join(', ')}`));
        process.exit(1);
      }

      const commandName = template.commandName as string;
      const cliType = template.cliType as string;
      const providerName = template.provider as string;

      // Validate command name format
      if (!/^[a-z0-9-]+$/.test(commandName)) {
        console.error(chalk.red(`Invalid command name: '${commandName}' (must be lowercase alphanumeric with dashes)`));
        process.exit(1);
      }

      // Check CLI type
      const cli = getCLI(cliType);
      if (!cli) {
        console.error(chalk.red(`Unknown CLI type: '${cliType}' (expected 'claude' or 'codex')`));
        process.exit(1);
      }

      // Check provider
      const provider = getProvider(providerName);
      if (!provider) {
        console.error(chalk.red(`Unknown provider: '${providerName}'`));
        console.log(chalk.dim('Available: ' + getProviderList().map(p => p.name).join(', ')));
        process.exit(1);
      }

      const config = new ConfigManager();
      const profiles = config.getProfiles();

      if (profiles.some(p => p.commandName === commandName)) {
        console.error(chalk.red(`Profile '${commandName}' already exists`));
        process.exit(1);
      }

      // Prompt for API key if TTY
      console.log(chalk.bold(`\nImporting profile: ${commandName}`));
      console.log(chalk.dim(`  Provider: ${provider.displayName}`));
      console.log(chalk.dim(`  CLI: ${cli.displayName}`));
      if (template.model) console.log(chalk.dim(`  Model: ${template.model}`));
      console.log();

      let apiKey: string | undefined;
      if (process.stdout.isTTY) {
        const inquirer = await import('inquirer');
        const { key } = await inquirer.default.prompt([{
          type: 'password',
          name: 'key',
          message: `API key for ${provider.displayName} (leave blank to skip):`,
          mask: '*',
        }]);
        apiKey = key || undefined;
      } else {
        console.error(chalk.yellow('Non-interactive mode: skipping API key prompt. Run sweech auth to configure later.'));
      }

      // Create profile
      const profile: import('./config').ProfileConfig = {
        name: commandName,
        commandName,
        cliType,
        provider: providerName,
        apiKey,
        baseUrl: (template.baseUrl as string) || provider.baseUrl,
        model: (template.model as string) || provider.defaultModel,
        smallFastModel: (template.smallFastModel as string) || provider.smallFastModel,
        sharedWith: template.sharedWith as string | undefined,
        createdAt: new Date().toISOString(),
      };

      config.addProfile(profile);
      config.createProfileConfig(commandName, provider, apiKey, cliType);
      config.createWrapperScript(commandName, cli);

      if (profile.sharedWith) {
        config.setupSharedDirs(commandName, profile.sharedWith, cliType);
      }

      console.log(chalk.green(`\n✓ Imported profile '${commandName}'`));
      if (!apiKey) {
        console.log(chalk.yellow('  No API key set — run:'), chalk.bold(`sweech auth ${commandName}`));
      }
      console.log(chalk.dim(`  Run: ${commandName}\n`));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Import failed:'), msg);
      process.exit(1);
    }
  });

// ── sweech dashboard ────────────────────────────────────────────────────────────
program
  .command('dashboard')
  .description('Open a local usage analytics dashboard in the browser')
  .option('--port <number>', 'Port to listen on (default: random available)')
  .option('--no-open', 'Do not auto-open the browser')
  .action(async (opts: { port?: string; open?: boolean }) => {
    try {
      const { startDashboard } = await import('./dashboard');
      const portNum = opts.port ? parseInt(opts.port, 10) : undefined;
      const { port } = await startDashboard({ port: portNum, open: opts.open });
      console.log(chalk.green(`\n  sweech dashboard running at http://127.0.0.1:${port}\n`));
      console.log(chalk.dim('  Press Ctrl+C to stop\n'));
      // Keep alive
      await new Promise(() => {});
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Dashboard failed:'), msg);
      process.exit(1);
    }
  });

// ── Startup update check (non-blocking) ────────────────────────────────────────
// Fire-and-forget: if the check completes before parse finishes, print a notice.
// Skip for --help, --version, --complete, and the update command itself.
const skipUpdateCheck = process.argv.some(a =>
  a === '--help' || a === '-h' || a === '--version' || a === '-v' || a === 'update' || a === '--complete'
);
if (!skipUpdateCheck && process.argv.length > 2) {
  checkForUpdate(version).then(result => {
    if (result && result.updateAvailable) {
      process.stderr.write(
        chalk.dim(`[sweech] Update available: ${result.current} → ${result.latest} — run \`sweech update\`\n`)
      );
    }
  }).catch(() => { /* silently ignore */ });
}

// Default action: interactive launcher when no command given
if (process.argv.length <= 2) {
  // First run: no profiles configured → run onboarding instead of empty launcher
  if (isFirstRun()) {
    runInit().catch(err => {
      console.error(chalk.red('Error:'), err.message);
      process.exit(1);
    });
  } else {
    runLauncher().catch(err => {
      console.error(chalk.red('Error:'), err.message);
      process.exit(1);
    });
  }
} else {
  program.parse();
}
