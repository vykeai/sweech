"use strict";
/**
 * Utility commands for sweetch
 * doctor, path, test, edit, clone, rename
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
exports.isInPath = isInPath;
exports.detectShell = detectShell;
exports.getShellRCFile = getShellRCFile;
exports.runDoctor = runDoctor;
exports.runPath = runPath;
exports.runTest = runTest;
exports.runEdit = runEdit;
exports.runClone = runClone;
exports.runRename = runRename;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const chalk_1 = __importDefault(require("chalk"));
const inquirer_1 = __importDefault(require("inquirer"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const config_1 = require("./config");
const clis_1 = require("./clis");
const providers_1 = require("./providers");
const cliDetection_1 = require("./cliDetection");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * Check if sweetch bin directory is in PATH
 */
function isInPath(binDir) {
    const pathEnv = process.env.PATH || '';
    const paths = pathEnv.split(path.delimiter);
    return paths.some(p => path.resolve(p) === path.resolve(binDir));
}
/**
 * Detect user's shell
 */
function detectShell() {
    const shell = process.env.SHELL || '';
    if (shell.includes('zsh'))
        return 'zsh';
    if (shell.includes('bash'))
        return 'bash';
    if (shell.includes('fish'))
        return 'fish';
    // Default to bash on Unix, cmd on Windows
    return process.platform === 'win32' ? 'cmd' : 'bash';
}
/**
 * Get shell RC file path
 */
function getShellRCFile() {
    const shell = detectShell();
    const home = os.homedir();
    const rcFiles = {
        zsh: path.join(home, '.zshrc'),
        bash: path.join(home, '.bashrc'),
        fish: path.join(home, '.config', 'fish', 'config.fish'),
        cmd: '' // Windows doesn't have RC file in same way
    };
    return rcFiles[shell] || path.join(home, '.bashrc');
}
/**
 * sweetch doctor - Health check
 */
