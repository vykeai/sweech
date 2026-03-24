"use strict";
/**
 * Reset/uninstall sweetch
 * Removes all sweetch-managed profiles while protecting default CLI setups
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
exports.isDefaultCLIDirectory = isDefaultCLIDirectory;
exports.isDefaultProfile = isDefaultProfile;
exports.runReset = runReset;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const chalk_1 = __importDefault(require("chalk"));
const inquirer_1 = __importDefault(require("inquirer"));
const config_1 = require("./config");
const providers_1 = require("./providers");
const backup_1 = require("./backup");
/**
 * Get default config directories for known CLIs
 * These should NEVER be touched by sweetch reset
 */
function getDefaultCLIDirectories() {
    const home = os.homedir();
    return [
        path.join(home, '.claude'), // Claude Code default
        path.join(home, '.codex'), // Codex default
        path.join(home, '.config', 'claude'), // Alt Claude location
    ];
}
/**
 * Check if a directory is a default CLI directory
 */
function isDefaultCLIDirectory(dirPath) {
    const normalized = path.resolve(dirPath);
    const defaults = getDefaultCLIDirectories().map(d => path.resolve(d));
    return defaults.includes(normalized);
}
/**
 * Check if a profile is using a default CLI directory
 */
function isDefaultProfile(profileName, configDir) {
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
async function runReset() {
    console.log(chalk_1.default.bold.red('\n⚠️  Sweetch Reset (Uninstall)\n'));
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const sweetchDir = config.getConfigDir();
    const binDir = config.getBinDir();
    // Show what will be affected
    console.log(chalk_1.default.bold('Your setup:'));
    if (profiles.length === 0) {
        console.log(chalk_1.default.gray('  No profiles configured\n'));
    }
    else {
        profiles.forEach(profile => {
            const provider = (0, providers_1.getProvider)(profile.provider);
            const profileDir = config.getProfileDir(profile.commandName);
            const isDefault = isDefaultCLIDirectory(profileDir);
            if (isDefault) {
                console.log(chalk_1.default.gray(`  • ${profile.commandName} (${provider?.displayName}) [DEFAULT - will be preserved]`));
            }
            else {
                console.log(chalk_1.default.cyan(`  • ${profile.commandName} (${provider?.displayName})`));
            }
        });
        console.log();
    }
    console.log(chalk_1.default.bold('This will NOT affect:'));
    const defaultDirs = getDefaultCLIDirectories().filter(d => fs.existsSync(d));
    if (defaultDirs.length > 0) {
        defaultDirs.forEach(dir => {
            console.log(chalk_1.default.green(`  ✓ ${dir} (default CLI setup)`));
        });
    }
    else {
        console.log(chalk_1.default.green('  ✓ All default CLI configurations (~/.claude/, ~/.codex/, etc.)'));
    }
    console.log(chalk_1.default.green('  ✓ Installed CLIs (claude, codex, etc.)'));
    console.log();
    console.log(chalk_1.default.bold('This will remove:'));
    console.log(chalk_1.default.red(`  ✗ ${sweetchDir}/ (sweetch configuration)`));
    console.log(chalk_1.default.red(`  ✗ ${binDir}/ (wrapper scripts)`));
    console.log(chalk_1.default.red('  ✗ All sweetch-managed profiles'));
    console.log(chalk_1.default.red('  ✗ Usage statistics'));
    console.log(chalk_1.default.red('  ✗ Aliases'));
    console.log();
    // Offer backup
    const { createBackup } = await inquirer_1.default.prompt([
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
            await (0, backup_1.backupSweetch)();
            console.log();
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(chalk_1.default.red('Backup failed:', msg));
            const { continueAnyway } = await inquirer_1.default.prompt([
                {
                    type: 'confirm',
                    name: 'continueAnyway',
                    message: 'Backup failed. Continue with reset anyway?',
                    default: false
                }
            ]);
            if (!continueAnyway) {
                console.log(chalk_1.default.yellow('\nReset cancelled\n'));
                return;
            }
        }
    }
    // Final confirmation
    const { confirmReset } = await inquirer_1.default.prompt([
        {
            type: 'input',
            name: 'confirmReset',
            message: `Type "reset" to confirm complete uninstall:`,
            validate: (input) => {
                if (input.toLowerCase() === 'reset') {
                    return true;
                }
                return 'Please type "reset" to confirm';
            }
        }
    ]);
    if (confirmReset.toLowerCase() !== 'reset') {
        console.log(chalk_1.default.yellow('\nReset cancelled\n'));
        return;
    }
    console.log(chalk_1.default.cyan('\n🗑️  Removing sweetch...\n'));
    // Remove sweetch directory
    if (fs.existsSync(sweetchDir)) {
        try {
            fs.rmSync(sweetchDir, { recursive: true, force: true });
            console.log(chalk_1.default.green(`  ✓ Removed ${sweetchDir}`));
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(chalk_1.default.red(`  ✗ Failed to remove ${sweetchDir}:`, msg));
        }
    }
    // Note about PATH
    console.log();
    console.log(chalk_1.default.yellow('⚠️  Note: You may want to remove sweetch from your PATH'));
    console.log(chalk_1.default.gray(`   Remove this line from your shell RC file (~/.zshrc or ~/.bashrc):`));
    console.log(chalk_1.default.gray(`   export PATH="$HOME/.sweech/bin:$PATH"`));
    console.log();
    console.log(chalk_1.default.green('✓ Sweetch has been uninstalled\n'));
    console.log(chalk_1.default.gray('Your default CLI configurations remain untouched.'));
    console.log(chalk_1.default.gray('To reinstall: npm install -g sweetch\n'));
}
