"use strict";
/**
 * Interactive onboarding for first-time Sweech setup
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
exports.runInit = runInit;
const chalk_1 = __importDefault(require("chalk"));
const inquirer_1 = __importDefault(require("inquirer"));
const config_1 = require("./config");
const interactive_1 = require("./interactive");
const providers_1 = require("./providers");
const clis_1 = require("./clis");
const utilityCommands_1 = require("./utilityCommands");
const cliDetection_1 = require("./cliDetection");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
/**
 * Check if sweech bin directory is in PATH
 */
function isInPath() {
    const binDir = path.join(os.homedir(), '.sweech', 'bin');
    const pathEnv = process.env.PATH || '';
    return pathEnv.split(path.delimiter).some(p => path.resolve(p) === binDir);
}
/**
 * Detect which shell the user is using
 */
function detectShell() {
    const shell = process.env.SHELL || '';
    if (shell.includes('zsh'))
        return 'zsh';
    if (shell.includes('bash'))
        return 'bash';
    if (shell.includes('fish'))
        return 'fish';
    // Default to bash
    return 'bash';
}
/**
 * Get the shell RC file path
 */
function getShellRcFile(shell) {
    const home = os.homedir();
    switch (shell) {
        case 'zsh':
            return path.join(home, '.zshrc');
        case 'bash':
            // Check for .bashrc first, then .bash_profile
            const bashrc = path.join(home, '.bashrc');
            const bashProfile = path.join(home, '.bash_profile');
            return fs.existsSync(bashrc) ? bashrc : bashProfile;
        case 'fish':
            return path.join(home, '.config', 'fish', 'config.fish');
        default:
            return path.join(home, '.bashrc');
    }
}
/**
 * Interactive onboarding flow
 */