async function runDoctor() {
    console.log(chalk_1.default.bold('\n🏥 Sweetch Health Check\n'));
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const binDir = config.getBinDir();
    // Check Node.js
    console.log(chalk_1.default.bold('Environment:'));
    try {
        const nodeVersion = process.version;
        console.log(chalk_1.default.green(`  ✓ Node.js: ${nodeVersion}`));
    }
    catch {
        console.log(chalk_1.default.red('  ✗ Node.js: Not detected'));
    }
    // Check sweetch version
    try {
        const packagePath = path.join(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
        console.log(chalk_1.default.green(`  ✓ sweetch: v${pkg.version}`));
    }
    catch {
        console.log(chalk_1.default.gray('  ✓ sweetch: Development version'));
    }
    // Check PATH
    console.log(chalk_1.default.bold('\nPATH Configuration:'));
    if (isInPath(binDir)) {
        const rcFile = getShellRCFile();
        console.log(chalk_1.default.green(`  ✓ ${binDir} is in PATH`));
        console.log(chalk_1.default.gray(`    Location: ${rcFile}`));
    }
    else {
        console.log(chalk_1.default.red(`  ✗ ${binDir} is NOT in PATH`));
        console.log(chalk_1.default.yellow(`    Run: ${chalk_1.default.bold('sweetch path')} for help`));
    }
    // Check installed CLIs
    console.log(chalk_1.default.bold('\nInstalled CLIs:'));
    const detectedCLIs = await (0, cliDetection_1.detectInstalledCLIs)();
    detectedCLIs.forEach(result => {
        if (result.installed) {
            const version = result.version ? ` (${result.version})` : '';
            console.log(chalk_1.default.green(`  ✓ ${result.cli.displayName}${version}`));
        }
        else {
            console.log(chalk_1.default.gray(`  ✗ ${result.cli.displayName}: Not installed`));
            if (result.cli.installUrl) {
                console.log(chalk_1.default.gray(`    Install: ${result.cli.installUrl}`));
            }
        }
    });
    // Check profiles
    console.log(chalk_1.default.bold(`\nProfiles (${profiles.length}):`));
    if (profiles.length === 0) {
        console.log(chalk_1.default.gray('  No profiles configured yet'));
        console.log(chalk_1.default.gray(`  Run: ${chalk_1.default.bold('sweetch add')} to add a provider`));
    }
    else {
        for (const profile of profiles) {
            const provider = (0, providers_1.getProvider)(profile.provider);
            const wrapperPath = path.join(binDir, profile.commandName);
            const profileDir = config.getProfileDir(profile.commandName);
            const settingsPath = path.join(profileDir, 'settings.json');
            const wrapperExists = fs.existsSync(wrapperPath);
            const wrapperExecutable = wrapperExists &&
                (fs.statSync(wrapperPath).mode & parseInt('111', 8)) !== 0;
            const configExists = fs.existsSync(settingsPath);
            const sharedTag = profile.sharedWith
                ? chalk_1.default.magenta(` [shared ↔ ${profile.sharedWith}]`)
                : '';
            if (wrapperExecutable && configExists) {
                console.log(chalk_1.default.green(`  ✓ ${profile.commandName} → ${provider?.displayName}`) + sharedTag);
            }
            else {
                console.log(chalk_1.default.yellow(`  ⚠ ${profile.commandName} → ${provider?.displayName}`) + sharedTag);
                if (!wrapperExists) {
                    console.log(chalk_1.default.gray(`    Missing wrapper script`));
                }
                else if (!wrapperExecutable) {
                    console.log(chalk_1.default.gray(`    Wrapper not executable`));
                }
                if (!configExists) {
                    console.log(chalk_1.default.gray(`    Missing config file`));
                }
            }
            // Check symlinks for profiles that share data with a master profile
            if (profile.sharedWith) {
                const masterDir = profile.sharedWith === 'claude'
                    ? path.join(os.homedir(), '.claude')
                    : config.getProfileDir(profile.sharedWith);
                console.log(chalk_1.default.gray(`    Shared symlinks (→ ${profile.sharedWith}):`));
                for (const dir of config_1.SHAREABLE_DIRS) {
                    const linkPath = path.join(profileDir, dir);
                    const expectedTarget = path.join(masterDir, dir);
                    let ok = false;
                    try {
                        const stat = fs.lstatSync(linkPath);
                        if (stat.isSymbolicLink()) {
                            const actual = fs.realpathSync(linkPath);
                            ok = actual === fs.realpathSync(expectedTarget);
                        }
                    }
                    catch {
                        ok = false;
                    }
                    if (ok) {
                        console.log(chalk_1.default.green(`      ✓ ${dir}`));
                    }
                    else {
                        console.log(chalk_1.default.red(`      ✗ ${dir}`));
                    }
                }
            }
        }
    }
    // Summary
    const hasIssues = !isInPath(binDir) ||
        profiles.some(p => {
            const wrapperPath = path.join(binDir, p.commandName);
            return !fs.existsSync(wrapperPath);
        });
    console.log();
    if (hasIssues) {
        console.log(chalk_1.default.yellow('⚠️  Some issues detected. See above for details.\n'));
    }
    else {
        console.log(chalk_1.default.green('✅ Everything looks good! 🎉\n'));
    }
}
/**
 * sweetch path - PATH configuration helper
 */
async function runPath() {
    console.log(chalk_1.default.bold('\n📍 PATH Configuration\n'));
    const config = new config_1.ConfigManager();
    const binDir = config.getBinDir();
    const inPath = isInPath(binDir);
    const shell = detectShell();
    const rcFile = getShellRCFile();
    if (inPath) {
        console.log(chalk_1.default.green(`Status: ✓ Configured`));
        console.log(chalk_1.default.gray(`  ${binDir} is in your PATH`));
        console.log(chalk_1.default.gray(`  Shell: ${shell}`));
        console.log();
        return;
    }
    console.log(chalk_1.default.yellow(`Status: ✗ Not configured`));
    console.log(chalk_1.default.gray(`  ${binDir} is not in your PATH\n`));
    console.log(chalk_1.default.bold('To use your commands, add this to your shell:\n'));
    const exportCmd = `export PATH="$HOME/.sweech/bin:$PATH"`;
    if (shell === 'zsh') {
        console.log(chalk_1.default.cyan(`  # For zsh (default on macOS)`));
        console.log(chalk_1.default.white(`  echo '${exportCmd}' >> ~/.zshrc`));
        console.log(chalk_1.default.white(`  source ~/.zshrc\n`));
    }
    else if (shell === 'bash') {
        console.log(chalk_1.default.cyan(`  # For bash`));
        console.log(chalk_1.default.white(`  echo '${exportCmd}' >> ~/.bashrc`));
        console.log(chalk_1.default.white(`  source ~/.bashrc\n`));
    }
    else if (shell === 'fish') {
        console.log(chalk_1.default.cyan(`  # For fish`));
        console.log(chalk_1.default.white(`  set -Ua fish_user_paths $HOME/.sweech/bin`));
        console.log(chalk_1.default.white(`  # Or add to ~/.config/fish/config.fish\n`));
    }
    // Offer to add automatically
    const { autoAdd } = await inquirer_1.default.prompt([
        {
            type: 'confirm',
            name: 'autoAdd',
            message: 'Would you like sweetch to add this automatically?',
            default: false
        }
    ]);
    if (autoAdd && rcFile) {
        try {
            // Check if already present
            if (fs.existsSync(rcFile)) {
                const content = fs.readFileSync(rcFile, 'utf-8');
                if (!content.includes('.sweech/bin')) {
                    fs.appendFileSync(rcFile, `\n# Added by sweetch\n${exportCmd}\n`);
                    console.log(chalk_1.default.green(`\n✓ Added to ${rcFile}`));
                    console.log(chalk_1.default.yellow(`\nRestart your terminal or run: ${chalk_1.default.bold(`source ${rcFile}`)}\n`));
                }
                else {
                    console.log(chalk_1.default.green(`\n✓ Already in ${rcFile}`));
                    console.log(chalk_1.default.yellow(`\nRestart your terminal or run: ${chalk_1.default.bold(`source ${rcFile}`)}\n`));
                }
            }
            else {
                fs.appendFileSync(rcFile, `\n# Added by sweetch\n${exportCmd}\n`);
                console.log(chalk_1.default.green(`\n✓ Added to ${rcFile}`));
                console.log(chalk_1.default.yellow(`\nRestart your terminal or run: ${chalk_1.default.bold(`source ${rcFile}`)}\n`));
            }
        }
        catch (error) {
            console.error(chalk_1.default.red(`\nFailed to update ${rcFile}:`, error.message));
            console.log(chalk_1.default.gray('Please add manually using the commands above.\n'));
        }
    }
}
/**
 * sweetch test - Test provider connection
 */
async function runTest(commandName) {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.commandName === commandName);
    if (!profile) {
        console.error(chalk_1.default.red(`\nProfile '${commandName}' not found\n`));
        process.exit(1);
    }
    const provider = (0, providers_1.getProvider)(profile.provider);
    const cli = (0, clis_1.getCLI)(profile.cliType);
    console.log(chalk_1.default.bold(`\n🧪 Testing ${commandName} (${provider?.displayName})...\n`));
    // Check configuration
    process.stdout.write(chalk_1.default.gray('Checking configuration...        '));
    const profileDir = config.getProfileDir(commandName);
    const settingsPath = path.join(profileDir, 'settings.json');
    const wrapperPath = path.join(config.getBinDir(), commandName);
    if (!fs.existsSync(settingsPath)) {
        console.log(chalk_1.default.red('✗'));
        console.error(chalk_1.default.red(`\nConfig file not found: ${settingsPath}\n`));
        process.exit(1);
    }
    if (!fs.existsSync(wrapperPath)) {
        console.log(chalk_1.default.red('✗'));
        console.error(chalk_1.default.red(`\nWrapper script not found: ${wrapperPath}\n`));
        process.exit(1);
    }
    console.log(chalk_1.default.green('✓'));
    // Test CLI installation
    process.stdout.write(chalk_1.default.gray('Checking CLI installation...     '));
    try {
        await execFileAsync(cli?.command || 'claude', ['--version'], { timeout: 5000 });
        console.log(chalk_1.default.green('✓'));
    }
    catch {
        console.log(chalk_1.default.red('✗'));
        console.error(chalk_1.default.red(`\n${cli?.displayName} is not installed or not in PATH\n`));
        process.exit(1);
    }
    // Note: We can't actually test the API without making a real request
    // which would require the CLI's authentication flow
    console.log(chalk_1.default.gray('Testing API connection...        ') + chalk_1.default.yellow('⊘ Skipped'));
    console.log(chalk_1.default.gray('  (Requires CLI authentication flow)\n'));
    console.log(chalk_1.default.green('✅ Configuration is valid!\n'));
    console.log(chalk_1.default.gray('Configuration:'));
    console.log(chalk_1.default.gray(`  Provider: ${provider?.displayName}`));
    console.log(chalk_1.default.gray(`  Model: ${profile.model}`));
    console.log(chalk_1.default.gray(`  Config: ${profileDir}`));
    console.log(chalk_1.default.gray(`  Wrapper: ${wrapperPath}\n`));
    console.log(chalk_1.default.cyan(`To use: ${chalk_1.default.bold(commandName)}\n`));
}
/**
 * sweetch edit - Edit profile configuration
 */
