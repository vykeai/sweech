/**
 * Chat history backup functionality
 * Backs up conversation transcripts from CLI config directories
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import archiver from 'archiver';
import { createCipheriv, randomBytes, pbkdf2Sync } from 'crypto';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { ProfileConfig } from './config';

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;

/**
 * Get size of directory in bytes
 */
export function getDirectorySize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }

  let totalSize = 0;

  function calculateSize(currentPath: string) {
    const stats = fs.statSync(currentPath);

    if (stats.isFile()) {
      totalSize += stats.size;
    } else if (stats.isDirectory()) {
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
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Check if directory contains chat data
 */
export function hasChatData(configDir: string): boolean {
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

  function searchForChats(dir: string): boolean {
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
        } else if (entry.isFile()) {
          // Check for .jsonl files (common for chat transcripts)
          if (entry.name.endsWith('.jsonl')) {
            return true;
          }
        }
      }
    } catch {
      return false;
    }

    return false;
  }

  return searchForChats(configDir);
}

/**
 * Backup chat history for a profile
 */
export async function backupChatHistory(
  profileName: string,
  configDir: string,
  outputFile?: string
): Promise<string> {
  if (!fs.existsSync(configDir)) {
    throw new Error(`Config directory not found: ${configDir}`);
  }

  // Get password
  const { password, confirmPassword } = await inquirer.prompt([
    {
      type: 'password',
      name: 'password',
      message: 'Enter backup password:',
      mask: '*',
      validate: (input: string) => {
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

  console.log(chalk.cyan('\n📦 Creating chat backup...\n'));

  // Get size info
  const size = getDirectorySize(configDir);
  console.log(chalk.gray(`Source: ${configDir}`));
  console.log(chalk.gray(`Size: ${formatBytes(size)}`));
  console.log(chalk.gray(`Output: ${outputFile}\n`));

  // Create ZIP archive
  const tempZip = outputFile + '.tmp';
  const output = fs.createWriteStream(tempZip);
  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.pipe(output);

  // Add the entire config directory
  archive.directory(configDir, false);

  await archive.finalize();

  await new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
  });

  console.log(chalk.green('✓ Archive created'));

  // Encrypt the ZIP file
  console.log(chalk.cyan('🔒 Encrypting backup...'));

  const zipData = fs.readFileSync(tempZip);

  // Generate salt and IV
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);

  // Derive key from password
  const key = pbkdf2Sync(password, salt, 100000, 32, 'sha256');

  // Encrypt
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encryptedData = Buffer.concat([cipher.update(zipData), cipher.final()]);

  // Write encrypted file with salt and IV prepended
  const finalData = Buffer.concat([salt, iv, encryptedData]);
  fs.writeFileSync(outputFile, finalData);

  // Clean up temp file
  fs.unlinkSync(tempZip);

  const finalSize = fs.statSync(outputFile).size;
  console.log(chalk.green(`\n✓ Backup created: ${outputFile}`));
  console.log(chalk.gray(`  Size: ${formatBytes(finalSize)}`));
  console.log(chalk.yellow('\n⚠️  Keep this password safe! It cannot be recovered.\n'));

  return outputFile;
}

/**
 * Get chat backup info without creating backup
 */
export function getChatBackupInfo(configDir: string): {
  exists: boolean;
  hasChats: boolean;
  size: number;
  sizeFormatted: string;
} {
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
export async function confirmChatBackupBeforeRemoval(
  profileName: string,
  configDir: string
): Promise<boolean> {
  const info = getChatBackupInfo(configDir);

  if (!info.hasChats) {
    return true; // No chats to backup
  }

  console.log(chalk.yellow(`\n⚠️  This profile contains chat history (${info.sizeFormatted})`));
  console.log(chalk.gray('   Location: ' + configDir));

  const { action } = await inquirer.prompt([
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
      console.log(chalk.green('\n✓ Backup complete. Proceeding with removal...\n'));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('\nBackup failed:', msg));
      const { proceed } = await inquirer.prompt([
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
