/**
 * Backup and restore functionality for sweetch configurations
 * Creates password-protected ZIP files containing all profiles and settings
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import archiver from 'archiver';
import unzipper from 'unzipper';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { ConfigManager } from './config';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 600000; // OWASP 2024 recommendation for SHA-256

/**
 * Encrypt data with password using AES-256-GCM (authenticated encryption)
 */
function encrypt(data: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Combine salt + iv + authTag + encrypted data
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt data with password using AES-256-GCM (authenticated encryption)
 * Throws if auth tag verification fails (detects tampering)
 *
 * Backward compatible: tries the current iteration count (600k) first,
 * then falls back to the legacy count (100k) for older backups.
 */
function decrypt(data: Buffer, password: string): Buffer {
  const salt = data.slice(0, SALT_LENGTH);
  const iv = data.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.slice(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.slice(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  if (authTag.length < AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted data: missing auth tag');
  }

  // Try current iteration count first, then legacy for backward compatibility
  const iterationsToTry = [PBKDF2_ITERATIONS, 100000];

  for (const iterations of iterationsToTry) {
    const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    try {
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch {
      // Auth tag mismatch — try next iteration count
      continue;
    }
  }

  throw new Error('Decryption failed: incorrect password or tampered data');
}

/**
 * Create a backup of the sweetch configuration
 */
export async function backupSweetch(outputFile?: string): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();

  if (profiles.length === 0) {
    console.log(chalk.yellow('\n⚠️  No providers configured. Nothing to backup.\n'));
    return;
  }

  // Ask for password
  const { password } = await inquirer.prompt([
    {
      type: 'password',
      name: 'password',
      message: 'Enter password to encrypt backup:',
      mask: '*',
      validate: (input: string) => {
        if (!input || input.length < 12) {
          return 'Password must be at least 12 characters';
        }
        return true;
      }
    }
  ]);

  const { confirmPassword } = await inquirer.prompt([
    {
      type: 'password',
      name: 'confirmPassword',
      message: 'Confirm password:',
      mask: '*',
      validate: (input: string) => {
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

  console.log(chalk.cyan('\n🍭 Creating backup...\n'));

  // Create temporary unencrypted zip
  const tempZip = path.join('/tmp', `sweetch-temp-${Date.now()}.zip`);

  const output = fs.createWriteStream(tempZip);
  const archive = archiver('zip', {
    zlib: { level: 9 }
  });

  output.on('close', async () => {
    try {
      // Encrypt the zip file
      const zipData = fs.readFileSync(tempZip);
      const encrypted = encrypt(zipData, password);
      fs.writeFileSync(finalOutput, encrypted);
      fs.chmodSync(finalOutput, 0o600);

      // Clean up temp file
      fs.unlinkSync(tempZip);

      console.log(chalk.green('✓ Backup created successfully!\n'));
      console.log(chalk.cyan('File:'), path.resolve(finalOutput));
      console.log(chalk.cyan('Size:'), (encrypted.length / 1024).toFixed(2) + ' KB');
      console.log(chalk.cyan('Profiles:'), profiles.length);
      console.log();
      console.log(chalk.yellow('⚠️  Keep this backup and password safe!'));
      console.log(chalk.yellow('   You\'ll need them to restore on a new machine.\n'));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red('Encryption failed:'), msg);
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
export async function backupClaude(outputFile?: string): Promise<void> {
  const claudeDir = path.join(require('os').homedir(), '.claude');

  if (!fs.existsSync(claudeDir)) {
    throw new Error('~/.claude/ not found');
  }

  const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const finalOutput = outputFile || `claude-backup-${timestamp}.zip`;

  console.log(chalk.cyan('\n🍭 Backing up ~/.claude/ ...\n'));

  const output = fs.createWriteStream(finalOutput);
  const archive = archiver('zip', { zlib: { level: 6 } });

  // Dirs to include explicitly (avoids noise at the top level)
  const includeDirs = [
    'commands', 'hooks', 'agents', 'plans', 'todos', 'tasks', 'teams',
  ];

  // Files to include at the top level
  const includeFiles = [
    'settings.json', 'CLAUDE.md', 'mcp.json', 'history.jsonl',
  ];

  await new Promise<void>((resolve, reject) => {
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
        if (entry === '-' || entry.startsWith('-private-') || entry.includes('worktree')) continue;
        const full = path.join(projectsDir, entry);
        if (fs.statSync(full).isDirectory()) {
          archive.directory(full, `projects/${entry}`);
        }
      }
    }

    archive.finalize();
  });

  const size = (fs.statSync(finalOutput).size / 1024 / 1024).toFixed(2);
  console.log(chalk.green('✓ Backup created\n'));
  console.log(chalk.cyan('File:'), path.resolve(finalOutput));
  console.log(chalk.cyan('Size:'), `${size} MB`);
  console.log();
}

/**
 * Restore sweetch configuration from a backup
 */
export async function restoreSweetch(backupFile: string): Promise<void> {
  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }

  const config = new ConfigManager();
  const existingProfiles = config.getProfiles();

  // Warn if there are existing profiles
  if (existingProfiles.length > 0) {
    console.log(chalk.yellow('\n⚠️  Warning: You have existing providers configured:'));
    existingProfiles.forEach(p => {
      console.log(chalk.gray(`   - ${p.commandName}`));
    });
    console.log();

    const { confirmOverwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmOverwrite',
        message: 'This will overwrite existing configurations. Continue?',
        default: false
      }
    ]);

    if (!confirmOverwrite) {
      console.log(chalk.yellow('Cancelled'));
      return;
    }
  }

  // Ask for password
  const { password } = await inquirer.prompt([
    {
      type: 'password',
      name: 'password',
      message: 'Enter backup password:',
      mask: '*',
      validate: (input: string) => {
        if (!input) {
          return 'Password is required';
        }
        return true;
      }
    }
  ]);

  console.log(chalk.cyan('\n🍭 Restoring backup...\n'));

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
      .pipe(unzipper.Extract({ path: configDir }))
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

    console.log(chalk.green('✓ Backup restored successfully!\n'));
    console.log(chalk.cyan('Profiles restored:'), restoredProfiles.length);
    restoredProfiles.forEach(p => {
      console.log(chalk.gray(`   - ${p.commandName}`));
    });
    console.log();
    console.log(chalk.yellow('⚠️  Make sure ~/.sweech/bin is in your PATH:'));
    console.log(chalk.gray(`   export PATH="${binDir}:$PATH"`));
    console.log();

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('Bad decrypt') || msg.includes('unsupported state') || msg.includes('Decryption failed')) {
      throw new Error('Incorrect password or corrupted backup file');
    }
    throw error;
  }
}