async function runEdit(commandName) {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.commandName === commandName);
    if (!profile) {
        console.error(chalk_1.default.red(`\nProfile '${commandName}' not found\n`));
        process.exit(1);
    }
    const provider = (0, providers_1.getProvider)(profile.provider);
    console.log(chalk_1.default.bold(`\n✏️  Edit ${commandName}\n`));
    console.log(chalk_1.default.gray('Current configuration:'));
    console.log(chalk_1.default.gray(`  Provider: ${provider?.displayName}`));
    console.log(chalk_1.default.gray(`  Model: ${profile.model}`));
    const authMethod = profile.oauth ? 'OAuth' : 'API Key';
    const authDisplay = profile.apiKey
        ? `API Key: ${profile.apiKey.substring(0, 10)}***`
        : `OAuth (${profile.oauth?.provider})`;
    console.log(chalk_1.default.gray(`  Auth: ${authDisplay}`));
    console.log();
    const { field } = await inquirer_1.default.prompt([
        {
            type: 'list',
            name: 'field',
            message: 'What would you like to edit?',
            choices: [
                { name: 'API Key', value: 'apiKey' },
                { name: 'Model', value: 'model' },
                { name: 'Base URL', value: 'baseUrl' },
                { name: 'Cancel', value: 'cancel' }
            ]
        }
    ]);
    if (field === 'cancel') {
        console.log(chalk_1.default.yellow('\nCancelled\n'));
        return;
    }
    let newValue;
    if (field === 'apiKey') {
        const answer = await inquirer_1.default.prompt([
            {
                type: 'password',
                name: 'value',
                message: 'Enter new API key:',
                mask: '*',
                validate: (input) => input.trim().length > 0 || 'API key required'
            }
        ]);
        newValue = answer.value.trim();
    }
    else if (field === 'model') {
        const answer = await inquirer_1.default.prompt([
            {
                type: 'input',
                name: 'value',
                message: 'Enter new model name:',
                default: profile.model,
                validate: (input) => input.trim().length > 0 || 'Model name required'
            }
        ]);
        newValue = answer.value.trim();
    }
    else if (field === 'baseUrl') {
        const answer = await inquirer_1.default.prompt([
            {
                type: 'input',
                name: 'value',
                message: 'Enter new base URL:',
                default: profile.baseUrl,
                validate: (input) => input.trim().length > 0 || 'Base URL required'
            }
        ]);
        newValue = answer.value.trim();
    }
    else {
        return;
    }
    // Update profile
    profile[field] = newValue;
    // Save to config.json
    const allProfiles = profiles.map(p => p.commandName === commandName ? profile : p);
    fs.writeFileSync(config.getConfigFile(), JSON.stringify(allProfiles, null, 2));
    // Update settings.json
    if (provider) {
        config.createProfileConfig(commandName, provider, profile.apiKey, profile.cliType);
    }
    console.log(chalk_1.default.green(`\n✓ Updated ${field} for ${commandName}\n`));
}
/**
 * sweetch clone - Clone an existing profile
 */