async function runInit() {
    console.log(chalk_1.default.bold.cyan('\n🍭 Welcome to Sweech!\n'));
    console.log('Let\'s get you set up with your first AI provider.\n');
    const config = new config_1.ConfigManager();
    const existingProfiles = config.getProfiles();
    // Check if already configured
    if (existingProfiles.length > 0) {
        console.log(chalk_1.default.yellow('⚠️  You already have providers configured:\n'));
        existingProfiles.forEach(profile => {
            console.log(chalk_1.default.gray(`  • ${profile.commandName}`));
        });
        console.log();
        const { continueAnyway } = await inquirer_1.default.prompt([
            {
                type: 'confirm',
                name: 'continueAnyway',
                message: 'Would you like to add another provider?',
                default: true
            }
        ]);
        if (!continueAnyway) {
            console.log(chalk_1.default.green('\n✓ You\'re all set! Run `sweech list` to see your providers.\n'));
            return;
        }
        console.log();
    }
    // Step 1: Check PATH
    if (!isInPath()) {
        console.log(chalk_1.default.bold('Step 1: Add Sweech to your PATH\n'));
        const shell = detectShell();
        const rcFile = getShellRcFile(shell);
        const pathLine = 'export PATH="$HOME/.sweech/bin:$PATH"';
        console.log(chalk_1.default.yellow('⚠️  Sweech bin directory is not in your PATH yet.\n'));
        console.log('To use your providers, add this to your shell configuration:\n');
        console.log(chalk_1.default.cyan(`  ${pathLine}\n`));
        console.log(chalk_1.default.gray(`Add to: ${rcFile}\n`));
        const { addToPath } = await inquirer_1.default.prompt([
            {
                type: 'confirm',
                name: 'addToPath',
                message: 'Would you like me to add it automatically?',
                default: true
            }
        ]);
        if (addToPath) {
            try {
                // Check if already present
                if (fs.existsSync(rcFile)) {
                    const content = fs.readFileSync(rcFile, 'utf-8');
                    if (!content.includes('.sweech/bin')) {
                        fs.appendFileSync(rcFile, `\n# Sweech\n${pathLine}\n`);
                        console.log(chalk_1.default.green(`\n✓ Added to ${rcFile}`));
                        console.log(chalk_1.default.yellow('\n⚠️  Restart your terminal or run:'));
                        console.log(chalk_1.default.cyan(`  source ${rcFile}\n`));
                    }
                    else {
                        console.log(chalk_1.default.green('\n✓ Already in PATH\n'));
                    }
                }
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                console.error(chalk_1.default.red(`\n✗ Failed to update ${rcFile}:`, msg));
                console.log(chalk_1.default.yellow('\nPlease add it manually.\n'));
            }
        }
        else {
            console.log(chalk_1.default.yellow('\n⚠️  Remember to add it to your PATH manually!\n'));
        }
    }
    else {
        console.log(chalk_1.default.green('✓ Sweech is in your PATH\n'));
    }
    // Step 2: Check installed CLIs
    console.log(chalk_1.default.bold('Step 2: Detect installed CLIs\n'));
    const detectionResults = await (0, cliDetection_1.detectInstalledCLIs)();
    const anyInstalled = detectionResults.some(r => r.installed);
    for (const result of detectionResults) {
        if (result.installed) {
            const version = result.version ? chalk_1.default.gray(` (${result.version})`) : '';
            console.log(chalk_1.default.green(`✓ ${result.cli.displayName} detected${version}`));
        }
        else {
            console.log(chalk_1.default.gray(`○ ${result.cli.displayName} not found`));
            if (result.cli.installUrl) {
                console.log(chalk_1.default.gray(`  Install: ${result.cli.installUrl}`));
            }
        }
    }
    if (!anyInstalled) {
        console.log(chalk_1.default.yellow('\n⚠️  No supported CLIs found!'));
        console.log('You\'ll need to install Claude Code or Codex to use Sweech.\n');
        const { installLater } = await inquirer_1.default.prompt([
            {
                type: 'confirm',
                name: 'installLater',
                message: 'Continue anyway? (You can configure providers later)',
                default: false
            }
        ]);
        if (!installLater) {
            console.log(chalk_1.default.yellow('\nInstall a CLI first, then run `sweech init` again.\n'));
            return;
        }
    }
    console.log();
    // Step 3: Add first provider
    console.log(chalk_1.default.bold('Step 3: Add your first provider\n'));
    try {
        const answers = await (0, interactive_1.interactiveAddProvider)(existingProfiles);
        const provider = answers.customProviderConfig || (0, providers_1.getProvider)(answers.provider);
        if (!provider) {
            console.error(chalk_1.default.red(`\n✗ Provider '${answers.provider}' not found`));
            return;
        }
        const cli = (0, clis_1.getCLI)(answers.cliType);
        if (!cli) {
            console.error(chalk_1.default.red(`\n✗ CLI '${answers.cliType}' not found`));
            return;
        }
        // Create profile with OAuth or API key
        const { createProfile } = await Promise.resolve().then(() => __importStar(require('./profileCreation')));
        await createProfile(answers, provider, cli, config);
        console.log();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk_1.default.red('\n✗ Setup failed:', msg));
        return;
    }
    // Step 4: Verify setup
    console.log(chalk_1.default.bold('Step 4: Verify installation\n'));
    const { runDoctorCheck } = await inquirer_1.default.prompt([
        {
            type: 'confirm',
            name: 'runDoctorCheck',
            message: 'Run health check to verify everything works?',
            default: true
        }
    ]);
    if (runDoctorCheck) {
        console.log();
        await (0, utilityCommands_1.runDoctor)();
    }
    // Final summary
    console.log(chalk_1.default.bold.green('\n🎉 Setup complete!\n'));
    console.log(chalk_1.default.bold('Next steps:\n'));
    if (!isInPath()) {
        console.log(chalk_1.default.yellow('1. Restart your terminal or run:'));
        const shell = detectShell();
        const rcFile = getShellRcFile(shell);
        console.log(chalk_1.default.cyan(`   source ${rcFile}\n`));
    }
    const profiles = config.getProfiles();
    if (profiles.length > 0) {
        const firstProfile = profiles[0];
        console.log(chalk_1.default.cyan(`2. Try your new command:`));
        console.log(chalk_1.default.bold.cyan(`   ${firstProfile.commandName}\n`));
    }
    console.log(chalk_1.default.gray('3. Add more providers:'));
    console.log(chalk_1.default.gray('   sweech add\n'));
    console.log(chalk_1.default.gray('4. View all providers:'));
    console.log(chalk_1.default.gray('   sweech list\n'));
    console.log(chalk_1.default.gray('Happy sweeching! 🍭\n'));
}
