"use strict";
/**
 * Backup and restore functionality for sweetch configurations
 * Creates password-protected ZIP files containing all profiles and settings
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
exports.backupSweetch = backupSweetch;
exports.backupClaude = backupClaude;
exports.restoreSweetch = restoreSweetch;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const archiver_1 = __importDefault(require("archiver"));
const unzipper_1 = __importDefault(require("unzipper"));
const inquirer_1 = __importDefault(require("inquirer"));
const chalk_1 = __importDefault(require("chalk"));
const config_1 = require("./config");
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
/**
 * Encrypt data with password
 */
function encrypt(data, password) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    // Combine salt + iv + encrypted data
    return Buffer.concat([salt, iv, encrypted]);
}
/**
 * Decrypt data with password
 */
function decrypt(data, password) {
    const salt = data.slice(0, SALT_LENGTH);
    const iv = data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const encrypted = data.slice(SALT_LENGTH + IV_LENGTH);
    const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
/**
 * Create a backup of the sweetch configuration
 */
async function backupSweetch(outputFile) {
    const config = new config_1.ConfigManager();
    const profiles = config.getProfiles();
    if (profiles.length === 0) {
        console.log(chalk_1.default.yellow('\n⚠️  No providers configured. Nothing to backup.\n'));
        return;
    }
    // Ask for password
    const { password } = await inquirer_1.default.prompt([
        {
            type: 'password',
            name: 'password',
            message: 'Enter password to encrypt backup:',
            mask: '*',
            validate: (input) => {
                if (!input || input.length < 6) {
                    return 'Password must be at least 6 characters';
                }
                return true;
            }
        }
    ]);
    const { confirmPassword } = await inquirer_1.default.prompt([
        {
            type: 'password',
            name: 'confirmPassword',
            message: 'Confirm password:',
            mask: '*',
            validate: (input) => {
                if (input !== password) {
                    return 'Passwords do not match';
                }
                return true;
            }
        }
    ]);
    // Generate output filename
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const defaultOutput = `sweetch-backup-${timestamp}.zip`;
    const finalOutput = outputFile || defaultOutput;
    console.log(chalk_1.default.cyan('\n🍭 Creating backup...\n'));
    // Create temporary unencrypted zip
    const tempZip = path.join('/tmp', `sweetch-temp-${Date.now()}.zip`);
    const output = fs.createWriteStream(tempZip);
    const archive = (0, archiver_1.default)('zip', {
        zlib: { level: 9 }
    });
    output.on('close', async () => {
        try {
            // Encrypt the zip file
            const zipData = fs.readFileSync(tempZip);
            const encrypted = encrypt(zipData, password);
            fs.writeFileSync(finalOutput, encrypted);
            // Clean up temp file
            fs.unlinkSync(tempZip);
            console.log(chalk_1.default.green('✓ Backup created successfully!\n'));
            console.log(chalk_1.default.cyan('File:'), path.resolve(finalOutput));
            console.log(chalk_1.default.cyan('Size:'), (encrypted.length / 1024).toFixed(2) + ' KB');
            console.log(chalk_1.default.cyan('Profiles:'), profiles.length);
            console.log();
            console.log(chalk_1.default.yellow('⚠️  Keep this backup and password safe!'));
            console.log(chalk_1.default.yellow('   You\'ll need them to restore on a new machine.\n'));
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(chalk_1.default.red('Encryption failed:'), msg);
            if (fs.existsSync(tempZip)) {
                fs.unlinkSync(tempZip);
            }
            throw error;
        }
    });
    archive.on('error', (err) => {
        throw err;
    });
    archive.pipe(output);
    // Add all profiles
    archive.directory(config.getProfilesDir(), 'profiles');
    // Add config file
    archive.file(config.getConfigFile(), { name: 'config.json' });
    // Add bin directory (wrapper scripts)
    archive.directory(config.getBinDir(), 'bin');
    await archive.finalize();
}
/**
 * Backup ~/.claude/ to a plain zip, excluding noise
 */
async function backupClaude(outputFile) {
    const claudeDir = path.join(require('os').homedir(), '.claude');
    if (!fs.existsSync(claudeDir)) {
        throw new Error('~/.claude/ not found');
    }
    const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const finalOutput = outputFile || `claude-backup-${timestamp}.zip`;
    console.log(chalk_1.default.cyan('\n🍭 Backing up ~/.claude/ ...\n'));
    const output = fs.createWriteStream(finalOutput);
    const archive = (0, archiver_1.default)('zip', { zlib: { level: 6 } });
    // Dirs to include explicitly (avoids noise at the top level)
    const includeDirs = [
        'commands', 'hooks', 'agents', 'plans', 'todos', 'tasks', 'teams',
    ];
    // Files to include at the top level
    const includeFiles = [
        'settings.json', 'CLAUDE.md', 'mcp.json', 'history.jsonl',
    ];
    await new Promise((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        // Include known-good dirs
        for (const dir of includeDirs) {
            const full = path.join(claudeDir, dir);
            if (fs.existsSync(full)) {
                archive.directory(full, dir);
            }
        }
        // Include top-level files
        for (const file of includeFiles) {
            const full = path.join(claudeDir, file);
            if (fs.existsSync(full)) {
                archive.file(full, { name: file });
            }
        }
        // Include projects/ but skip temp/worktree dirs
        const projectsDir = path.join(claudeDir, 'projects');
        if (fs.existsSync(projectsDir)) {
            const entries = fs.readdirSync(projectsDir);
            for (const entry of entries) {
                // Skip private tmp dirs, var folders, worktrees, bare `-` dir
                if (entry === '-' || entry.startsWith('-private-') || entry.includes('worktree'))
                    continue;
                const full = path.join(projectsDir, entry);
                if (fs.statSync(full).isDirectory()) {
                    archive.directory(full, `projects/${entry}`);
                }
            }
        }
        archive.finalize();
    });
    const size = (fs.statSync(finalOutput).size / 1024 / 1024).toFixed(2);
    console.log(chalk_1.default.green('✓ Backup created\n'));
    console.log(chalk_1.default.cyan('File:'), path.resolve(finalOutput));
    console.log(chalk_1.default.cyan('Size:'), `${size} MB`);
    console.log();
}
/**
 * Restore sweetch configuration from a backup
 */
async function restoreSweetch(backupFile) {
    if (!fs.existsSync(backupFile)) {
        throw new Error(`Backup file not found: ${backupFile}`);
    }
    const config = new config_1.ConfigManager();
    const existingProfiles = config.getProfiles();
    // Warn if there are existing profiles
    if (existingProfiles.length > 0) {
        console.log(chalk_1.default.yellow('\n⚠️  Warning: You have existing providers configured:'));
        existingProfiles.forEach(p => {
            console.log(chalk_1.default.gray(`   - ${p.commandName}`));
        });
        console.log();
        const { confirmOverwrite } = await inquirer_1.default.prompt([
            {
                type: 'confirm',
                name: 'confirmOverwrite',
                message: 'This will overwrite existing configurations. Continue?',
                default: false
            }
        ]);
        if (!confirmOverwrite) {
            console.log(chalk_1.default.yellow('Cancelled'));
            return;
        }
    }
    // Ask for password
    const { password } = await inquirer_1.default.prompt([
        {
            type: 'password',
            name: 'password',
            message: 'Enter backup password:',
            mask: '*',
            validate: (input) => {
                if (!input) {
                    return 'Password is required';
                }
                return true;
            }
        }
    ]);
    console.log(chalk_1.default.cyan('\n🍭 Restoring backup...\n'));
    try {
        // Decrypt the backup
        const encryptedData = fs.readFileSync(backupFile);
        const decryptedData = decrypt(encryptedData, password);
        // Write decrypted zip to temp file
        const tempZip = path.join('/tmp', `sweetch-restore-${Date.now()}.zip`);
        fs.writeFileSync(tempZip, decryptedData);
        // Extract zip to config directory
        const configDir = config.getConfigDir();
        await fs.createReadStream(tempZip)
            .pipe(unzipper_1.default.Extract({ path: configDir }))
            .promise();
        // Make all bin scripts executable
        const binDir = config.getBinDir();
        if (fs.existsSync(binDir)) {
            const files = fs.readdirSync(binDir);
            files.forEach(file => {
                const filePath = path.join(binDir, file);
                fs.chmodSync(filePath, 0o755);
            });
        }
        // Clean up temp file
        fs.unlinkSync(tempZip);
        const restoredProfiles = config.getProfiles();
        console.log(chalk_1.default.green('✓ Backup restored successfully!\n'));
        console.log(chalk_1.default.cyan('Profiles restored:'), restoredProfiles.length);
        restoredProfiles.forEach(p => {
            console.log(chalk_1.default.gray(`   - ${p.commandName}`));
        });
        console.log();
        console.log(chalk_1.default.yellow('⚠️  Make sure ~/.sweech/bin is in your PATH:'));
        console.log(chalk_1.default.gray(`   export PATH="${binDir}:$PATH"`));
        console.log();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('Bad decrypt')) {
            throw new Error('Incorrect password or corrupted backup file');
        }
        throw error;
    }
}
