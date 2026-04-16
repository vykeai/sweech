#!/usr/bin/env node
"use strict";
/**
 * 🍭 Sweetch CLI - Switch between Claude accounts and AI providers
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("./config");
const providers_1 = require("./providers");
const interactive_1 = require("./interactive");
const clis_1 = require("./clis");
const backup_1 = require("./backup");
const usage_1 = require("./usage");
const usage_2 = require("./usage");
const aliases_1 = require("./aliases");
const completion_1 = require("./completion");
const chatBackup_1 = require("./chatBackup");
const reset_1 = require("./reset");
const utilityCommands_1 = require("./utilityCommands");
const shareCommands_1 = require("./shareCommands");
const reset_2 = require("./reset");
const init_1 = require("./init");
const profileCreation_1 = require("./profileCreation");
const profileManagement_1 = require("./profileManagement");
const launcher_1 = require("./launcher");
const tmux_1 = require("./tmux");
const launchCommand_1 = require("./launchCommand");
const subscriptions_1 = require("./subscriptions");
const usageHistory_1 = require("./usageHistory");
const fedServer_1 = require("./fedServer");
const updateChecker_1 = require("./updateChecker");
const charts_1 = require("./charts");
const plugins_1 = require("./plugins");
const templates_1 = require("./templates");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
// Read version from package.json
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;
// ── Dynamic completion handler (must run before Commander) ────────────────────
const completeIdx = process.argv.indexOf('--complete');
if (completeIdx !== -1) {
    const line = process.argv[completeIdx + 1] || '';
    const completions = (0, completion_1.handleComplete)(line);
    if (completions.length > 0) {
        process.stdout.write(completions.join('\n') + '\n');
    }
    process.exit(0);
}
const program = new commander_1.Command();
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
        await (0, init_1.runInit)();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error during initialization:', msg));
        process.exit(1);
    }
});
// Add provider command
program
    .command('add')
    .description('Add a new provider with interactive setup')
    .option('-t, --template <name>', 'Use a profile template for quick setup')
    .action(async (opts) => {
    try {
        const config = new config_1.ConfigManager();
        const existingProfiles = config.getProfiles();
        // If --template is provided, use template to pre-fill answers
        if (opts.template) {
            const tpl = (0, templates_1.findTemplate)(opts.template);
            if (!tpl) {
                console.error(chalk_1.default.red(`Template '${opts.template}' not found`));
                console.log(chalk_1.default.dim('Available templates: ' + (0, templates_1.getAllTemplates)().map(t => t.name).join(', ')));
                process.exit(1);
            }
            console.log(chalk_1.default.cyan('Using template:'), chalk_1.default.bold(tpl.name), chalk_1.default.dim(`— ${tpl.description}`));
            // Pre-fill answers from template
            const commandName = tpl.name;
            const provider = (0, providers_1.getProvider)(tpl.provider);
            if (!provider) {
                console.error(chalk_1.default.red(`Template provider '${tpl.provider}' not found`));
                process.exit(1);
            }
            const cli = (0, clis_1.getCLI)(tpl.cliType);
            if (!cli) {
                console.error(chalk_1.default.red(`Template CLI type '${tpl.cliType}' not found`));
                process.exit(1);
            }
            // Apply template overrides to provider
            const templateProvider = { ...provider };
            if (tpl.model)
                templateProvider.defaultModel = tpl.model;
            if (tpl.baseUrl)
                templateProvider.baseUrl = tpl.baseUrl;
            // Determine auth method: no auth for local providers, OAuth for official, API key otherwise
            const isOfficialOAuth = (tpl.cliType === 'claude' && tpl.provider === 'anthropic')
                || (tpl.cliType === 'codex' && tpl.provider === 'openai');
            const authMethod = templateProvider.authOptional ? 'none'
                : isOfficialOAuth ? 'oauth'
                    : 'api-key';
            const answers = {
                cliType: tpl.cliType,
                provider: tpl.provider,
                commandName,
                authMethod,
            };
            await (0, profileCreation_1.createProfile)(answers, templateProvider, cli, config);
            const binDir = config.getBinDir();
            const pathIncludesBin = (process.env.PATH || '').split(':').includes(binDir);
            if (!pathIncludesBin) {
                console.log(chalk_1.default.blue('\nℹ'), chalk_1.default.gray(`Add to your PATH:`));
                console.log(chalk_1.default.gray(`  export PATH="${binDir}:$PATH"`));
                console.log(chalk_1.default.gray(`  Add this to your ~/.zshrc or ~/.bashrc`));
            }
            console.log(chalk_1.default.green('\nNow run:'), chalk_1.default.bold(commandName));
            return;
        }
        const answers = await (0, interactive_1.interactiveAddProvider)(existingProfiles);
        // Use custom provider config if provided, otherwise get from registry
        const provider = answers.customProviderConfig || (0, providers_1.getProvider)(answers.provider);
        if (!provider) {
            console.error(chalk_1.default.red(`Provider '${answers.provider}' not found`));
            process.exit(1);
        }
        // Get CLI config from answers
        const cli = (0, clis_1.getCLI)(answers.cliType);
        if (!cli) {
            console.error(chalk_1.default.red(`CLI '${answers.cliType}' not found`));
            process.exit(1);
        }
        // Create profile with OAuth or API key
        await (0, profileCreation_1.createProfile)(answers, provider, cli, config);
        const binDir = config.getBinDir();
        const pathIncludesBin = (process.env.PATH || '').split(':').includes(binDir);
        if (!pathIncludesBin) {
            console.log(chalk_1.default.blue('\nℹ'), chalk_1.default.gray(`Add to your PATH:`));
            console.log(chalk_1.default.gray(`  export PATH="${binDir}:$PATH"`));
            console.log(chalk_1.default.gray(`  Add this to your ~/.zshrc or ~/.bashrc`));
        }
        console.log(chalk_1.default.green('\nNow run:'), chalk_1.default.bold(answers.commandName));
        console.log();
        console.log(chalk_1.default.gray('Tip: You can add multiple accounts for the same provider!'));
        console.log(chalk_1.default.gray('   Example: claude-mini, minimax-work, minimax-personal, etc.'));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// List providers command
program
    .command('list')
    .alias('ls')
    .description('List all configured providers')
    .action(async () => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const { execFileSync } = require('child_process');
    const os = require('os');
    const fs = require('fs');
    // Helper: format a timestamp as a relative string (e.g. "2h ago", "3d ago")
    const relativeTime = (isoStr) => {
        if (!isoStr)
            return chalk_1.default.dim('never');
        const diffMs = Date.now() - new Date(isoStr).getTime();
        if (diffMs < 0)
            return chalk_1.default.dim('just now');
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1)
            return chalk_1.default.dim('just now');
        if (mins < 60)
            return chalk_1.default.dim(`${mins}m ago`);
        const hours = Math.floor(mins / 60);
        if (hours < 24)
            return chalk_1.default.dim(`${hours}h ago`);
        const days = Math.floor(hours / 24);
        if (days < 30)
            return chalk_1.default.dim(`${days}d ago`);
        const months = Math.floor(days / 30);
        return chalk_1.default.dim(`${months}mo ago`);
    };
    // Helper: colored status dot based on live status
    const statusDot = (live, needsReauth) => {
        if (needsReauth)
            return chalk_1.default.red('●');
        if (!live?.status)
            return chalk_1.default.gray('●');
        switch (live.status) {
            case 'allowed': return chalk_1.default.green('●');
            case 'allowed_warning':
            case 'warning': return chalk_1.default.yellow('●');
            case 'rejected':
            case 'limit_reached': return chalk_1.default.red('●');
            default: return chalk_1.default.gray('●');
        }
    };
    // Collect all account refs for getAccountInfo
    const accountRefs = [];
    // Default CLIs
    const installedDefaults = [];
    for (const cli of Object.values(clis_1.SUPPORTED_CLIS)) {
        let installed = false;
        try {
            execFileSync('which', [cli.command], { stdio: 'ignore' });
            installed = true;
        }
        catch { }
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
    const accountInfoMap = new Map();
    try {
        const infos = await (0, subscriptions_1.getAccountInfo)(accountRefs);
        for (const info of infos) {
            accountInfoMap.set(info.commandName, info);
        }
    }
    catch { /* proceed without live data */ }
    console.log(chalk_1.default.bold('\n  sweech · profiles\n'));
    // Show detected default CLIs
    for (const cli of installedDefaults) {
        const configDir = path.join(os.homedir(), `.${cli.name}`);
        const hasConfig = fs.existsSync(configDir);
        const sharingProfiles = profiles.filter(p => p.sharedWith === cli.command);
        const reverseTag = sharingProfiles.length > 0
            ? chalk_1.default.dim(` (shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`)
            : '';
        const info = accountInfoMap.get(cli.name);
        const dot = statusDot(info?.live, info?.needsReauth);
        const planStr = info?.meta?.plan ? chalk_1.default.cyan(` [${info.meta.plan}]`) : '';
        const lastStr = relativeTime(info?.lastActive);
        const configTag = hasConfig ? '' : chalk_1.default.yellow(' (not configured)');
        console.log(`  ${dot} ${chalk_1.default.bold(cli.command)}${chalk_1.default.gray(' [default]')}${planStr}${configTag}  ${lastStr}${reverseTag}`);
    }
    // Show sweech-managed profiles
    for (const profile of profiles) {
        const provider = (0, providers_1.getProvider)(profile.provider);
        const cli = (0, clis_1.getCLI)(profile.cliType || 'claude');
        const info = accountInfoMap.get(profile.commandName);
        const dot = statusDot(info?.live, info?.needsReauth);
        const sharedTag = profile.sharedWith ? chalk_1.default.magenta(` [shared -> ${profile.sharedWith}]`) : '';
        const sharingProfiles = profiles.filter(p => p.sharedWith === profile.commandName);
        const reverseTag = sharingProfiles.length > 0
            ? chalk_1.default.dim(` (shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`)
            : '';
        const providerStr = chalk_1.default.dim(` ${provider?.displayName || profile.provider}`);
        const modelStr = profile.model ? chalk_1.default.dim(` · ${profile.model}`) : '';
        const planStr = info?.meta?.plan ? chalk_1.default.cyan(` [${info.meta.plan}]`) : '';
        const lastStr = relativeTime(info?.lastActive);
        console.log(`  ${dot} ${chalk_1.default.bold(profile.commandName)}${planStr}${providerStr}${modelStr}${sharedTag}  ${lastStr}${reverseTag}`);
    }
    if (installedDefaults.length === 0 && profiles.length === 0) {
        console.log(chalk_1.default.gray('  No profiles configured. Run'), chalk_1.default.bold('sweech add'), chalk_1.default.gray('to create one.'));
    }
    console.log();
});
// Remove provider command
program
    .command('remove <command-name>')
    .alias('rm')
    .description('Remove a configured provider')
    .action(async (commandName) => {
    try {
        const config = new config_1.ConfigManager();
        const profiles = config.getProfiles();
        const profile = profiles.find(p => p.commandName === commandName);
        if (!profile) {
            console.error(chalk_1.default.red(`Provider '${commandName}' not found`));
            process.exit(1);
        }
        const profileDir = config.getProfileDir(commandName);
        // PROTECTION: Never allow removal of default CLI directories
        if ((0, reset_1.isDefaultCLIDirectory)(profileDir)) {
            console.error(chalk_1.default.red(`\n✗ Cannot remove default CLI directory: ${profileDir}`));
            console.log(chalk_1.default.yellow(`  This is a system default and should not be managed by sweetch.`));
            console.log(chalk_1.default.gray(`  To backup: sweetch backup-chats ${commandName}\n`));
            process.exit(1);
        }
        // Warn if other profiles share data with this profile
        const dependents = profiles.filter(p => p.sharedWith === commandName);
        if (dependents.length > 0) {
            const depNames = dependents.map(p => p.commandName).join(', ');
            console.log(chalk_1.default.yellow(`\n⚠️  The following profiles are sharing data with this one: ${depNames}`));
            console.log(chalk_1.default.yellow('   Their symlinks will break.'));
            const { confirmDependents } = await Promise.resolve().then(() => __importStar(require('inquirer'))).then(m => m.default.prompt([
                {
                    type: 'confirm',
                    name: 'confirmDependents',
                    message: 'Remove anyway?',
                    default: false
                }
            ]));
            if (!confirmDependents) {
                console.log(chalk_1.default.yellow('\nCancelled\n'));
                return;
            }
        }
        // Check for chat history and offer backup
        const shouldProceed = await (0, chatBackup_1.confirmChatBackupBeforeRemoval)(commandName, profileDir);
        if (!shouldProceed) {
            console.log(chalk_1.default.yellow('\nCancelled\n'));
            return;
        }
        const confirmed = await (0, interactive_1.confirmRemoveProvider)(commandName);
        if (!confirmed) {
            console.log(chalk_1.default.yellow('Cancelled'));
            return;
        }
        (0, profileManagement_1.removeManagedProfile)(commandName, { forceDependents: true }, config);
        console.log(chalk_1.default.green(`\n✓ Removed '${commandName}' successfully\n`));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Info command
program
    .command('info')
    .description('Show sweech configuration info')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const os = require('os');
    const configDir = config.getBinDir().replace('/bin', '');
    const binDir = config.getBinDir();
    const cacheFile = path.join(os.homedir(), '.sweech', 'rate-limit-cache.json');
    let cacheAge = null;
    try {
        const stat = fs.statSync(cacheFile);
        const mins = Math.floor((Date.now() - stat.mtimeMs) / 60000);
        cacheAge = mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
    }
    catch { }
    const claudeProfiles = profiles.filter(p => p.cliType !== 'codex' && !(0, providers_1.isExternalProvider)(p.provider));
    const codexProfiles = profiles.filter(p => p.cliType === 'codex' && !(0, providers_1.isExternalProvider)(p.provider));
    const externalProfiles = profiles.filter(p => (0, providers_1.isExternalProvider)(p.provider));
    // Include update info (uses cached check — fast, no network if fresh)
    const updateResult = await (0, updateChecker_1.checkForUpdate)(version).catch(() => null);
    const updateInfo = updateResult ? {
        latestVersion: updateResult.latest,
        updateAvailable: updateResult.updateAvailable,
    } : null;
    if (opts.json) {
        process.stdout.write(JSON.stringify({
            version: packageJson.version,
            configDir, binDir, cacheAge,
            profiles: { total: profiles.length, claude: claudeProfiles.length, codex: codexProfiles.length, external: externalProfiles.length },
            platform: process.platform, node: process.version,
            ...(updateInfo && { latestVersion: updateInfo.latestVersion, updateAvailable: updateInfo.updateAvailable }),
        }, null, 2) + '\n');
        return;
    }
    console.log(chalk_1.default.bold('\n🍭 sweech\n'));
    console.log(chalk_1.default.cyan('  Version:'), packageJson.version);
    if (updateInfo?.updateAvailable) {
        console.log(chalk_1.default.yellow('  Update: '), `${version} → ${updateInfo.latestVersion} — run \`sweech update\``);
    }
    console.log(chalk_1.default.cyan('  Node:'), process.version);
    console.log(chalk_1.default.cyan('  Platform:'), process.platform);
    console.log(chalk_1.default.cyan('  Config:'), configDir);
    console.log(chalk_1.default.cyan('  Wrappers:'), binDir);
    const profileParts = [`${claudeProfiles.length} Claude`, `${codexProfiles.length} Codex`];
    if (externalProfiles.length > 0)
        profileParts.push(`${externalProfiles.length} External`);
    console.log(chalk_1.default.cyan('  Profiles:'), `${profiles.length} total (${profileParts.join(', ')})`);
    if (cacheAge)
        console.log(chalk_1.default.cyan('  Cache:'), `updated ${cacheAge}`);
    console.log();
});
// Update wrappers command (hidden, for maintenance)
program
    .command('update-wrappers')
    .description('Regenerate wrapper scripts for all profiles')
    .action(() => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    console.log(chalk_1.default.bold('\n🔄 Updating wrapper scripts...\n'));
    profiles.forEach(profile => {
        const cli = (0, clis_1.getCLI)(profile.cliType);
        if (cli) {
            config.createWrapperScript(profile.commandName, cli);
            console.log(chalk_1.default.green('✓'), profile.commandName);
        }
    });
    console.log(chalk_1.default.green('\n✓ All wrapper scripts updated\n'));
});
// Backup command
program
    .command('backup')
    .description('Create a password-protected backup of all sweetch configurations')
    .option('-o, --output <file>', 'Output file path (default: sweetch-backup-YYYYMMDD.zip)')
    .action(async (options) => {
    try {
        await (0, backup_1.backupSweetch)(options.output);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Backup failed:'), msg);
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
        await (0, backup_1.backupClaude)(options.output);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Backup failed:'), msg);
        process.exit(1);
    }
});
// Restore command
program
    .command('restore <backup-file>')
    .description('Restore sweetch configuration from a backup')
    .action(async (backupFile) => {
    try {
        await (0, backup_1.restoreSweetch)(backupFile);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Restore failed:'), msg);
        process.exit(1);
    }
});
// Stats command
program
    .command('stats [command-name]')
    .description('Show usage statistics for providers')
    .option('--json', 'Output as JSON')
    .option('--sort <field>', 'Sort by: uses (default), recent, name', 'uses')
    .action((commandName, opts) => {
    const tracker = new usage_1.UsageTracker();
    const stats = tracker.getStats(commandName);
    if (stats.length === 0) {
        if (opts.json) {
            process.stdout.write(JSON.stringify({ stats: [] }) + '\n');
            return;
        }
        console.log(chalk_1.default.yellow('\n📊 No usage data yet. Start using your providers!\n'));
        return;
    }
    // Sort
    const sorted = [...stats].sort((a, b) => {
        if (opts.sort === 'recent')
            return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
        if (opts.sort === 'name')
            return a.commandName.localeCompare(b.commandName);
        return b.totalUses - a.totalUses; // default: uses
    });
    if (opts.json) {
        process.stdout.write(JSON.stringify({ stats: sorted }, null, 2) + '\n');
        return;
    }
    console.log(chalk_1.default.bold('\n📊 Usage Statistics:\n'));
    const timeAgo = (iso) => {
        const diff = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1)
            return 'just now';
        if (mins < 60)
            return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24)
            return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };
    // Find max for bar rendering
    const maxUses = Math.max(...sorted.map(s => s.totalUses));
    sorted.forEach(stat => {
        const firstUsed = new Date(stat.firstUsed);
        const daysSinceFirst = Math.max(1, Math.floor((Date.now() - firstUsed.getTime()) / (1000 * 60 * 60 * 24)));
        const avgPerDay = (stat.totalUses / daysSinceFirst).toFixed(1);
        const barWidth = 20;
        const filled = Math.round((stat.totalUses / maxUses) * barWidth);
        const bar = chalk_1.default.cyan('█'.repeat(filled)) + chalk_1.default.dim('░'.repeat(barWidth - filled));
        console.log(chalk_1.default.cyan('▸'), chalk_1.default.bold(stat.commandName));
        console.log(`  ${bar} ${chalk_1.default.white(stat.totalUses)} launches`);
        console.log(chalk_1.default.gray(`  Last: ${timeAgo(stat.lastUsed)}  ·  First: ${firstUsed.toLocaleDateString()}  ·  ${avgPerDay}/day`));
        console.log();
    });
});
// Compare command — side-by-side profile comparison
program
    .command('compare <a> <b>')
    .description('Compare two profiles side-by-side (usage, plan, score)')
    .action(async (a, b) => {
    try {
        const config = new config_1.ConfigManager();
        const profiles = config.getProfiles();
        const aliasManager = new aliases_1.AliasManager();
        // Resolve aliases
        const nameA = aliasManager.resolveAlias(a);
        const nameB = aliasManager.resolveAlias(b);
        // Build account refs for the two profiles
        const accountList = (0, subscriptions_1.getKnownAccounts)(profiles);
        const refA = accountList.find(p => p.commandName === nameA || p.name === nameA);
        const refB = accountList.find(p => p.commandName === nameB || p.name === nameB);
        if (!refA) {
            console.error(chalk_1.default.red(`Profile '${a}' not found`));
            console.log(chalk_1.default.dim('Available: ' + accountList.map(p => p.name).join(', ')));
            process.exit(1);
        }
        if (!refB) {
            console.error(chalk_1.default.red(`Profile '${b}' not found`));
            console.log(chalk_1.default.dim('Available: ' + accountList.map(p => p.name).join(', ')));
            process.exit(1);
        }
        // Fetch live usage for both
        const [infoA, infoB] = await Promise.all([
            (0, subscriptions_1.getAccountInfo)([refA]).then(r => r[0]),
            (0, subscriptions_1.getAccountInfo)([refB]).then(r => r[0]),
        ]);
        // Smart score helper (same as usage command)
        const smartScore = (acct) => {
            if (acct.needsReauth)
                return -2;
            if (acct.live?.status === 'limit_reached')
                return -1;
            const remaining7d = 1 - (acct.live?.utilization7d ?? 0);
            const reset7dAt = acct.live?.reset7dAt;
            if (!reset7dAt)
                return remaining7d / 7;
            const hoursLeft = Math.max(0.5, (reset7dAt - Date.now() / 1000) / 3600);
            const daysLeft = hoursLeft / 24;
            const baseScore = remaining7d / daysLeft;
            if (hoursLeft < 72 && remaining7d > 0)
                return 100 + baseScore;
            return baseScore;
        };
        // Time-ago helper
        const timeAgo = (iso) => {
            if (!iso)
                return 'n/a';
            const diff = Date.now() - new Date(iso).getTime();
            const mins = Math.floor(diff / 60000);
            if (mins < 1)
                return 'just now';
            if (mins < 60)
                return `${mins}m ago`;
            const hours = Math.floor(mins / 60);
            if (hours < 24)
                return `${hours}h ago`;
            const days = Math.floor(hours / 24);
            return `${days}d ago`;
        };
        // Status string
        const statusStr = (acct) => {
            if (acct.needsReauth)
                return chalk_1.default.red('reauth needed');
            if (acct.live?.status === 'limit_reached')
                return chalk_1.default.red('limit reached');
            if (acct.live?.status === 'warning')
                return chalk_1.default.yellow('warning');
            return chalk_1.default.green('ok');
        };
        // Column widths
        const colW = 24;
        const padVal = (s) => s.padEnd(colW);
        console.log(chalk_1.default.bold(`\n  sweech compare · ${nameA} vs ${nameB}\n`));
        // Header
        console.log(`${''.padEnd(18)}${chalk_1.default.bold(padVal(nameA))}${chalk_1.default.bold(nameB)}`);
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
        const bar5hA = (0, charts_1.asciiBar)({ label: '', value: u5hA, max: 1, width: barW, color: (0, charts_1.barColor)(u5hA) });
        const bar5hB = (0, charts_1.asciiBar)({ label: '', value: u5hB, max: 1, width: barW, color: (0, charts_1.barColor)(u5hB) });
        console.log(`  ${'5h:'.padEnd(7)}${bar5hA.padEnd(colW)}${bar5hB}`);
        // 7d usage bars
        const u7dA = infoA.live?.utilization7d ?? 0;
        const u7dB = infoB.live?.utilization7d ?? 0;
        const bar7dA = (0, charts_1.asciiBar)({ label: '', value: u7dA, max: 1, width: barW, color: (0, charts_1.barColor)(u7dA) });
        const bar7dB = (0, charts_1.asciiBar)({ label: '', value: u7dB, max: 1, width: barW, color: (0, charts_1.barColor)(u7dB) });
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
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Show command
program
    .command('show <command-name>')
    .description('Show detailed information about a provider')
    .action(async (commandName) => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const aliasManager = new aliases_1.AliasManager();
    const tracker = new usage_1.UsageTracker();
    // Resolve alias if needed
    const resolvedName = aliasManager.resolveAlias(commandName);
    const profile = profiles.find(p => p.commandName === resolvedName);
    if (!profile) {
        console.error(chalk_1.default.red(`Provider '${commandName}' not found`));
        process.exit(1);
    }
    const provider = (0, providers_1.getProvider)(profile.provider);
    const cli = (0, clis_1.getCLI)(profile.cliType);
    const stats = tracker.getStats(profile.commandName);
    const stat = stats.find(s => s.commandName === profile.commandName);
    console.log(chalk_1.default.bold(`\n🍭 ${profile.commandName}\n`));
    console.log(chalk_1.default.cyan('Provider:'), provider?.displayName || profile.provider);
    console.log(chalk_1.default.cyan('CLI:'), cli?.displayName || profile.cliType);
    console.log(chalk_1.default.cyan('Model:'), profile.model || 'default');
    if (profile.smallFastModel) {
        console.log(chalk_1.default.cyan('Fast model:'), profile.smallFastModel);
    }
    console.log(chalk_1.default.cyan('API endpoint:'), profile.baseUrl || 'default');
    console.log(chalk_1.default.cyan('Config dir:'), config.getProfileDir(profile.commandName));
    console.log(chalk_1.default.cyan('Created:'), new Date(profile.createdAt).toLocaleDateString());
    if (stat) {
        const timeAgo = (iso) => {
            const diff = Date.now() - new Date(iso).getTime();
            const mins = Math.floor(diff / 60000);
            if (mins < 60)
                return `${mins}m ago`;
            const hours = Math.floor(mins / 60);
            if (hours < 24)
                return `${hours}h ago`;
            return `${Math.floor(hours / 24)}d ago`;
        };
        console.log();
        console.log(chalk_1.default.bold('Usage:'));
        console.log(chalk_1.default.gray('  Total launches:'), stat.totalUses);
        console.log(chalk_1.default.gray('  Last used:'), timeAgo(stat.lastUsed));
    }
    // Show live rate limits if available
    const { getAccountInfo, getKnownAccounts } = require('./subscriptions');
    const accountList = getKnownAccounts(profiles);
    const acctRef = accountList.find((a) => a.commandName === profile.commandName);
    if (acctRef) {
        try {
            const [acctInfo] = await getAccountInfo([acctRef]);
            if (acctInfo?.live) {
                const { asciiBar } = require('./charts');
                const barColor = (r) => r <= 0.5 ? chalk_1.default.green : r <= 0.8 ? chalk_1.default.yellow : chalk_1.default.red;
                console.log();
                console.log(chalk_1.default.bold('Live rate limits:'));
                if (acctInfo.live.utilization5h !== undefined) {
                    console.log('  ' + asciiBar({ label: '  5h', value: acctInfo.live.utilization5h, max: 1, width: 25, color: barColor(acctInfo.live.utilization5h) }));
                }
                if (acctInfo.live.utilization7d !== undefined) {
                    console.log('  ' + asciiBar({ label: 'week', value: acctInfo.live.utilization7d, max: 1, width: 25, color: barColor(acctInfo.live.utilization7d) }));
                }
                if (acctInfo.live.status) {
                    const statusColor = acctInfo.live.status === 'allowed' ? chalk_1.default.green : acctInfo.live.status === 'limit_reached' ? chalk_1.default.red : chalk_1.default.yellow;
                    console.log(chalk_1.default.gray('  Status:'), statusColor(acctInfo.live.status));
                }
            }
        }
        catch { }
    }
    // Show aliases pointing to this command
    const aliases = aliasManager.getAliases();
    const pointingAliases = Object.entries(aliases)
        .filter(([_, cmd]) => cmd === profile.commandName)
        .map(([alias]) => alias);
    if (pointingAliases.length > 0) {
        console.log();
        console.log(chalk_1.default.bold('Aliases:'), pointingAliases.join(', '));
    }
    console.log();
});
// Use command — launch a profile's CLI directly
program
    .command('use <command-name>')
    .description('Launch a profile CLI with its config directory')
    .allowUnknownOption(true)
    .action((commandName, _opts, cmd) => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const aliasManager = new aliases_1.AliasManager();
    const resolvedName = aliasManager.resolveAlias(commandName);
    const profile = profiles.find(p => p.commandName === resolvedName);
    const cliConfig = profile ? (0, clis_1.getCLI)(profile.cliType) : (0, clis_1.getCLI)(resolvedName);
    if (!profile && !cliConfig) {
        console.error(chalk_1.default.red(`Profile '${commandName}' not found`));
        process.exit(1);
    }
    const cli = cliConfig; // safe: guarded above
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
    if ((0, tmux_1.isTmuxAvailable)()) {
        const status = (0, tmux_1.launchInTmux)({
            command: cli.command,
            args: passthroughArgs,
            configDirEnvVar: cli.configDirEnvVar,
            configDir: profileDir,
            profileName: profile?.commandName ?? cli.command,
        });
        process.exit(status);
    }
    try {
        const { execFileSync } = require('child_process');
        execFileSync(cli.command, passthroughArgs, { env, stdio: 'inherit' });
    }
    catch (error) {
        if (error && typeof error === 'object' && 'status' in error) {
            process.exit(error.status ?? 1);
        }
        process.exit(1);
    }
});
// Launch command — non-interactive launch with flags
program
    .command('launch <command-name>')
    .alias('run')
    .description('Launch a profile directly (no TUI). Flags: --yolo, --resume, --no-tmux')
    .option('-y, --yolo', 'Skip permission prompts (--dangerously-skip-permissions / equivalent)')
    .option('-r, --resume', 'Resume last session (--continue / equivalent)')
    .option('--no-tmux', 'Bypass tmux even if tmux is available')
    .allowUnknownOption(true)
    .action((commandName, opts, cmd) => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const aliasManager = new aliases_1.AliasManager();
    const resolvedName = aliasManager.resolveAlias(commandName);
    const profile = profiles.find(p => p.commandName === resolvedName);
    const cliConfig = profile ? (0, clis_1.getCLI)(profile.cliType) : (0, clis_1.getCLI)(resolvedName);
    if (!profile && !cliConfig) {
        console.error(chalk_1.default.red(`Profile '${commandName}' not found`));
        process.exit(1);
    }
    const cli = cliConfig;
    const profileDir = profile
        ? config.getProfileDir(profile.commandName)
        : path.join(require('os').homedir(), `.${cli.name}`);
    // Build arg list: sweech flags expand to CLI-native flags, rest pass through
    const passthroughExtras = cmd.args.slice(1).filter((a) => !launchCommand_1.SWEECH_LAUNCH_FLAGS.has(a));
    const launchArgs = (0, launchCommand_1.buildLaunchArgs)(opts, cli, passthroughExtras);
    const env = { ...process.env, [cli.configDirEnvVar]: profileDir };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    if ((0, launchCommand_1.shouldUseTmux)((0, tmux_1.isTmuxAvailable)(), opts)) {
        const status = (0, tmux_1.launchInTmux)({
            command: cli.command,
            args: launchArgs,
            configDirEnvVar: cli.configDirEnvVar,
            configDir: profileDir,
            profileName: profile?.commandName ?? cli.command,
            resumeArgs: (cli.resumeFlag || '--continue').split(' ').filter(Boolean),
            hasResume: !!opts.resume,
        });
        process.exit(status);
    }
    try {
        const { execFileSync } = require('child_process');
        execFileSync(cli.command, launchArgs, { env, stdio: 'inherit' });
    }
    catch (error) {
        if (error && typeof error === 'object' && 'status' in error) {
            process.exit(error.status ?? 1);
        }
        process.exit(1);
    }
});
// Auth command — re-authenticate a profile
program
    .command('auth <command-name>')
    .description('Re-authenticate a profile (trigger OAuth flow)')
    .action(async (commandName) => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const aliasManager = new aliases_1.AliasManager();
    const resolvedName = aliasManager.resolveAlias(commandName);
    const profile = profiles.find(p => p.commandName === resolvedName);
    if (!profile) {
        console.error(chalk_1.default.red(`Profile '${commandName}' not found`));
        process.exit(1);
    }
    const cli = (0, clis_1.getCLI)(profile.cliType);
    if (!cli) {
        console.error(chalk_1.default.red(`CLI type '${profile.cliType}' not supported`));
        process.exit(1);
    }
    console.log(chalk_1.default.bold(`\nRe-authenticating ${resolvedName}...\n`));
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
        if (!settings.env)
            settings.env = {};
        Object.assign(settings.env, envVars);
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log(chalk_1.default.green(`\n  ✓ Successfully re-authenticated ${resolvedName}\n`));
        if (token.expiresAt) {
            console.log(chalk_1.default.gray(`  Token expires: ${new Date(token.expiresAt).toLocaleString()}\n`));
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Authentication failed:'), msg);
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
    .action((action, opts) => {
    const promoFile = path.join(require('os').homedir(), '.sweech', 'promotions.json');
    const load = () => { try {
        return JSON.parse(fs.readFileSync(promoFile, 'utf-8'));
    }
    catch {
        return [];
    } };
    const save = (p) => { fs.mkdirSync(path.dirname(promoFile), { recursive: true }); fs.writeFileSync(promoFile, JSON.stringify(p, null, 2)); };
    if (!action || action === 'list') {
        const promos = load();
        if (promos.length === 0) {
            console.log(chalk_1.default.dim('\n  No active promotions.\n'));
            console.log(chalk_1.default.gray('  Add one: sweech promo add --cli claude --label "2x Tokens" --multiplier 2 --expires "2026-04-01"\n'));
            return;
        }
        console.log(chalk_1.default.bold('\n  Active Promotions:\n'));
        for (const p of promos) {
            const expired = p.expiresAt && new Date(p.expiresAt).getTime() < Date.now();
            const expiry = p.expiresAt ? (expired ? chalk_1.default.red('expired') : chalk_1.default.green(`until ${p.expiresAt}`)) : chalk_1.default.dim('no expiry');
            const icon = expired ? chalk_1.default.red('✗') : chalk_1.default.green('✓');
            console.log(`  ${icon} ${chalk_1.default.bold(p.label)} · ${p.cliType} · ${p.multiplier || '?'}x · ${expiry}`);
        }
        console.log();
        return;
    }
    if (action === 'add') {
        if (!opts.label) {
            console.error(chalk_1.default.red('--label required'));
            process.exit(1);
        }
        const promos = load();
        const entry = { cliType: opts.cli, label: opts.label };
        if (opts.multiplier)
            entry.multiplier = opts.multiplier;
        if (opts.expires) {
            // Support relative dates like "in 7d"
            const match = opts.expires.match(/^in\s+(\d+)([dhm])$/);
            if (match) {
                const n = parseInt(match[1]);
                const unit = match[2] === 'd' ? 86400000 : match[2] === 'h' ? 3600000 : 60000;
                entry.expiresAt = new Date(Date.now() + n * unit).toISOString();
            }
            else {
                entry.expiresAt = opts.expires;
            }
        }
        promos.push(entry);
        save(promos);
        console.log(chalk_1.default.green(`\n  ✓ Added promotion: ${entry.label} (${entry.cliType})\n`));
        return;
    }
    if (action === 'clear') {
        save([]);
        console.log(chalk_1.default.green('\n  ✓ All promotions cleared.\n'));
        return;
    }
    if (action === 'remove') {
        const promos = load();
        const idx = promos.findIndex((p) => p.label === opts.label || p.cliType === opts.cli);
        if (idx === -1) {
            console.error(chalk_1.default.red('Promotion not found'));
            process.exit(1);
        }
        const removed = promos.splice(idx, 1)[0];
        save(promos);
        console.log(chalk_1.default.green(`\n  ✓ Removed: ${removed.label}\n`));
        return;
    }
    console.error(chalk_1.default.red(`Unknown action: ${action}. Use: list, add, remove, clear`));
    process.exit(1);
});
// Alias command
program
    .command('alias [action] [value]')
    .description('Manage command aliases (list, add: work=claude-mini, remove: work)')
    .action((action, value) => {
    const aliasManager = new aliases_1.AliasManager();
    const config = new config_1.ConfigManager();
    // List aliases
    if (!action || action === 'list') {
        const aliases = aliasManager.getAliases();
        if (Object.keys(aliases).length === 0) {
            console.log(chalk_1.default.yellow('\n🔗 No aliases configured yet\n'));
            console.log(chalk_1.default.gray('Add an alias with:'), chalk_1.default.bold('sweetch alias work=claude-mini'));
            console.log();
            return;
        }
        console.log(chalk_1.default.bold('\n🔗 Command Aliases:\n'));
        Object.entries(aliases).forEach(([alias, command]) => {
            console.log(chalk_1.default.cyan('  ' + alias), chalk_1.default.gray('→'), command);
        });
        console.log();
        return;
    }
    // Remove alias
    if (action === 'remove') {
        if (!value) {
            console.error(chalk_1.default.red('Error: Alias name required'));
            console.log(chalk_1.default.gray('Usage:'), chalk_1.default.bold('sweetch alias remove <alias>'));
            process.exit(1);
        }
        try {
            aliasManager.removeAlias(value);
            console.log(chalk_1.default.green(`\n✓ Removed alias '${value}'\n`));
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(chalk_1.default.red('Error:'), msg);
            process.exit(1);
        }
        return;
    }
    // Add alias (format: short=command)
    if (action.includes('=')) {
        const [alias, command] = action.split('=');
        if (!alias || !command) {
            console.error(chalk_1.default.red('Error: Invalid alias format'));
            console.log(chalk_1.default.gray('Usage:'), chalk_1.default.bold('sweetch alias work=claude-mini'));
            process.exit(1);
        }
        // Verify command exists
        const profiles = config.getProfiles();
        if (!profiles.find(p => p.commandName === command)) {
            console.error(chalk_1.default.red(`Error: Command '${command}' not found`));
            process.exit(1);
        }
        try {
            aliasManager.addAlias(alias, command);
            console.log(chalk_1.default.green(`\n✓ Added alias: ${alias} → ${command}\n`));
            console.log(chalk_1.default.gray('Now you can use:'), chalk_1.default.bold(alias));
            console.log();
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(chalk_1.default.red('Error:'), msg);
            process.exit(1);
        }
        return;
    }
    console.error(chalk_1.default.red('Error: Invalid action'));
    console.log();
    console.log(chalk_1.default.bold('Usage:'));
    console.log(chalk_1.default.gray('  sweetch alias'), chalk_1.default.dim('# List all aliases'));
    console.log(chalk_1.default.gray('  sweetch alias list'), chalk_1.default.dim('# List all aliases'));
    console.log(chalk_1.default.gray('  sweetch alias work=claude-mini'), chalk_1.default.dim('# Add alias'));
    console.log(chalk_1.default.gray('  sweetch alias remove work'), chalk_1.default.dim('# Remove alias'));
    console.log();
    process.exit(1);
});
// Discover command
program
    .command('discover')
    .description('Discover available AI providers')
    .action(() => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const configuredProviders = new Set(profiles.map(p => p.provider));
    console.log(chalk_1.default.bold('\n🔍 Available AI Providers:\n'));
    Object.values(providers_1.PROVIDERS).forEach(provider => {
        const isConfigured = configuredProviders.has(provider.name);
        const icon = isConfigured ? chalk_1.default.green('✓') : chalk_1.default.gray('○');
        console.log(icon, chalk_1.default.bold(provider.displayName));
        console.log(chalk_1.default.gray('  ' + provider.description));
        if (provider.pricing) {
            console.log(chalk_1.default.gray('  Pricing:'), provider.pricing);
        }
        console.log(chalk_1.default.gray('  Default model:'), provider.defaultModel);
        if (isConfigured) {
            const userProfiles = profiles.filter(p => p.provider === provider.name);
            console.log(chalk_1.default.gray('  Your commands:'), userProfiles.map(p => chalk_1.default.cyan(p.commandName)).join(', '));
        }
        console.log();
    });
    console.log(chalk_1.default.gray('💡 Add a provider with:'), chalk_1.default.bold('sweetch add'));
    console.log();
});
// Completion command
program
    .command('completion <shell>')
    .description('Generate shell completion script (bash or zsh)')
    .action((shell) => {
    if (shell !== 'bash' && shell !== 'zsh') {
        console.error(chalk_1.default.red('Error: Unsupported shell. Use "bash" or "zsh"'));
        process.exit(1);
    }
    const completion = shell === 'bash' ? (0, completion_1.generateBashCompletion)() : (0, completion_1.generateZshCompletion)();
    console.log(completion);
    // Show installation instructions
    console.error(); // stderr to not interfere with script output
    console.error(chalk_1.default.bold.cyan('📝 Installation Instructions:'));
    console.error();
    if (shell === 'bash') {
        console.error(chalk_1.default.gray('1. Save the completion script:'));
        console.error(chalk_1.default.yellow('   sweetch completion bash > ~/.sweech-completion.bash'));
        console.error();
        console.error(chalk_1.default.gray('2. Add to your ~/.bashrc or ~/.bash_profile:'));
        console.error(chalk_1.default.yellow('   source ~/.sweech-completion.bash'));
    }
    else {
        console.error(chalk_1.default.gray('1. Save the completion script:'));
        console.error(chalk_1.default.yellow('   sweetch completion zsh > ~/.sweech-completion.zsh'));
        console.error();
        console.error(chalk_1.default.gray('2. Add to your ~/.zshrc:'));
        console.error(chalk_1.default.yellow('   source ~/.sweech-completion.zsh'));
    }
    console.error();
    console.error(chalk_1.default.gray('3. Reload your shell:'));
    console.error(chalk_1.default.yellow(`   source ~/.${shell === 'bash' ? 'bashrc' : 'zshrc'}`));
    console.error();
});
// Doctor command - Health check
program
    .command('doctor')
    .description('Check sweetch installation and configuration')
    .action(async () => {
    try {
        await (0, utilityCommands_1.runDoctor)();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Path command - PATH configuration helper
program
    .command('path')
    .description('Show and configure PATH for sweetch commands')
    .action(async () => {
    try {
        await (0, utilityCommands_1.runPath)();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Test command - Test provider connection
program
    .command('test <command-name>')
    .description('Test provider configuration and connection')
    .action(async (commandName) => {
    try {
        await (0, utilityCommands_1.runTest)(commandName);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Edit command - Edit profile configuration
program
    .command('edit <command-name>')
    .description('Edit an existing profile configuration')
    .action(async (commandName) => {
    try {
        await (0, utilityCommands_1.runEdit)(commandName);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Model command - Quick model switch for a profile
program
    .command('model <command-name> [model-id]')
    .description('View or switch the active model for a profile')
    .action(async (commandName, modelId) => {
    try {
        const config = new config_1.ConfigManager();
        const profiles = config.getProfiles();
        const profile = profiles.find(p => p.commandName === commandName);
        if (!profile) {
            console.error(chalk_1.default.red(`\nProfile '${commandName}' not found\n`));
            process.exit(1);
        }
        const provider = (0, providers_1.getProvider)(profile.provider);
        const models = provider?.availableModels;
        // If model-id given directly, switch to it
        if (modelId) {
            profile.model = modelId;
            const allProfiles = profiles.map(p => p.commandName === commandName ? profile : p);
            fs.writeFileSync(config.getConfigFile(), JSON.stringify(allProfiles, null, 2));
            if (provider) {
                config.createProfileConfig(commandName, provider, profile.apiKey, profile.cliType, undefined, false, modelId);
            }
            console.log(chalk_1.default.green(`\n✓ ${commandName} model → ${chalk_1.default.bold(modelId)}\n`));
            return;
        }
        // Show current model and catalog
        console.log(chalk_1.default.bold(`\n  ${commandName} · model\n`));
        console.log(`  Current: ${chalk_1.default.cyan(profile.model || provider?.defaultModel || 'default')}\n`);
        if (models && models.length > 0) {
            // Interactive model selector
            const inquirer = (await Promise.resolve().then(() => __importStar(require('inquirer')))).default;
            const choices = models.map(m => {
                const meta = [m.type, m.context, m.note].filter(Boolean).join(', ');
                const current = m.id === (profile.model || provider?.defaultModel) ? chalk_1.default.green(' ← current') : '';
                return {
                    name: `${m.name}  ${chalk_1.default.dim(meta)}${current}`,
                    value: m.id
                };
            });
            choices.push({ name: chalk_1.default.dim('Custom model ID...'), value: '__custom__' });
            const { selected } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'selected',
                    message: 'Select model:',
                    choices,
                    default: profile.model || provider?.defaultModel
                }
            ]);
            let finalModel = selected;
            if (selected === '__custom__') {
                const { value } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'value',
                        message: 'Enter model ID:',
                        validate: (input) => input.trim().length > 0 || 'Model ID required'
                    }
                ]);
                finalModel = value.trim();
            }
            profile.model = finalModel;
            const allProfiles = profiles.map(p => p.commandName === commandName ? profile : p);
            fs.writeFileSync(config.getConfigFile(), JSON.stringify(allProfiles, null, 2));
            if (provider) {
                config.createProfileConfig(commandName, provider, profile.apiKey, profile.cliType, undefined, false, finalModel);
            }
            console.log(chalk_1.default.green(`\n✓ ${commandName} model → ${chalk_1.default.bold(finalModel)}\n`));
        }
        else {
            console.log(chalk_1.default.dim('  No model catalog for this provider.'));
            console.log(chalk_1.default.dim(`  Use: sweech model ${commandName} <model-id>\n`));
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Clone command - Clone an existing profile
program
    .command('clone <source> <target>')
    .description('Clone an existing profile with a new name')
    .action(async (source, target) => {
    try {
        await (0, utilityCommands_1.runClone)(source, target);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Rename command - Rename a profile
program
    .command('rename <old-name> <new-name>')
    .description('Rename an existing profile')
    .action(async (oldName, newName) => {
    try {
        const result = await (0, profileManagement_1.renameManagedProfile)(oldName, newName);
        console.log(chalk_1.default.bold(`\n✏️  Renaming ${oldName} → ${result.newName}...\n`));
        console.log(chalk_1.default.green(`✓ Renamed ${oldName} → ${result.newName}\n`));
        console.log(chalk_1.default.gray('  Command: ' + result.newName));
        console.log(chalk_1.default.gray('  Config: ' + result.profileDir));
        if (result.updatedDependents.length > 0) {
            console.log(chalk_1.default.gray('  Updated shared profiles: ' + result.updatedDependents.join(', ')));
        }
        console.log();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
const profileCmd = program
    .command('profile')
    .description('Non-interactive profile management');
profileCmd
    .command('providers')
    .description('List createable providers for a CLI')
    .requiredOption('--cli <type>', 'CLI type: claude or codex')
    .option('--json', 'Output machine-readable JSON')
    .action((opts) => {
    try {
        const providers = (0, profileManagement_1.getManageableProviders)(opts.cli);
        if (opts.json) {
            process.stdout.write(JSON.stringify({ providers }, null, 2) + '\n');
            return;
        }
        console.log(chalk_1.default.bold(`\n  sweech profile providers · ${opts.cli}\n`));
        providers.forEach(provider => {
            const auth = provider.supportsOAuth ? 'oauth or api-key' : 'api-key';
            console.log(`  ${chalk_1.default.white(provider.displayName)} ${chalk_1.default.dim(`(${auth})`)}`);
            console.log(chalk_1.default.dim(`    ${provider.description}`));
            console.log(chalk_1.default.dim(`    suggested: ${provider.defaultCommandName}`));
        });
        console.log();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
profileCmd
    .command('create')
    .description('Create a profile without interactive prompts')
    .requiredOption('--cli <type>', 'CLI type: claude or codex')
    .requiredOption('--provider <name>', 'Provider name')
    .requiredOption('--name <command-name>', 'Profile command name')
    .option('--auth <method>', 'Authentication method: oauth or api-key', 'oauth')
    .option('--api-key <key>', 'API key for api-key auth')
    .option('--shared-with <name>', 'Share memory/data with another profile or default account')
    .option('--model <model>', 'Override the provider default model')
    .option('--base-url <url>', 'Override the provider base URL')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
    try {
        const result = await (0, profileManagement_1.createManagedProfile)({
            cliType: opts.cli,
            provider: opts.provider,
            commandName: opts.name,
            authMethod: opts.auth,
            apiKey: opts.apiKey,
            sharedWith: opts.sharedWith,
            model: opts.model,
            baseUrl: opts.baseUrl,
        });
        if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: true, profile: result }, null, 2) + '\n');
            return;
        }
        console.log(chalk_1.default.green(`\n✓ Created '${result.commandName}' successfully\n`));
        console.log(chalk_1.default.gray('  Config: ' + result.profileDir));
        console.log();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
            console.error(msg);
        }
        else {
            console.error(chalk_1.default.red('Error:'), msg);
        }
        process.exit(1);
    }
});
profileCmd
    .command('rename <old-name> <new-name>')
    .description('Rename a profile without interactive prompts')
    .option('--json', 'Output machine-readable JSON')
    .action(async (oldName, newName, opts) => {
    try {
        const result = await (0, profileManagement_1.renameManagedProfile)(oldName, newName);
        if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: true, profile: result }, null, 2) + '\n');
            return;
        }
        console.log(chalk_1.default.green(`\n✓ Renamed '${oldName}' to '${result.newName}'\n`));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
            console.error(msg);
        }
        else {
            console.error(chalk_1.default.red('Error:'), msg);
        }
        process.exit(1);
    }
});
profileCmd
    .command('remove <name>')
    .description('Remove a profile without interactive prompts')
    .option('--force-dependents', 'Allow removal even if other profiles share this profile')
    .option('--json', 'Output machine-readable JSON')
    .action((name, opts) => {
    try {
        const result = (0, profileManagement_1.removeManagedProfile)(name, { forceDependents: opts.forceDependents });
        if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: true, profile: result }, null, 2) + '\n');
            return;
        }
        console.log(chalk_1.default.green(`\n✓ Removed '${name}' successfully\n`));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (opts.json) {
            process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
            console.error(msg);
        }
        else {
            console.error(chalk_1.default.red('Error:'), msg);
        }
        process.exit(1);
    }
});
// Share command — selective symlink management
program
    .command('share [profile]')
    .description('Share dirs/files from another profile via symlinks')
    .option('--from <source>', 'Source profile to share from', 'claude')
    .option('--all', 'Share all shareable items without prompting')
    .option('--status', 'Show sharing status for all profiles')
    .action(async (profile, opts) => {
    try {
        if (opts.status) {
            await (0, shareCommands_1.runShareStatus)();
            return;
        }
        if (!profile) {
            console.error(chalk_1.default.red('\nProfile name required. Use --status to see all.\n'));
            process.exit(1);
        }
        await (0, shareCommands_1.runShare)(profile, opts);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Unshare command — remove shared symlinks
program
    .command('unshare <profile>')
    .description('Remove shared symlinks and restore isolated dirs/files')
    .option('--all', 'Remove all shared symlinks without prompting')
    .action(async (profile, opts) => {
    try {
        await (0, shareCommands_1.runUnshare)(profile, opts);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Backup chats command - Backup chat history
program
    .command('backup-chats <command-name>')
    .description('Backup chat history for a profile')
    .option('-o, --output <file>', 'Output file path')
    .action(async (commandName, options) => {
    try {
        const config = new config_1.ConfigManager();
        const profiles = config.getProfiles();
        const profile = profiles.find(p => p.commandName === commandName);
        if (!profile) {
            console.error(chalk_1.default.red(`\nProfile '${commandName}' not found\n`));
            process.exit(1);
        }
        const profileDir = config.getProfileDir(commandName);
        await (0, chatBackup_1.backupChatHistory)(commandName, profileDir, options.output);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Backup failed:'), msg);
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
    .action(async (opts) => {
    if (opts.install) {
        const { installLaunchd } = await Promise.resolve().then(() => __importStar(require('./launchd')));
        await installLaunchd(parseInt(opts.port, 10));
        return;
    }
    if (opts.uninstall) {
        const { uninstallLaunchd } = await Promise.resolve().then(() => __importStar(require('./launchd')));
        await uninstallLaunchd();
        return;
    }
    const port = parseInt(opts.port, 10);
    try {
        await (0, fedServer_1.startSweechFedServerWithShutdown)(port);
        console.log(chalk_1.default.green(`sweech federation server running on :${port}`));
        console.log(chalk_1.default.dim(`  /healthz    — health check`));
        console.log(chalk_1.default.dim(`  /fed/info   — metadata`));
        console.log(chalk_1.default.dim(`  /fed/runs   — account list`));
        console.log(chalk_1.default.dim(`  /fed/widget — account-usage widget`));
        console.log(chalk_1.default.dim(`  SIGTERM/SIGINT for graceful shutdown`));
        // Keep alive
        await new Promise(() => { });
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Failed to start server:'), msg);
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
    .action(async (opts) => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const accountList = (0, subscriptions_1.getKnownAccounts)(profiles);
    if (accountList.length === 0) {
        if (opts.json) {
            process.stdout.write(JSON.stringify({ accounts: [] }, null, 2) + '\n');
        }
        else {
            console.log(chalk_1.default.dim('\nNo accounts found. Run sweech add to get started.\n'));
        }
        return;
    }
    const accounts = await (0, subscriptions_1.getAccountInfo)(accountList, { refresh: opts.refresh });
    // Record history snapshot (non-blocking, max once per hour)
    try {
        (0, usageHistory_1.appendSnapshot)(accounts);
    }
    catch { }
    if (opts.json) {
        // Sort by smart score within groups, add precomputed fields
        const { computeSmartScore, computeTier } = require('./liveUsage');
        const grouped = new Map();
        for (const a of accounts) {
            const g = (0, providers_1.displayGroup)(a.provider);
            if (!grouped.has(g))
                grouped.set(g, []);
            grouped.get(g).push(a);
        }
        const enriched = [];
        for (const [, group] of grouped) {
            group.sort((a, b) => computeSmartScore(b) - computeSmartScore(a));
            group.forEach((a, i) => {
                const score = computeSmartScore(a);
                const tierInfo = computeTier(a, i === 0);
                enriched.push({
                    ...a,
                    smartScore: Math.round(score * 1000) / 1000,
                    tier: tierInfo.tier,
                    tierUrgent: tierInfo.urgent,
                    sortRank: enriched.length,
                });
            });
        }
        process.stdout.write(JSON.stringify({
            schemaVersion: 2,
            generatedAt: new Date().toISOString(),
            summary: (0, usage_2.summarizeAccountsForTelemetry)(accounts),
            accounts: enriched,
        }, null, 2) + '\n');
        return;
    }
    // --history: show 24h sparkline per account and exit
    if (opts.history) {
        console.log(chalk_1.default.bold('\n  sweech · usage history (24h)\n'));
        const sparklines = (0, usageHistory_1.allAccountSparklines)(24, 'u7d');
        if (sparklines.size === 0) {
            console.log(chalk_1.default.dim('  No history data yet. Usage snapshots are recorded hourly.\n'));
            return;
        }
        const maxNameLen = Math.max(...Array.from(sparklines.keys()).map(n => n.length));
        for (const [name, spark] of sparklines) {
            console.log(`  ${chalk_1.default.bold(name.padEnd(maxNameLen))}  ${spark}  ${chalk_1.default.dim('(24h trend)')}`);
        }
        console.log();
        return;
    }
    console.log(chalk_1.default.bold('\n  sweech · usage\n'));
    // Scoring — shared with launcher and SweechBar (via JSON precomputed fields)
    const { computeSmartScore: smartScore } = require('./liveUsage');
    const statusRank = (a) => {
        if (a.needsReauth)
            return 4;
        if (a.live?.status === 'limit_reached')
            return 3;
        if (a.live?.status === 'warning')
            return 2;
        if (a.live?.status === 'allowed')
            return 0;
        return 1;
    };
    const applySort = (list) => {
        if (opts.sort === 'status')
            return [...list].sort((a, b) => statusRank(a) - statusRank(b));
        if (opts.sort === 'manual')
            return list;
        return [...list].sort((a, b) => smartScore(b) - smartScore(a)); // smart
    };
    // Group or flat
    let groups;
    if (opts.group !== false) {
        const map = new Map();
        for (const a of accounts) {
            const g = (0, providers_1.displayGroup)(a.provider);
            if (!map.has(g))
                map.set(g, []);
            map.get(g).push(a);
        }
        const groupOrder = ['claude', 'codex', ...Array.from(map.keys()).filter(k => k !== 'claude' && k !== 'codex').sort()];
        groups = groupOrder.filter(g => map.has(g)).map(g => ({ name: g, items: applySort(map.get(g)) }));
    }
    else {
        groups = [{ name: '', items: applySort(accounts) }];
    }
    const sortLabel = opts.sort === 'status' ? ' · by status' : opts.sort === 'manual' ? ' · manual' : ' · smart';
    console.log(chalk_1.default.dim(`  sort${sortLabel}${opts.group !== false ? '' : ' · ungrouped'}\n`));
    for (const { name, items: sorted } of groups) {
        if (name)
            console.log(chalk_1.default.bold.dim(`  ── ${name} ──`));
        for (let i = 0; i < sorted.length; i++) {
            const a = sorted[i];
            const planStr = a.meta.plan ? chalk_1.default.cyan(` [${a.meta.plan}]`) : '';
            const emailStr = a.emailAddress ? chalk_1.default.dim(` · ${a.emailAddress}`) : '';
            const recommendedStr = i === 0 && smartScore(a) >= 0
                ? chalk_1.default.cyan(' ⚡ use first')
                : '';
            // Token status indicator for OAuth accounts
            let tokenStr = '';
            if (a.tokenStatus === 'refreshed') {
                tokenStr = chalk_1.default.green(' 🔑 token refreshed');
            }
            else if (a.tokenStatus === 'expired') {
                tokenStr = chalk_1.default.red(' 🔑 token expired');
            }
            else if (a.tokenStatus === 'valid' && a.tokenExpiresAt) {
                const hoursLeft = Math.max(0, (a.tokenExpiresAt - Date.now()) / 3600000);
                if (hoursLeft < 1) {
                    tokenStr = chalk_1.default.yellow(` 🔑 expires in ${Math.round(hoursLeft * 60)}m`);
                }
                else if (hoursLeft < 24) {
                    tokenStr = chalk_1.default.dim(` 🔑 expires in ${Math.round(hoursLeft)}h`);
                }
            }
            else if (a.tokenStatus === 'no_token' && a.cliType === 'claude') {
                tokenStr = chalk_1.default.dim(' 🔑 no token');
            }
            console.log(`  ${chalk_1.default.bold(a.name)}${planStr}${emailStr}${recommendedStr}${tokenStr}`);
            // 5h window
            const cap5hStr = a.minutesUntilFirstCapacity !== undefined
                ? chalk_1.default.yellow(` · capacity in ${a.minutesUntilFirstCapacity}m`)
                : '';
            const live5hStr = a.live?.utilization5h !== undefined
                ? ` (${Math.round(a.live.utilization5h * 100)}% used)`
                : '';
            const reset5hStr = a.live?.reset5hAt !== undefined
                ? (() => {
                    const mins = Math.round((a.live.reset5hAt - Date.now() / 1000) / 60);
                    if (mins < 30)
                        return chalk_1.default.red(` · resets in ${mins}m`);
                    if (mins < 120)
                        return chalk_1.default.yellow(` · resets in ${mins}m`);
                    const h = Math.floor(mins / 60), m = mins % 60;
                    return chalk_1.default.cyan(` · resets in ${h}h ${m}m`);
                })()
                : '';
            console.log(`    5h:   ${chalk_1.default.white(String(a.messages5h))} messages${live5hStr}${reset5hStr}${cap5hStr}`);
            // week window + expiry alert
            const reset7dAt = a.live?.reset7dAt;
            const weeklyResetStr = reset7dAt !== undefined
                ? (() => {
                    const h = Math.round((reset7dAt - Date.now() / 1000) / 3600);
                    const d = Math.floor(h / 24), hr = h % 24;
                    const label = d > 0 ? `${d}d ${hr}h` : `${h}h`;
                    return chalk_1.default.cyan(` · resets in ${label}`);
                })()
                : a.hoursUntilWeeklyReset !== undefined
                    ? chalk_1.default.cyan(` · resets in ${a.hoursUntilWeeklyReset}h`)
                    : chalk_1.default.dim(' · set plan to compute');
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
                    expiryAlertStr = chalk_1.default.cyan(` ⚡ ${pct}% expiring in ${label}`);
                }
            }
            console.log(`    week: ${chalk_1.default.white(String(a.messages7d))} messages${live7dStr}${weeklyResetStr}${expiryAlertStr}`);
            // Per-model bucket breakdowns (--models flag)
            if (opts.models && a.live?.buckets && a.live.buckets.length > 1) {
                const sorted = [...a.live.buckets].sort((x, y) => (x.label === 'All models' ? 0 : 1) - (y.label === 'All models' ? 0 : 1));
                for (const bucket of sorted) {
                    if (bucket.label === 'All models')
                        continue; // already shown above
                    console.log(chalk_1.default.dim(`    ── ${bucket.label} ──`));
                    if (bucket.session) {
                        const u = Math.round(bucket.session.utilization * 100);
                        const r = bucket.session.resetsAt
                            ? (() => { const m = Math.round((bucket.session.resetsAt - Date.now() / 1000) / 60); return m < 60 ? chalk_1.default.cyan(` · resets in ${m}m`) : chalk_1.default.cyan(` · resets in ${Math.floor(m / 60)}h ${m % 60}m`); })()
                            : '';
                        console.log(`      5h:   ${u}% used${r}`);
                    }
                    if (bucket.weekly) {
                        const u = Math.round(bucket.weekly.utilization * 100);
                        const r = bucket.weekly.resetsAt
                            ? (() => { const h = Math.round((bucket.weekly.resetsAt - Date.now() / 1000) / 3600); const d = Math.floor(h / 24); return d > 0 ? chalk_1.default.cyan(` · resets in ${d}d ${h % 24}h`) : chalk_1.default.cyan(` · resets in ${h}h`); })()
                            : '';
                        console.log(`      week: ${u}% used${r}`);
                    }
                }
            }
            const lastStr = a.lastActive
                ? chalk_1.default.dim(`  last: ${new Date(a.lastActive).toLocaleString()}`)
                : '';
            if (lastStr)
                console.log(`   ${lastStr}`);
            console.log();
        }
    }
});
usageCmd
    .command('set-plan <account> <plan>')
    .description('Set the plan label for an account (e.g. "Max 5x", "Max 20x", "Pro")')
    .action((account, plan) => {
    const config = new config_1.ConfigManager();
    const known = (0, subscriptions_1.getKnownAccounts)(config.getProfiles());
    const profile = known.find(p => p.name === account || p.commandName === account);
    if (!profile) {
        console.error(chalk_1.default.red(`Account '${account}' not found`));
        console.log(chalk_1.default.dim('Available: ' + known.map(p => p.name).join(', ')));
        process.exit(1);
    }
    (0, subscriptions_1.setMeta)(profile.commandName, { plan });
    console.log(chalk_1.default.green(`✓ Plan set to "${plan}" for ${profile.name}`));
});
usageCmd
    .command('set-limits <account> <5h> <7d>')
    .description('Set known message limits for progress bars (e.g. "Max 5x" = 225 5h, 2000 7d)')
    .action((account, limit5h, limit7d) => {
    const config = new config_1.ConfigManager();
    const known = (0, subscriptions_1.getKnownAccounts)(config.getProfiles());
    const profile = known.find(p => p.name === account || p.commandName === account);
    if (!profile) {
        console.error(chalk_1.default.red(`Account '${account}' not found`));
        process.exit(1);
    }
    (0, subscriptions_1.setMeta)(profile.commandName, { limits: { window5h: parseInt(limit5h), window7d: parseInt(limit7d) } });
    console.log(chalk_1.default.green(`✓ Limits set for ${profile.name}: 5h=${limit5h} 7d=${limit7d}`));
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
    const plugins = (0, plugins_1.listPlugins)();
    if (plugins.length === 0) {
        console.log(chalk_1.default.dim('\nNo plugins installed. Use `sweech plugins install <package>` to add one.\n'));
        return;
    }
    console.log(chalk_1.default.bold('\n  sweech · plugins\n'));
    for (const p of plugins) {
        const status = p.enabled ? chalk_1.default.green('enabled') : chalk_1.default.red('disabled');
        console.log(`  ${chalk_1.default.bold(p.name)} ${chalk_1.default.dim(`v${p.version}`)} [${status}]`);
    }
    console.log();
});
pluginsCmd
    .command('install <package>')
    .description('Install an npm package as a sweech plugin')
    .action(async (npmPackage) => {
    try {
        console.log(chalk_1.default.dim(`Installing plugin "${npmPackage}"...`));
        await (0, plugins_1.installPlugin)(npmPackage);
        console.log(chalk_1.default.green(`\n✓ Plugin "${npmPackage}" installed and enabled.\n`));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
pluginsCmd
    .command('uninstall <name>')
    .description('Uninstall a sweech plugin')
    .action(async (name) => {
    try {
        await (0, plugins_1.uninstallPlugin)(name);
        console.log(chalk_1.default.green(`\n✓ Plugin "${name}" uninstalled.\n`));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
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
    const all = (0, templates_1.getAllTemplates)();
    const custom = (0, templates_1.loadCustomTemplates)();
    const customNames = new Set(custom.map(t => t.name));
    console.log(chalk_1.default.bold('\n  sweech · templates\n'));
    console.log(chalk_1.default.cyan('  Built-in:\n'));
    for (const t of templates_1.BUILT_IN_TEMPLATES) {
        const overridden = customNames.has(t.name) ? chalk_1.default.yellow(' [overridden]') : '';
        const modelStr = t.model ? chalk_1.default.dim(` model=${t.model}`) : '';
        console.log(`    ${chalk_1.default.bold(t.name)}  ${chalk_1.default.dim(t.description)}${modelStr}${overridden}`);
    }
    if (custom.length > 0) {
        console.log(chalk_1.default.cyan('\n  Custom:\n'));
        for (const t of custom) {
            const modelStr = t.model ? chalk_1.default.dim(` model=${t.model}`) : '';
            console.log(`    ${chalk_1.default.bold(t.name)}  ${chalk_1.default.dim(t.description)}${modelStr}`);
        }
    }
    console.log(chalk_1.default.dim(`\n  Use: sweech add --template <name>\n`));
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
    .action((name, opts) => {
    const tpl = {
        name,
        description: opts.description || `Custom template: ${name}`,
        cliType: opts.cli,
        provider: opts.provider,
        model: opts.model,
        baseUrl: opts.baseUrl,
        tags: opts.tags ? opts.tags.split(',').map(t => t.trim()) : [name],
    };
    (0, templates_1.saveCustomTemplate)(tpl);
    console.log(chalk_1.default.green(`\n✓ Template "${name}" saved.\n`));
});
templatesCmd
    .command('remove <name>')
    .description('Remove a custom template')
    .action((name) => {
    const custom = (0, templates_1.loadCustomTemplates)();
    if (!custom.find(t => t.name === name)) {
        console.error(chalk_1.default.red(`Custom template '${name}' not found.`));
        const builtIn = templates_1.BUILT_IN_TEMPLATES.find(t => t.name === name);
        if (builtIn) {
            console.log(chalk_1.default.dim('Note: Built-in templates cannot be removed.'));
        }
        process.exit(1);
    }
    (0, templates_1.deleteCustomTemplate)(name);
    console.log(chalk_1.default.green(`\n✓ Template "${name}" removed.\n`));
});
// Reset command - Uninstall sweetch
program
    .command('reset')
    .description('Uninstall sweetch (removes all sweetch-managed profiles)')
    .action(async () => {
    try {
        await (0, reset_2.runReset)();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Error:'), msg);
        process.exit(1);
    }
});
// Update command - Self-update sweech
program
    .command('update')
    .description('Update sweech to the latest version from GitHub')
    .option('--check', 'Only check for updates, do not install')
    .action(async (opts) => {
    try {
        console.log(chalk_1.default.bold('\n🔄 Checking for updates...\n'));
        const result = await (0, updateChecker_1.checkForUpdate)(version);
        if (!result) {
            console.log(chalk_1.default.yellow('  Could not reach the update server. Check your network connection.\n'));
            if (!opts.check)
                process.exit(1);
            return;
        }
        console.log(chalk_1.default.cyan('  Current:'), result.current);
        console.log(chalk_1.default.cyan('  Latest: '), result.latest);
        if (!result.updateAvailable) {
            console.log(chalk_1.default.green('\n  ✓ You are on the latest version.\n'));
            return;
        }
        console.log(chalk_1.default.yellow(`\n  Update available: ${result.current} → ${result.latest}\n`));
        // Fetch and display changelog
        const changelog = await (0, updateChecker_1.fetchChangelog)(result.current, result.latest);
        if (changelog) {
            console.log(chalk_1.default.bold('  What\'s new:\n'));
            for (const line of changelog.split('\n')) {
                console.log(chalk_1.default.dim(`    ${line}`));
            }
            console.log();
        }
        if (opts.check)
            return;
        console.log(chalk_1.default.bold('  Installing update...\n'));
        const { execSync: execSyncUpdate } = require('child_process');
        execSyncUpdate('npm install -g github:vykeai/sweech', { stdio: 'inherit' });
        console.log(chalk_1.default.green('\n✓ sweech updated to ' + result.latest + '\n'));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Update failed:'), msg);
        process.exit(1);
    }
});
// resync intentionally removed — it caused data loss by replacing real files with symlinks
// ── sweech sessions ─────────────────────────────────────────────────────────────
program
    .command('sessions')
    .description('List active CLI sessions across all accounts')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
    const { detectActiveSessions } = await Promise.resolve().then(() => __importStar(require('./sessions')));
    const sessions = detectActiveSessions();
    if (opts.json) {
        process.stdout.write(JSON.stringify({ sessions }, null, 2) + '\n');
        return;
    }
    if (sessions.length === 0) {
        console.log(chalk_1.default.dim('\n  No active CLI sessions.\n'));
        return;
    }
    console.log(chalk_1.default.bold(`\n  ${sessions.length} active session(s)\n`));
    for (const s of sessions) {
        console.log(`  ${chalk_1.default.white(s.commandName || s.cliType)} ${chalk_1.default.dim(`pid=${s.pid}`)} ${chalk_1.default.dim(s.command)}`);
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
    .action(async (remote) => {
    const { initSync } = await Promise.resolve().then(() => __importStar(require('./sync')));
    await initSync(remote);
    console.log(chalk_1.default.green('✓ Sync initialized'));
});
syncCmd
    .command('push')
    .description('Push config changes to remote')
    .action(async () => {
    const { pushSync } = await Promise.resolve().then(() => __importStar(require('./sync')));
    await pushSync();
    console.log(chalk_1.default.green('✓ Config pushed'));
});
syncCmd
    .command('pull')
    .description('Pull config changes from remote')
    .action(async () => {
    const { pullSync } = await Promise.resolve().then(() => __importStar(require('./sync')));
    await pullSync();
    console.log(chalk_1.default.green('✓ Config pulled'));
});
syncCmd
    .command('status')
    .description('Show sync status')
    .action(async () => {
    const { getSyncStatus } = await Promise.resolve().then(() => __importStar(require('./sync')));
    const status = getSyncStatus();
    if (!status.initialized) {
        console.log(chalk_1.default.dim('\n  Sync not initialized. Run: sweech sync init [remote]\n'));
        return;
    }
    console.log(chalk_1.default.bold('\n  sync status'));
    if (status.remote)
        console.log(`  remote: ${chalk_1.default.cyan(status.remote)}`);
    if (status.lastSync)
        console.log(`  last sync: ${chalk_1.default.dim(status.lastSync)}`);
    console.log();
});
// ── sweech audit ────────────────────────────────────────────────────────────────
program
    .command('audit')
    .description('View the audit log')
    .option('--limit <n>', 'Number of entries to show', '20')
    .option('--action <type>', 'Filter by action type')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
    const { readAuditLog } = await Promise.resolve().then(() => __importStar(require('./auditLog')));
    const entries = readAuditLog({ limit: parseInt(opts.limit), action: opts.action });
    if (opts.json) {
        process.stdout.write(JSON.stringify({ entries }, null, 2) + '\n');
        return;
    }
    if (entries.length === 0) {
        console.log(chalk_1.default.dim('\n  No audit entries.\n'));
        return;
    }
    console.log(chalk_1.default.bold(`\n  audit log (${entries.length} entries)\n`));
    for (const e of entries) {
        const acct = e.account ? chalk_1.default.cyan(` [${e.account}]`) : '';
        console.log(`  ${chalk_1.default.dim(e.timestamp)} ${chalk_1.default.white(e.action)}${acct}`);
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
    .action(async (inviteCode, opts) => {
    if (opts.hub) {
        const { joinTeam } = await Promise.resolve().then(() => __importStar(require('./team')));
        await joinTeam(inviteCode, opts.hub);
    }
    else {
        const { joinTeamLocal } = await Promise.resolve().then(() => __importStar(require('./team')));
        joinTeamLocal(inviteCode);
    }
    console.log(chalk_1.default.green('✓ Joined team'));
});
teamCmd
    .command('leave')
    .description('Leave the current team')
    .option('--hub', 'Notify hub before leaving')
    .action(async (opts) => {
    if (opts.hub) {
        const { leaveTeam } = await Promise.resolve().then(() => __importStar(require('./team')));
        await leaveTeam();
    }
    else {
        const { leaveTeamLocal } = await Promise.resolve().then(() => __importStar(require('./team')));
        leaveTeamLocal();
    }
    console.log(chalk_1.default.green('✓ Left team'));
});
teamCmd
    .command('invite <email>')
    .description('Invite a member to the team')
    .option('--hub', 'Send invite via hub (requires admin)')
    .action(async (email, opts) => {
    if (opts.hub) {
        const { inviteMember } = await Promise.resolve().then(() => __importStar(require('./team')));
        await inviteMember(email);
    }
    else {
        const { addLocalInvite } = await Promise.resolve().then(() => __importStar(require('./team')));
        addLocalInvite(email);
    }
    console.log(chalk_1.default.green(`✓ Invite sent to ${email}`));
});
teamCmd
    .command('members')
    .description('List team members')
    .option('--hub', 'Fetch members from hub')
    .action(async (opts) => {
    if (opts.hub) {
        const { listMembers } = await Promise.resolve().then(() => __importStar(require('./team')));
        const members = await listMembers();
        console.log(chalk_1.default.bold(`\n  team members (${members.length})\n`));
        for (const m of members) {
            console.log(`  ${chalk_1.default.white(m.name)} ${chalk_1.default.dim(`[${m.role}]`)} ${chalk_1.default.dim(`${m.accounts} accounts`)} ${chalk_1.default.dim(`last seen: ${m.lastSeen}`)}`);
        }
    }
    else {
        const { getLocalMembers, loadTeamConfig } = await Promise.resolve().then(() => __importStar(require('./team')));
        const members = getLocalMembers();
        const config = loadTeamConfig();
        console.log(chalk_1.default.bold(`\n  team members (${members.length})\n`));
        for (const m of members) {
            console.log(`  ${chalk_1.default.white(m.name)} ${chalk_1.default.dim(`[${m.role}]`)} ${chalk_1.default.dim(m.email)} ${chalk_1.default.dim(`joined: ${m.joinedAt}`)}`);
        }
        if (config && config.pendingInvites.length > 0) {
            console.log(chalk_1.default.bold(`\n  pending invites (${config.pendingInvites.length})\n`));
            for (const email of config.pendingInvites) {
                console.log(`  ${chalk_1.default.yellow('○')} ${email}`);
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
    const { loadWebhookConfig, getDeliveryLog } = await Promise.resolve().then(() => __importStar(require('./webhooks')));
    const hooks = loadWebhookConfig();
    if (hooks.length === 0) {
        console.log(chalk_1.default.dim('\n  No webhooks configured. Add them to ~/.sweech/webhooks.json\n'));
        console.log(chalk_1.default.dim('  Example config:'));
        console.log(chalk_1.default.dim('  ['));
        console.log(chalk_1.default.dim('    {'));
        console.log(chalk_1.default.dim('      "url": "https://example.com/webhook",'));
        console.log(chalk_1.default.dim('      "events": ["*"],'));
        console.log(chalk_1.default.dim('      "name": "my-hook"'));
        console.log(chalk_1.default.dim('    }'));
        console.log(chalk_1.default.dim('  ]\n'));
        return;
    }
    console.log(chalk_1.default.bold(`\n  ${hooks.length} webhook(s)\n`));
    for (const h of hooks) {
        const name = h.name ? chalk_1.default.white(h.name) : chalk_1.default.dim('unnamed');
        const evts = h.events.includes('*') ? chalk_1.default.yellow('*') : chalk_1.default.dim(h.events.join(', '));
        const secret = h.secret ? chalk_1.default.green(' [signed]') : '';
        console.log(`  ${name} → ${chalk_1.default.cyan(h.url)} [${evts}]${secret}`);
    }
    const log = getDeliveryLog();
    if (log.length > 0) {
        console.log(chalk_1.default.bold(`\n  recent deliveries (${log.length})\n`));
        for (const d of log.slice(0, 10)) {
            const status = d.status === 'success' ? chalk_1.default.green('ok') : chalk_1.default.red('fail');
            const attempts = d.attempts > 1 ? chalk_1.default.dim(` (${d.attempts} attempts)`) : '';
            console.log(`  ${status} ${chalk_1.default.dim(d.event)} → ${chalk_1.default.dim(d.url)}${attempts} ${chalk_1.default.dim(d.timestamp)}`);
        }
    }
    console.log();
});
webhooksCmd
    .command('test [url]')
    .description('Send a test webhook to verify delivery')
    .action(async (url) => {
    const { loadWebhookConfig, deliverWebhook } = await Promise.resolve().then(() => __importStar(require('./webhooks')));
    const hooks = loadWebhookConfig();
    const targets = url
        ? [{ url, events: ['*'], name: 'test' }]
        : hooks;
    if (targets.length === 0) {
        console.log(chalk_1.default.dim('\n  No webhooks to test. Configure ~/.sweech/webhooks.json or pass a URL.\n'));
        return;
    }
    console.log(chalk_1.default.bold(`\n  Testing ${targets.length} webhook(s)...\n`));
    for (const hook of targets) {
        const name = hook.name || hook.url;
        const result = await deliverWebhook(hook, 'test', { message: 'sweech webhook test' }, 1);
        if (result.success) {
            console.log(`  ${chalk_1.default.green('ok')} ${name} (HTTP ${result.statusCode})`);
        }
        else {
            console.log(`  ${chalk_1.default.red('fail')} ${name}: ${result.error}`);
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
    .action(async (opts) => {
    const { loadFedPeers, fetchPeerHealth, updatePeerLastSeen } = await Promise.resolve().then(() => __importStar(require('./fedClient')));
    const peers = loadFedPeers();
    if (peers.length === 0) {
        if (opts.json) {
            process.stdout.write(JSON.stringify({ peers: [] }, null, 2) + '\n');
        }
        else {
            console.log(chalk_1.default.dim('\n  No peers configured. Run: sweech peers add <name> <host> <port>\n'));
        }
        return;
    }
    const results = await Promise.all(peers.map(async (p) => {
        const health = await fetchPeerHealth(p);
        if (health?.ok)
            updatePeerLastSeen(p.name);
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
    console.log(chalk_1.default.bold(`\n  ${peers.length} peer(s)\n`));
    for (const { peer: p, health } of results) {
        const status = health?.ok ? chalk_1.default.green('ok') : chalk_1.default.red('down');
        const latency = health?.latencyMs ? chalk_1.default.dim(`${health.latencyMs}ms`) : '';
        const addedStr = p.addedAt ? chalk_1.default.dim(` added ${new Date(p.addedAt).toLocaleDateString()}`) : '';
        const lastStr = p.lastSeen ? chalk_1.default.dim(` last seen ${new Date(p.lastSeen).toLocaleString()}`) : '';
        console.log(`  ${chalk_1.default.white(p.name)} ${chalk_1.default.dim(`${p.host}:${p.port}`)} ${status} ${latency}${addedStr}${lastStr}`);
    }
    console.log();
});
peersCmd
    .command('add <name> <host> <port>')
    .description('Add a federation peer')
    .option('--secret <secret>', 'Shared secret for auth')
    .action(async (name, host, port, opts) => {
    const { addPeer } = await Promise.resolve().then(() => __importStar(require('./fedClient')));
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        console.error(chalk_1.default.red('Error: Port must be a number between 1 and 65535'));
        process.exit(1);
    }
    addPeer({ name, host, port: portNum, secret: opts.secret, addedAt: new Date().toISOString() });
    console.log(chalk_1.default.green(`✓ Peer '${name}' added (${host}:${portNum})`));
});
peersCmd
    .command('remove <name>')
    .description('Remove a federation peer')
    .action(async (name) => {
    const { loadFedPeers, removePeer } = await Promise.resolve().then(() => __importStar(require('./fedClient')));
    const peers = loadFedPeers();
    if (!peers.find(p => p.name === name)) {
        console.error(chalk_1.default.red(`Peer '${name}' not found`));
        process.exit(1);
    }
    removePeer(name);
    console.log(chalk_1.default.green(`✓ Peer '${name}' removed`));
});
// ── sweech export / import ───────────────────────────────────────────────────
program
    .command('export <name>')
    .description('Export a profile as a shareable JSON template (sensitive fields stripped)')
    .option('-o, --output <file>', 'Write to file instead of stdout')
    .action(async (name, opts) => {
    try {
        const config = new config_1.ConfigManager();
        const profiles = config.getProfiles();
        const aliasManager = new aliases_1.AliasManager();
        const resolvedName = aliasManager.resolveAlias(name);
        const profile = profiles.find(p => p.commandName === resolvedName);
        if (!profile) {
            console.error(chalk_1.default.red(`Profile '${name}' not found`));
            process.exit(1);
        }
        // Build template — strip sensitive fields (apiKey, oauth, accessToken, refreshToken)
        const template = {
            commandName: profile.commandName,
            cliType: profile.cliType,
            provider: profile.provider,
        };
        if (profile.model)
            template.model = profile.model;
        if (profile.smallFastModel)
            template.smallFastModel = profile.smallFastModel;
        if (profile.baseUrl)
            template.baseUrl = profile.baseUrl;
        if (profile.sharedWith)
            template.sharedWith = profile.sharedWith;
        const json = JSON.stringify(template, null, 2) + '\n';
        if (opts.output) {
            fs.writeFileSync(opts.output, json);
            console.error(chalk_1.default.green(`✓ Exported '${resolvedName}' to ${opts.output}`));
        }
        else {
            process.stdout.write(json);
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Export failed:'), msg);
        process.exit(1);
    }
});
program
    .command('import <file>')
    .description('Import a profile from a JSON template')
    .action(async (file) => {
    try {
        if (!fs.existsSync(file)) {
            console.error(chalk_1.default.red(`File not found: ${file}`));
            process.exit(1);
        }
        const raw = fs.readFileSync(file, 'utf-8');
        let template;
        try {
            template = JSON.parse(raw);
        }
        catch {
            console.error(chalk_1.default.red('Invalid JSON in template file'));
            process.exit(1);
        }
        // Validate required fields
        const required = ['commandName', 'cliType', 'provider'];
        const missing = required.filter(f => !template[f]);
        if (missing.length > 0) {
            console.error(chalk_1.default.red(`Missing required fields: ${missing.join(', ')}`));
            process.exit(1);
        }
        const commandName = template.commandName;
        const cliType = template.cliType;
        const providerName = template.provider;
        // Validate command name format
        if (!/^[a-z0-9-]+$/.test(commandName)) {
            console.error(chalk_1.default.red(`Invalid command name: '${commandName}' (must be lowercase alphanumeric with dashes)`));
            process.exit(1);
        }
        // Check CLI type
        const cli = (0, clis_1.getCLI)(cliType);
        if (!cli) {
            console.error(chalk_1.default.red(`Unknown CLI type: '${cliType}' (expected 'claude' or 'codex')`));
            process.exit(1);
        }
        // Check provider
        const provider = (0, providers_1.getProvider)(providerName);
        if (!provider) {
            console.error(chalk_1.default.red(`Unknown provider: '${providerName}'`));
            console.log(chalk_1.default.dim('Available: ' + (0, providers_1.getProviderList)().map(p => p.name).join(', ')));
            process.exit(1);
        }
        const config = new config_1.ConfigManager();
        const profiles = config.getProfiles();
        if (profiles.some(p => p.commandName === commandName)) {
            console.error(chalk_1.default.red(`Profile '${commandName}' already exists`));
            process.exit(1);
        }
        // Prompt for API key if TTY
        console.log(chalk_1.default.bold(`\nImporting profile: ${commandName}`));
        console.log(chalk_1.default.dim(`  Provider: ${provider.displayName}`));
        console.log(chalk_1.default.dim(`  CLI: ${cli.displayName}`));
        if (template.model)
            console.log(chalk_1.default.dim(`  Model: ${template.model}`));
        console.log();
        let apiKey;
        if (process.stdout.isTTY) {
            const inquirer = await Promise.resolve().then(() => __importStar(require('inquirer')));
            const { key } = await inquirer.default.prompt([{
                    type: 'password',
                    name: 'key',
                    message: `API key for ${provider.displayName} (leave blank to skip):`,
                    mask: '*',
                }]);
            apiKey = key || undefined;
        }
        else {
            console.error(chalk_1.default.yellow('Non-interactive mode: skipping API key prompt. Run sweech auth to configure later.'));
        }
        // Create profile
        const profile = {
            name: commandName,
            commandName,
            cliType,
            provider: providerName,
            apiKey,
            baseUrl: template.baseUrl || provider.baseUrl,
            model: template.model || provider.defaultModel,
            smallFastModel: template.smallFastModel || provider.smallFastModel,
            sharedWith: template.sharedWith,
            createdAt: new Date().toISOString(),
        };
        config.addProfile(profile);
        config.createProfileConfig(commandName, provider, apiKey, cliType);
        config.createWrapperScript(commandName, cli);
        if (profile.sharedWith) {
            config.setupSharedDirs(commandName, profile.sharedWith, cliType);
        }
        console.log(chalk_1.default.green(`\n✓ Imported profile '${commandName}'`));
        if (!apiKey) {
            console.log(chalk_1.default.yellow('  No API key set — run:'), chalk_1.default.bold(`sweech auth ${commandName}`));
        }
        console.log(chalk_1.default.dim(`  Run: ${commandName}\n`));
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Import failed:'), msg);
        process.exit(1);
    }
});
// ── sweech dashboard ────────────────────────────────────────────────────────────
program
    .command('dashboard')
    .description('Open a local usage analytics dashboard in the browser')
    .option('--port <number>', 'Port to listen on (default: random available)')
    .option('--no-open', 'Do not auto-open the browser')
    .action(async (opts) => {
    try {
        const { startDashboard } = await Promise.resolve().then(() => __importStar(require('./dashboard')));
        const portNum = opts.port ? parseInt(opts.port, 10) : undefined;
        const { port } = await startDashboard({ port: portNum, open: opts.open });
        console.log(chalk_1.default.green(`\n  sweech dashboard running at http://127.0.0.1:${port}\n`));
        console.log(chalk_1.default.dim('  Press Ctrl+C to stop\n'));
        // Keep alive
        await new Promise(() => { });
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('Dashboard failed:'), msg);
        process.exit(1);
    }
});
// ── query: show profile details ────────────────────────────────────────────────
program
    .command('query <profile-name>')
    .description('Show details for a profile: model, provider, CLI type, capabilities')
    .option('--json', 'Output as JSON')
    .action((profileName, opts) => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.commandName === profileName || p.name === profileName);
    if (!profile) {
        console.error(chalk_1.default.red(`Profile '${profileName}' not found.`));
        console.error(chalk_1.default.dim(`  Run \`sweech list\` to see available profiles.`));
        process.exit(1);
    }
    const provider = (0, providers_1.getProvider)(profile.provider);
    const model = profile.model ?? provider?.defaultModel ?? 'unknown';
    const smallModel = profile.smallFastModel ?? provider?.smallFastModel ?? null;
    const result = {
        name: profile.name,
        commandName: profile.commandName,
        cliType: profile.cliType,
        provider: profile.provider,
        providerDisplayName: provider?.displayName ?? profile.provider,
        model,
        smallFastModel: smallModel,
        baseUrl: profile.baseUrl ?? provider?.baseUrl ?? null,
        pricing: provider?.pricing ?? null,
        apiFormat: provider?.apiFormat ?? null,
        capabilities: {
            vision: model.includes('claude') || model.includes('gpt'),
            streaming: true,
        },
        sharedWith: profile.sharedWith ?? null,
    };
    if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
    }
    console.log(chalk_1.default.bold(`\n  ${result.commandName}  `) + chalk_1.default.dim(`(${result.name})\n`));
    console.log(chalk_1.default.cyan('  Provider:'), result.providerDisplayName);
    console.log(chalk_1.default.cyan('  CLI:     '), result.cliType);
    console.log(chalk_1.default.cyan('  Model:   '), result.model);
    if (result.smallFastModel)
        console.log(chalk_1.default.cyan('  Fast:    '), result.smallFastModel);
    if (result.baseUrl)
        console.log(chalk_1.default.cyan('  Base URL:'), result.baseUrl);
    if (result.pricing)
        console.log(chalk_1.default.cyan('  Pricing: '), result.pricing);
    if (result.sharedWith)
        console.log(chalk_1.default.cyan('  Shared:  '), chalk_1.default.dim(`shares dirs with ${result.sharedWith}`));
    console.log();
});
// ── models: list available models per provider ──────────────────────────────────
program
    .command('models')
    .description('List available models per provider with context sizes and notes')
    .option('--provider <name>', 'Filter to a specific provider')
    .option('--json', 'Output as JSON')
    .action((opts) => {
    const providerList = Object.values(providers_1.PROVIDERS).filter(p => !p.isCustom);
    const filtered = opts.provider
        ? providerList.filter(p => p.name === opts.provider || p.displayName.toLowerCase() === opts.provider.toLowerCase())
        : providerList;
    if (opts.provider && filtered.length === 0) {
        console.error(chalk_1.default.red(`Provider '${opts.provider}' not found.`));
        process.exit(1);
    }
    if (opts.json) {
        const out = filtered.map(p => ({
            provider: p.name,
            displayName: p.displayName,
            defaultModel: p.defaultModel,
            smallFastModel: p.smallFastModel ?? null,
            pricing: p.pricing ?? null,
            cliTypes: p.compatibility,
            models: (p.availableModels ?? []).map(m => ({ id: m.id, name: m.name, type: m.type ?? null, context: m.context ?? null, note: m.note ?? null })),
        }));
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return;
    }
    for (const p of filtered) {
        console.log(chalk_1.default.bold(`\n  ${p.displayName}`) + chalk_1.default.dim(` [${p.name}]  `) + chalk_1.default.dim(p.compatibility.join('/')));
        if (p.pricing)
            console.log(chalk_1.default.dim(`  ${p.pricing}`));
        const models = p.availableModels ?? [];
        if (models.length === 0) {
            console.log(chalk_1.default.dim(`    default: ${p.defaultModel}`));
            if (p.smallFastModel)
                console.log(chalk_1.default.dim(`    fast:    ${p.smallFastModel}`));
        }
        else {
            for (const m of models) {
                const tag = m.id === p.defaultModel ? chalk_1.default.green(' ← default') : m.id === p.smallFastModel ? chalk_1.default.dim(' ← fast') : '';
                const ctx = m.context ? chalk_1.default.dim(` [${m.context}]`) : '';
                const note = m.note ? chalk_1.default.dim(`  ${m.note}`) : '';
                console.log(`    ${chalk_1.default.cyan(m.id)}${ctx}${tag}${note}`);
            }
        }
    }
    console.log();
});
// ── Startup update check (non-blocking) ────────────────────────────────────────
// Fire-and-forget: if the check completes before parse finishes, print a notice.
// Skip for --help, --version, --complete, and the update command itself.
const skipUpdateCheck = process.argv.some(a => a === '--help' || a === '-h' || a === '--version' || a === '-v' || a === 'update' || a === '--complete');
if (!skipUpdateCheck && process.argv.length > 2) {
    (0, updateChecker_1.checkForUpdate)(version).then(result => {
        if (result && result.updateAvailable) {
            process.stderr.write(chalk_1.default.dim(`[sweech] Update available: ${result.current} → ${result.latest} — run \`sweech update\`\n`));
        }
    }).catch(() => { });
}
// ── repair: one-shot recovery for sweech-managed profiles ────────────────────
// Bundles every "unstick the chat" flow we've needed:
//   1. settings.json regeneration from ~/.sweech/config.json (fixes missing env
//      when Claude Code falls through to OAuth)
//   2. setupSharedDirs rewires the symlinks into ~/.claude/ for shared profiles
//   3. createWrapperScript repopulates ~/.sweech/bin/<profile> shims
//   4. (opt-in) scan session transcripts and patch assistant turns that are
//      `thinking`-only / missing `stop_reason` — these deadlock --continue on
//      GLM-5.1 and other thinking-capable third-party providers.
// Every step is idempotent; rerun whenever anything feels off.
program
    .command('repair [profile]')
    .description('Fix a profile: regenerate settings.json, wrappers, shared symlinks, and (optionally) stuck session transcripts')
    .option('--sessions', 'Also scan session transcripts and patch stuck assistant turns', false)
    .option('--dry-run', 'Report what would be done without writing anything', false)
    .option('--all', 'Repair every Sweech-managed profile', false)
    .action(async (profileName, opts) => {
    const cfgMgr = new config_1.ConfigManager();
    const profiles = cfgMgr.getProfiles();
    const targets = opts.all
        ? profiles
        : profileName
            ? profiles.filter(p => p.commandName === profileName)
            : profiles;
    if (targets.length === 0) {
        console.error(chalk_1.default.red(`No profiles to repair. Try: sweech repair --all`));
        process.exit(1);
    }
    const mode = opts.dryRun ? chalk_1.default.yellow('DRY-RUN') : chalk_1.default.green('REPAIR');
    console.log(chalk_1.default.bold(`\n${mode}  ${targets.length} profile(s)\n`));
    let settingsRegenerated = 0;
    let wrappersRegenerated = 0;
    let symlinksRewired = 0;
    for (const profile of targets) {
        const line = `  ${chalk_1.default.bold(profile.commandName)} ${chalk_1.default.dim(`[${profile.provider}]`)}`;
        console.log(line);
        // 1. settings.json — only for profiles that have an explicit apiKey
        //    (native OAuth profiles manage their own auth)
        const provider = (0, providers_1.getProvider)(profile.provider);
        if (provider && profile.apiKey) {
            if (!opts.dryRun) {
                cfgMgr.createProfileConfig(profile.commandName, provider, profile.apiKey, profile.cliType, undefined, false, profile.model);
            }
            console.log(chalk_1.default.dim(`    settings.json ✓`));
            settingsRegenerated++;
        }
        // 2. shared symlinks (only when sharedWith is set)
        if (profile.sharedWith) {
            if (!opts.dryRun) {
                cfgMgr.setupSharedDirs(profile.commandName, profile.sharedWith, profile.cliType);
            }
            console.log(chalk_1.default.dim(`    symlinks → ${profile.sharedWith} ✓`));
            symlinksRewired++;
        }
        // 3. wrapper script in ~/.sweech/bin
        const cli = (0, clis_1.getCLI)(profile.cliType);
        if (cli) {
            if (!opts.dryRun)
                cfgMgr.createWrapperScript(profile.commandName, cli);
            console.log(chalk_1.default.dim(`    wrapper ~/.sweech/bin/${profile.commandName} ✓`));
            wrappersRegenerated++;
        }
    }
    console.log();
    console.log(chalk_1.default.green(`  ✓ ${settingsRegenerated} settings.json, ${symlinksRewired} symlink set(s), ${wrappersRegenerated} wrapper(s)`));
    // 4. Optional: session transcript repair
    if (opts.sessions) {
        console.log(chalk_1.default.bold(`\n  Scanning session transcripts...`));
        const roots = [];
        const seen = new Set();
        for (const p of targets) {
            const dir = path.join(cfgMgr.getProfileDir(p.commandName), 'projects');
            try {
                const real = fs.realpathSync(dir);
                if (!seen.has(real)) {
                    seen.add(real);
                    roots.push(dir);
                }
            }
            catch { }
        }
        const walk = (dir) => {
            const out = [];
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return out;
            }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory())
                    out.push(...walk(p));
                else if (e.isFile() && p.endsWith('.jsonl'))
                    out.push(p);
            }
            return out;
        };
        const isBrokenAssistant = (d) => {
            if (d?.type !== 'assistant')
                return false;
            const msg = d.message;
            if (!msg || msg.role !== 'assistant')
                return false;
            const content = Array.isArray(msg.content) ? msg.content : [];
            const missingStop = msg.stop_reason === undefined || msg.stop_reason === null;
            const thinkingOnly = content.length > 0
                && content.every((c) => c && c.type === 'thinking');
            return missingStop || thinkingOnly;
        };
        let filesScanned = 0, brokenFound = 0, filesPatched = 0;
        for (const root of roots) {
            for (const file of walk(root)) {
                filesScanned++;
                let raw;
                try {
                    raw = fs.readFileSync(file, 'utf-8');
                }
                catch {
                    continue;
                }
                const lines = raw.split('\n');
                let changed = false;
                const patched = lines.map(ln => {
                    if (!ln.trim())
                        return ln;
                    let d;
                    try {
                        d = JSON.parse(ln);
                    }
                    catch {
                        return ln;
                    }
                    if (!isBrokenAssistant(d))
                        return ln;
                    brokenFound++;
                    const msg = d.message || {};
                    const content = Array.isArray(msg.content) ? msg.content : [];
                    const hasVisible = content.some((c) => c?.type === 'text' || c?.type === 'tool_use');
                    if (!hasVisible)
                        content.push({ type: 'text', text: '[session recovered — prior turn stalled]' });
                    msg.content = content;
                    msg.stop_reason = 'end_turn';
                    if (!('stop_sequence' in msg))
                        msg.stop_sequence = null;
                    d.message = msg;
                    changed = true;
                    return JSON.stringify(d);
                });
                if (changed && !opts.dryRun) {
                    const bak = file + '.bak';
                    if (!fs.existsSync(bak))
                        fs.copyFileSync(file, bak);
                    fs.writeFileSync(file, patched.join('\n'));
                    filesPatched++;
                }
            }
        }
        console.log(chalk_1.default.green(`  ✓ scanned ${filesScanned} transcript(s), ${brokenFound} broken turn(s)` +
            (opts.dryRun ? '' : `, patched ${filesPatched} file(s) (originals → .bak)`)));
    }
    if (opts.dryRun) {
        console.log(chalk_1.default.dim(`\n  Re-run without --dry-run to apply.\n`));
    }
    else {
        console.log();
    }
});
// Default action: interactive launcher when no command given
if (process.argv.length <= 2) {
    // First run: no profiles configured → run onboarding instead of empty launcher
    if ((0, init_1.isFirstRun)()) {
        (0, init_1.runInit)().catch(err => {
            console.error(chalk_1.default.red('Error:'), err.message);
            process.exit(1);
        });
    }
    else {
        (0, launcher_1.runLauncher)().catch(err => {
            console.error(chalk_1.default.red('Error:'), err.message);
            process.exit(1);
        });
    }
}
else {
    program.parse();
}
