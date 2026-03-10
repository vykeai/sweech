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
const aliases_1 = require("./aliases");
const completion_1 = require("./completion");
const chatBackup_1 = require("./chatBackup");
const reset_1 = require("./reset");
const utilityCommands_1 = require("./utilityCommands");
const reset_2 = require("./reset");
const init_1 = require("./init");
const profileCreation_1 = require("./profileCreation");
const launcher_1 = require("./launcher");
const subscriptions_1 = require("./subscriptions");
const fedServer_1 = require("./fedServer");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
// Read version from package.json
const packageJsonPath = path.join(__dirname, '../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const version = packageJson.version;
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
        console.error(chalk_1.default.red('Error during initialization:', error.message));
        process.exit(1);
    }
});
// Add provider command
program
    .command('add')
    .description('Add a new provider with interactive setup')
    .action(async () => {
    try {
        const config = new config_1.ConfigManager();
        const existingProfiles = config.getProfiles();
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
        console.log(chalk_1.default.gray('💡 Tip: You can add multiple accounts for the same provider!'));
        console.log(chalk_1.default.gray('   Example: claude-mini, minimax-work, minimax-personal, etc.'));
    }
    catch (error) {
        console.error(chalk_1.default.red('Error:'), error.message);
        process.exit(1);
    }
});
// List providers command
program
    .command('list')
    .alias('ls')
    .description('List all configured providers')
    .action(() => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const { execFileSync } = require('child_process');
    const os = require('os');
    const fs = require('fs');
    console.log(chalk_1.default.bold('\n🍭 Providers:\n'));
    // Show detected default CLIs
    for (const cli of Object.values(clis_1.SUPPORTED_CLIS)) {
        let installed = false;
        try {
            execFileSync('which', [cli.command], { stdio: 'ignore' });
            installed = true;
        }
        catch { }
        if (!installed)
            continue;
        const configDir = path.join(os.homedir(), `.${cli.name}`);
        const hasConfig = fs.existsSync(configDir);
        const sharingProfiles = profiles.filter(p => p.sharedWith === cli.command);
        const reverseTag = sharingProfiles.length > 0
            ? chalk_1.default.gray(` (← shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`)
            : '';
        console.log(chalk_1.default.cyan('▸'), chalk_1.default.bold(cli.command) + chalk_1.default.gray(' [default]') + reverseTag);
        console.log(chalk_1.default.gray('  CLI:'), cli.displayName);
        console.log(chalk_1.default.gray('  Config:'), hasConfig ? `~/.${cli.name}/` : chalk_1.default.yellow('not configured'));
        console.log();
    }
    // Show sweech-managed profiles
    profiles.forEach(profile => {
        const provider = (0, providers_1.getProvider)(profile.provider);
        const cli = (0, clis_1.getCLI)(profile.cliType || 'claude');
        const sharedTag = profile.sharedWith ? chalk_1.default.magenta(` [shared ↔ ${profile.sharedWith}]`) : '';
        const sharingProfiles = profiles.filter(p => p.sharedWith === profile.commandName);
        const reverseTag = sharingProfiles.length > 0
            ? chalk_1.default.gray(` (← shared by: ${sharingProfiles.map(p => p.commandName).join(', ')})`)
            : '';
        console.log(chalk_1.default.cyan('▸'), chalk_1.default.bold(profile.commandName) + sharedTag + reverseTag);
        console.log(chalk_1.default.gray('  CLI:'), cli?.displayName || profile.cliType);
        console.log(chalk_1.default.gray('  Provider:'), provider?.displayName || profile.provider);
        console.log(chalk_1.default.gray('  Model:'), profile.model || 'default');
        console.log(chalk_1.default.gray('  Created:'), new Date(profile.createdAt).toLocaleDateString());
        console.log();
    });
    if (profiles.length === 0) {
        console.log(chalk_1.default.gray('No additional profiles configured. Run'), chalk_1.default.bold('sweech add'), chalk_1.default.gray('to create one.\n'));
    }
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
        config.removeProfile(commandName);
        console.log(chalk_1.default.green(`\n✓ Removed '${commandName}' successfully\n`));
    }
    catch (error) {
        console.error(chalk_1.default.red('Error:'), error.message);
        process.exit(1);
    }
});
// Info command
program
    .command('info')
    .description('Show sweetch configuration info')
    .action(() => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    console.log(chalk_1.default.bold('\n🍭 Sweetch Configuration:\n'));
    console.log(chalk_1.default.cyan('Version:'), '0.1.0');
    console.log(chalk_1.default.cyan('Config directory:'), config.getBinDir().replace('/bin', ''));
    console.log(chalk_1.default.cyan('Wrapper scripts:'), config.getBinDir());
    console.log(chalk_1.default.cyan('Profiles:'), profiles.length);
    console.log(chalk_1.default.cyan('Default Claude:'), path.join(require('os').homedir(), '.claude'));
    console.log();
    console.log(chalk_1.default.gray('💡 Run'), chalk_1.default.bold('sweetch list'), chalk_1.default.gray('to see all providers'));
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
        console.error(chalk_1.default.red('Backup failed:'), error.message);
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
        console.error(chalk_1.default.red('Restore failed:'), error.message);
        process.exit(1);
    }
});
// Stats command
program
    .command('stats [command-name]')
    .description('Show usage statistics for providers')
    .action((commandName) => {
    const tracker = new usage_1.UsageTracker();
    const stats = tracker.getStats(commandName);
    if (stats.length === 0) {
        console.log(chalk_1.default.yellow('\n📊 No usage data yet. Start using your providers!\n'));
        return;
    }
    console.log(chalk_1.default.bold('\n📊 Usage Statistics:\n'));
    stats.forEach(stat => {
        const lastUsed = new Date(stat.lastUsed);
        const firstUsed = new Date(stat.firstUsed);
        const daysSinceFirst = Math.floor((Date.now() - firstUsed.getTime()) / (1000 * 60 * 60 * 24));
        const avgPerDay = daysSinceFirst > 0 ? (stat.totalUses / daysSinceFirst).toFixed(1) : stat.totalUses;
        console.log(chalk_1.default.cyan('▸'), chalk_1.default.bold(stat.commandName));
        console.log(chalk_1.default.gray('  Total uses:'), stat.totalUses);
        console.log(chalk_1.default.gray('  Last used:'), lastUsed.toLocaleString());
        console.log(chalk_1.default.gray('  First used:'), firstUsed.toLocaleDateString());
        console.log(chalk_1.default.gray('  Avg per day:'), avgPerDay);
        console.log();
    });
});
// Show command
program
    .command('show <command-name>')
    .description('Show detailed information about a provider')
    .action((commandName) => {
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
        console.log();
        console.log(chalk_1.default.bold('Usage:'));
        console.log(chalk_1.default.gray('  Total uses:'), stat.totalUses);
        console.log(chalk_1.default.gray('  Last used:'), new Date(stat.lastUsed).toLocaleString());
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
            console.error(chalk_1.default.red('Error:'), error.message);
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
            console.error(chalk_1.default.red('Error:'), error.message);
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
        console.error(chalk_1.default.red('Error:'), error.message);
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
        console.error(chalk_1.default.red('Error:'), error.message);
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
        console.error(chalk_1.default.red('Error:'), error.message);
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
        console.error(chalk_1.default.red('Error:'), error.message);
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
        console.error(chalk_1.default.red('Error:'), error.message);
        process.exit(1);
    }
});
// Rename command - Rename a profile
program
    .command('rename <old-name> <new-name>')
    .description('Rename an existing profile')
    .action(async (oldName, newName) => {
    try {
        await (0, utilityCommands_1.runRename)(oldName, newName);
    }
    catch (error) {
        console.error(chalk_1.default.red('Error:'), error.message);
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
        console.error(chalk_1.default.red('Backup failed:'), error.message);
        process.exit(1);
    }
});
// ── sweech serve ───────────────────────────────────────────────────────────────
program
    .command('serve')
    .description('Start the fed integration server (exposes /fed/info, /fed/runs, /fed/widget)')
    .option('--port <number>', 'Port to listen on', '7854')
    .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    try {
        await (0, fedServer_1.startSweechFedServer)(port);
        console.log(chalk_1.default.green(`sweech federation server running on :${port}`));
        console.log(chalk_1.default.dim(`  /fed/info   — metadata`));
        console.log(chalk_1.default.dim(`  /fed/runs   — account list`));
        console.log(chalk_1.default.dim(`  /fed/widget — claude-usage widget`));
        // Keep alive
        await new Promise(() => { });
    }
    catch (error) {
        console.error(chalk_1.default.red('Failed to start server:'), error.message);
        process.exit(1);
    }
});
// ── sweech usage ───────────────────────────────────────────────────────────────
const usageCmd = program
    .command('usage')
    .description('Show Claude Code usage windows (5h rolling + 7d) for all accounts')
    .action(async () => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    if (profiles.length === 0) {
        console.log(chalk_1.default.dim('\nNo accounts configured. Run sweech add to get started.\n'));
        return;
    }
    const accounts = await (0, subscriptions_1.getAccountInfo)(profiles.map(p => ({ name: p.name, commandName: p.commandName })));
    console.log(chalk_1.default.bold('\n  sweech · claude code usage\n'));
    for (const a of accounts) {
        const planStr = a.meta.plan ? chalk_1.default.cyan(` [${a.meta.plan}]`) : '';
        const emailStr = a.emailAddress ? chalk_1.default.dim(` · ${a.emailAddress}`) : '';
        console.log(`  ${chalk_1.default.bold(a.name)}${planStr}${emailStr}`);
        // 5-hour window — prefer live utilization % if available
        const cap5hStr = a.minutesUntilFirstCapacity !== undefined
            ? chalk_1.default.dim(` · first capacity in ${a.minutesUntilFirstCapacity}m`)
            : '';
        const live5hStr = a.live?.utilization5h !== undefined
            ? chalk_1.default.dim(` (${Math.round(a.live.utilization5h * 100)}% live)`)
            : '';
        console.log(`    5h window:  ${chalk_1.default.white(String(a.messages5h))} messages${live5hStr}${cap5hStr}`);
        // 7-day window
        const weeklyStr = a.hoursUntilWeeklyReset !== undefined
            ? chalk_1.default.dim(` · resets in ${a.hoursUntilWeeklyReset}h`)
            : chalk_1.default.dim(' · set plan to compute (from subscriptionCreatedAt)');
        const live7dStr = a.live?.utilization7d !== undefined
            ? chalk_1.default.dim(` (${Math.round(a.live.utilization7d * 100)}% live)`)
            : '';
        console.log(`    7d window:  ${chalk_1.default.white(String(a.messages7d))} messages${live7dStr}${weeklyStr}`);
        const lastStr = a.lastActive
            ? chalk_1.default.dim(`  last: ${new Date(a.lastActive).toLocaleString()}`)
            : '';
        if (lastStr)
            console.log(`   ${lastStr}`);
        console.log();
    }
});
usageCmd
    .command('set-plan <account> <plan>')
    .description('Set the plan label for an account (e.g. "Max 5x", "Max 20x", "Pro")')
    .action((account, plan) => {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.name === account || p.commandName === account);
    if (!profile) {
        console.error(chalk_1.default.red(`Account '${account}' not found`));
        console.log(chalk_1.default.dim('Available: ' + profiles.map(p => p.name).join(', ')));
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
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.name === account || p.commandName === account);
    if (!profile) {
        console.error(chalk_1.default.red(`Account '${account}' not found`));
        process.exit(1);
    }
    (0, subscriptions_1.setMeta)(profile.commandName, { limits: { window5h: parseInt(limit5h), window7d: parseInt(limit7d) } });
    console.log(chalk_1.default.green(`✓ Limits set for ${profile.name}: 5h=${limit5h} 7d=${limit7d}`));
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
        console.error(chalk_1.default.red('Error:'), error.message);
        process.exit(1);
    }
});
// Update command - Self-update sweech
program
    .command('update')
    .description('Update sweech to the latest version from GitHub')
    .action(async () => {
    try {
        console.log(chalk_1.default.bold('\n🔄 Updating sweech...\n'));
        const { execSync: execSyncUpdate } = require('child_process');
        execSyncUpdate('npm install -g github:vykeai/sweech', { stdio: 'inherit' });
        console.log(chalk_1.default.green('\n✓ sweech updated successfully\n'));
    }
    catch (error) {
        console.error(chalk_1.default.red('Update failed:'), error.message);
        process.exit(1);
    }
});
// Resync command - re-apply shared symlinks for a profile
program
    .command('resync <command-name>')
    .description('Re-apply all shared symlinks for a profile (use after upgrading sweech)')
    .action((commandName) => {
    const config = new config_1.ConfigManager();
    const profile = config.getProfiles().find(p => p.commandName === commandName);
    if (!profile) {
        console.error(chalk_1.default.red(`Profile '${commandName}' not found`));
        process.exit(1);
    }
    if (!profile.sharedWith) {
        console.error(chalk_1.default.red(`Profile '${commandName}' is not in shared mode`));
        process.exit(1);
    }
    config.setupSharedDirs(commandName, profile.sharedWith);
    console.log(chalk_1.default.green(`✓ Symlinks resynced for ${commandName} → ${profile.sharedWith}\n`));
});
// Default action: interactive launcher when no command given
if (process.argv.length <= 2) {
    (0, launcher_1.runLauncher)().catch(err => {
        console.error(chalk_1.default.red('Error:'), err.message);
        process.exit(1);
    });
}
else {
    program.parse();
}