async function runClone(sourceName, targetName) {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const source = profiles.find(p => p.commandName === sourceName);
    if (!source) {
        console.error(chalk_1.default.red(`\nProfile '${sourceName}' not found\n`));
        process.exit(1);
    }
    if (profiles.some(p => p.commandName === targetName)) {
        console.error(chalk_1.default.red(`\nProfile '${targetName}' already exists\n`));
        process.exit(1);
    }
    console.log(chalk_1.default.bold(`\n📋 Cloning ${sourceName} → ${targetName}...\n`));
    const { useSameKey } = await inquirer_1.default.prompt([
        {
            type: 'confirm',
            name: 'useSameKey',
            message: 'Use same API key?',
            default: true
        }
    ]);
    let apiKey = source.apiKey;
    if (!useSameKey) {
        const answer = await inquirer_1.default.prompt([
            {
                type: 'password',
                name: 'apiKey',
                message: 'Enter API key for new profile:',
                mask: '*',
                validate: (input) => input.trim().length > 0 || 'API key required'
            }
        ]);
        apiKey = answer.apiKey.trim();
    }
    // Ask about sharing inheritance if source profile has sharedWith set
    let inheritSharedWith = undefined;
    if (source.sharedWith) {
        const { inheritShare } = await inquirer_1.default.prompt([
            {
                type: 'confirm',
                name: 'inheritShare',
                message: `Source profile shares data with ${source.sharedWith}. Should the clone also share with ${source.sharedWith}?`,
                default: false
            }
        ]);
        if (inheritShare) {
            inheritSharedWith = source.sharedWith;
        }
    }
    // Create new profile
    const newProfile = {
        ...source,
        name: targetName,
        commandName: targetName,
        apiKey,
        createdAt: new Date().toISOString(),
        sharedWith: inheritSharedWith
    };
    config.addProfile(newProfile);
    const provider = (0, providers_1.getProvider)(source.provider);
    const cli = (0, clis_1.getCLI)(source.cliType);
    if (provider && cli) {
        config.createProfileConfig(targetName, provider, apiKey, cli.name);
    }
    if (cli) {
        config.createWrapperScript(targetName, cli);
    }
    // Set up shared dirs if clone inherits sharing
    if (inheritSharedWith) {
        config.setupSharedDirs(targetName, inheritSharedWith);
    }
    console.log(chalk_1.default.green(`\n✓ Created ${targetName} (${provider?.displayName})\n`));
}
/**
 * sweetch rename - Rename a profile
 */
