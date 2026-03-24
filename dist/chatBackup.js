"use strict";
/**
 * Chat history backup functionality
 * Backs up conversation transcripts from CLI config directories
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
exports.getDirectorySize = getDirectorySize;
exports.formatBytes = formatBytes;
exports.hasChatData = hasChatData;
exports.backupChatHistory = backupChatHistory;
exports.getChatBackupInfo = getChatBackupInfo;
exports.confirmChatBackupBeforeRemoval = confirmChatBackupBeforeRemoval;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const archiver_1 = __importDefault(require("archiver"));
const crypto_1 = require("crypto");
const inquirer_1 = __importDefault(require("inquirer"));
const chalk_1 = __importDefault(require("chalk"));
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
/**
 * Get size of directory in bytes
 */
function getDirectorySize(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return 0;
    }
    let totalSize = 0;
    function calculateSize(currentPath) {
        const stats = fs.statSync(currentPath);
        if (stats.isFile()) {
            totalSize += stats.size;
        }
        else if (stats.isDirectory()) {
            const files = fs.readdirSync(currentPath);
            files.forEach(file => {
                calculateSize(path.join(currentPath, file));
            });
        }
    }
    calculateSize(dirPath);
    return totalSize;
}
/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes) {
    if (bytes === 0)
        return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
/**
 * Check if directory contains chat data
 */
function hasChatData(configDir) {
    if (!fs.existsSync(configDir)) {
        return false;
    }
    // Check for common chat data patterns
    const chatPatterns = [
        'projects/**/*.jsonl',
        'conversations/**/*',
        'history/**/*',
        'transcripts/**/*',
        '*.jsonl'
    ];
    function searchForChats(dir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    // Check directory names
                    if (['projects', 'conversations', 'history', 'transcripts'].includes(entry.name)) {
                        return true;
                    }
                    // Recurse
                    if (searchForChats(fullPath)) {
                        return true;
                    }
                }
                else if (entry.isFile()) {
                    // Check for .jsonl files (common for chat transcripts)
                    if (entry.name.endsWith('.jsonl')) {
                        return true;
                    }
                }
            }
        }
        catch {
            return false;
        }
        return false;
    }
    return searchForChats(configDir);
}
/**
 * Backup chat history for a profile
 */
async function backupChatHistory(profileName, configDir, outputFile) {
    if (!fs.existsSync(configDir)) {
        throw new Error(`Config directory not found: ${configDir}`);
    }
    // Get password
    const { password, confirmPassword } = await inquirer_1.default.prompt([
        {
            type: 'password',
            name: 'password',
            message: 'Enter backup password:',
            mask: '*',
            validate: (input) => {
                if (input.length < 8) {
                    return 'Password must be at least 8 characters';
                }
                return true;
            }
        },
        {
            type: 'password',
            name: 'confirmPassword',
            message: 'Confirm password:',
            mask: '*'
        }
    ]);
    if (password !== confirmPassword) {
        throw new Error('Passwords do not match');
    }
    // Generate output filename if not provided
    if (!outputFile) {
        const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
        outputFile = path.join(process.cwd(), `sweetch-chats-${profileName}-${timestamp}.zip`);
    }
    console.log(chalk_1.default.cyan('\n📦 Creating chat backup...\n'));
    // Get size info
    const size = getDirectorySize(configDir);
    console.log(chalk_1.default.gray(`Source: ${configDir}`));
    console.log(chalk_1.default.gray(`Size: ${formatBytes(size)}`));
    console.log(chalk_1.default.gray(`Output: ${outputFile}\n`));
    // Create ZIP archive
    const tempZip = outputFile + '.tmp';
    const output = fs.createWriteStream(tempZip);
    const archive = (0, archiver_1.default)('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    // Add the entire config directory
    archive.directory(configDir, false);
    await archive.finalize();
    await new Promise((resolve, reject) => {
        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
    });
    console.log(chalk_1.default.green('✓ Archive created'));
    // Encrypt the ZIP file
    console.log(chalk_1.default.cyan('🔒 Encrypting backup...'));
    const zipData = fs.readFileSync(tempZip);
    // Generate salt and IV
    const salt = (0, crypto_1.randomBytes)(SALT_LENGTH);
    const iv = (0, crypto_1.randomBytes)(IV_LENGTH);
    // Derive key from password
    const key = (0, crypto_1.pbkdf2Sync)(password, salt, 100000, 32, 'sha256');
    // Encrypt
    const cipher = (0, crypto_1.createCipheriv)(ENCRYPTION_ALGORITHM, key, iv);
    const encryptedData = Buffer.concat([cipher.update(zipData), cipher.final()]);
    // Write encrypted file with salt and IV prepended
    const finalData = Buffer.concat([salt, iv, encryptedData]);
    fs.writeFileSync(outputFile, finalData);
    // Clean up temp file
    fs.unlinkSync(tempZip);
    const finalSize = fs.statSync(outputFile).size;
    console.log(chalk_1.default.green(`\n✓ Backup created: ${outputFile}`));
    console.log(chalk_1.default.gray(`  Size: ${formatBytes(finalSize)}`));
    console.log(chalk_1.default.yellow('\n⚠️  Keep this password safe! It cannot be recovered.\n'));
    return outputFile;
}
/**
 * Get chat backup info without creating backup
 */
function getChatBackupInfo(configDir) {
    const exists = fs.existsSync(configDir);
    const hasChats = exists && hasChatData(configDir);
    const size = exists ? getDirectorySize(configDir) : 0;
    return {
        exists,
        hasChats,
        size,
        sizeFormatted: formatBytes(size)
    };
}
/**
 * Confirm chat backup before profile removal
 */
async function confirmChatBackupBeforeRemoval(profileName, configDir) {
    const info = getChatBackupInfo(configDir);
    if (!info.hasChats) {
        return true; // No chats to backup
    }
    console.log(chalk_1.default.yellow(`\n⚠️  This profile contains chat history (${info.sizeFormatted})`));
    console.log(chalk_1.default.gray('   Location: ' + configDir));
    const { action } = await inquirer_1.default.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'What would you like to do?',
            choices: [
                { name: 'Backup chats before removing', value: 'backup' },
                { name: 'Remove without backing up', value: 'remove' },
                { name: 'Cancel removal', value: 'cancel' }
            ]
        }
    ]);
    if (action === 'cancel') {
        return false;
    }
    if (action === 'backup') {
        try {
            await backupChatHistory(profileName, configDir);
            console.log(chalk_1.default.green('\n✓ Backup complete. Proceeding with removal...\n'));
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(chalk_1.default.red('\nBackup failed:', msg));
            const { proceed } = await inquirer_1.default.prompt([
                {
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Backup failed. Continue with removal anyway?',
                    default: false
                }
            ]);
            return proceed;
        }
    }
    return true;
}