async function runRename(oldName, newName) {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.commandName === oldName);
    if (!profile) {
        console.error(chalk_1.default.red(`\nProfile '${oldName}' not found\n`));
        process.exit(1);
    }
    if (profiles.some(p => p.commandName === newName)) {
        console.error(chalk_1.default.red(`\nProfile '${newName}' already exists\n`));
        process.exit(1);
    }
    console.log(chalk_1.default.bold(`\n✏️  Renaming ${oldName} → ${newName}...\n`));
    // Remove old
    const oldProfileDir = config.getProfileDir(oldName);
    const oldWrapperPath = path.join(config.getBinDir(), oldName);
    // Update profile
    profile.name = newName;
    profile.commandName = newName;
    // Save updated profiles
    const updatedProfiles = profiles.map(p => p.commandName === oldName ? profile : p);
    fs.writeFileSync(config.getConfigFile(), JSON.stringify(updatedProfiles, null, 2));
    // Rename profile directory
    const newProfileDir = config.getProfileDir(newName);
    if (fs.existsSync(oldProfileDir)) {
        fs.renameSync(oldProfileDir, newProfileDir);
    }
    // Remove old wrapper and create new one
    if (fs.existsSync(oldWrapperPath)) {
        fs.unlinkSync(oldWrapperPath);
    }
    const cli = (0, clis_1.getCLI)(profile.cliType);
    if (cli) {
        config.createWrapperScript(newName, cli);
    }
    console.log(chalk_1.default.green(`✓ Renamed ${oldName} → ${newName}\n`));
    console.log(chalk_1.default.gray('  Command: ' + newName));
    console.log(chalk_1.default.gray('  Config: ' + newProfileDir));
    console.log();
}
