/**
 * Utility commands for sweetch
 * doctor, path, test, edit, clone, rename
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ConfigManager, ProfileConfig, SHAREABLE_DIRS, SHAREABLE_FILES, CODEX_SHAREABLE_DIRS, CODEX_SHAREABLE_FILES, CODEX_SHAREABLE_DBS } from './config';
import { getCLI } from './clis';
import { getProvider } from './providers';
import { detectInstalledCLIs } from './cliDetection';
import { getAccountInfo, getKnownAccounts } from './subscriptions';

const execFileAsync = promisify(execFile);

/**
 * Check if sweetch bin directory is in PATH
 */
export function isInPath(binDir: string): boolean {
  const pathEnv = process.env.PATH || '';
  const paths = pathEnv.split(path.delimiter);
  return paths.some(p => path.resolve(p) === path.resolve(binDir));
}

/**
 * Detect user's shell
 */
export function detectShell(): string {
  const shell = process.env.SHELL || '';

  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('fish')) return 'fish';

  // Default to bash on Unix, cmd on Windows
  return process.platform === 'win32' ? 'cmd' : 'bash';
}

/**
 * Get shell RC file path
 */
export function getShellRCFile(): string {
  const shell = detectShell();
  const home = os.homedir();

  const rcFiles: Record<string, string> = {
    zsh: path.join(home, '.zshrc'),
    bash: path.join(home, '.bashrc'),
    fish: path.join(home, '.config', 'fish', 'config.fish'),
    cmd: '' // Windows doesn't have RC file in same way
  };

  return rcFiles[shell] || path.join(home, '.bashrc');
}

interface HealthIssue {
  profile: string;
  item: string;
  problem: string;
  fix: string;
}

/**
 * sweetch doctor - Health check
 */
export async function runDoctor(): Promise<void> {
  console.log(chalk.bold('\n🏥 Sweetch Health Check\n'));

  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const binDir = config.getBinDir();
  const symlinkIssues: HealthIssue[] = [];
  const largeProfiles: string[] = [];
  let healthyProfileCount = 0;

  // Check Node.js
  console.log(chalk.bold('Environment:'));
  try {
    const nodeVersion = process.version;
    console.log(chalk.green(`  ✓ Node.js: ${nodeVersion}`));
  } catch {
    console.log(chalk.red('  ✗ Node.js: Not detected'));
  }

  // Check sweetch version
  try {
    const packagePath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
    console.log(chalk.green(`  ✓ sweetch: v${pkg.version}`));
  } catch {
    console.log(chalk.gray('  ✓ sweetch: Development version'));
  }

  // Check PATH
  console.log(chalk.bold('\nPATH Configuration:'));
  if (isInPath(binDir)) {
    const rcFile = getShellRCFile();
    console.log(chalk.green(`  ✓ ${binDir} is in PATH`));
    console.log(chalk.gray(`    Location: ${rcFile}`));
  } else {
    console.log(chalk.red(`  ✗ ${binDir} is NOT in PATH`));
    console.log(chalk.yellow(`    Run: ${chalk.bold('sweetch path')} for help`));
  }

  // Check installed CLIs
  console.log(chalk.bold('\nInstalled CLIs:'));
  const detectedCLIs = await detectInstalledCLIs();
  detectedCLIs.forEach(result => {
    if (result.installed) {
      const version = result.version ? ` (${result.version})` : '';
      console.log(chalk.green(`  ✓ ${result.cli.displayName}${version}`));
    } else {
      console.log(chalk.gray(`  ✗ ${result.cli.displayName}: Not installed`));
      if (result.cli.installUrl) {
        console.log(chalk.gray(`    Install: ${result.cli.installUrl}`));
      }
    }
  });

  // Check usage cache staleness
  console.log(chalk.bold('\nUsage Cache:'));
  const cachePath = path.join(os.homedir(), '.sweech', 'rate-limit-cache.json');
  if (fs.existsSync(cachePath)) {
    const cacheStats = fs.statSync(cachePath);
    const cacheAgeMs = Date.now() - cacheStats.mtimeMs;
    const cacheAgeHours = Math.floor(cacheAgeMs / (1000 * 60 * 60));
    if (cacheAgeMs > 24 * 60 * 60 * 1000) {
      console.log(chalk.yellow(`  ⚠ Usage cache is stale (last updated ${cacheAgeHours}h ago) — run \`sweech usage --refresh\``));
    } else {
      const agoLabel = cacheAgeHours > 0 ? `${cacheAgeHours}h ago` : 'just now';
      console.log(chalk.green(`  ✓ Usage cache is fresh (updated ${agoLabel})`));
    }
  } else {
    console.log(chalk.gray(`  ✗ No usage cache found — run \`sweech usage\` to populate`));
  }

  // Check credential freshness (OAuth tokens in Keychain)
  console.log(chalk.bold('\nCredentials:'));
  let reauthNeeded: string[] = [];
  try {
    const accountList = getKnownAccounts(profiles);
    const accounts = await getAccountInfo(accountList);
    for (const acct of accounts) {
      if (acct.needsReauth) {
        reauthNeeded.push(acct.name);
        console.log(chalk.red(`  ✗ ${acct.name}: needs re-authentication`));
        console.log(chalk.gray(`    Run: sweech auth ${acct.commandName}`));
      } else if (acct.live?.tokenStatus === 'expired') {
        reauthNeeded.push(acct.name);
        console.log(chalk.yellow(`  ⚠ ${acct.name}: token expired`));
        console.log(chalk.gray(`    Run: sweech auth ${acct.commandName}`));
      } else if (acct.live?.tokenExpiresAt) {
        const hoursLeft = (acct.live.tokenExpiresAt - Date.now()) / 3600000;
        if (hoursLeft > 0 && hoursLeft < 24) {
          console.log(chalk.yellow(`  ⚠ ${acct.name}: token expires in ${Math.round(hoursLeft)}h`));
        } else {
          console.log(chalk.green(`  ✓ ${acct.name}: token valid`));
        }
      } else {
        console.log(chalk.green(`  ✓ ${acct.name}: ok`));
      }
    }
    if (reauthNeeded.length === 0 && accounts.length > 0) {
      console.log(chalk.green(`  All ${accounts.length} account credentials valid`));
    }
  } catch {
    console.log(chalk.gray('  ✗ Could not check credentials (fetch failed)'));
  }

  // Check profiles
  console.log(chalk.bold(`\nProfiles (${profiles.length}):`));
  if (profiles.length === 0) {
    console.log(chalk.gray('  No profiles configured yet'));
    console.log(chalk.gray(`  Run: ${chalk.bold('sweetch add')} to add a provider`));
  } else {
    for (const profile of profiles) {
      const provider = getProvider(profile.provider);
      const wrapperPath = path.join(binDir, profile.commandName);
      const profileDir = config.getProfileDir(profile.commandName);
      const settingsPath = path.join(profileDir, 'settings.json');

      const wrapperExists = fs.existsSync(wrapperPath);
      const wrapperExecutable = wrapperExists &&
        (fs.statSync(wrapperPath).mode & parseInt('111', 8)) !== 0;
      const configExists = fs.existsSync(settingsPath);

      const sharedTag = profile.sharedWith
        ? chalk.magenta(` [shared ↔ ${profile.sharedWith}]`)
        : '';

      const profileHealthy = wrapperExecutable && configExists;
      if (profileHealthy) {
        healthyProfileCount++;
        console.log(chalk.green(`  ✓ ${profile.commandName} → ${provider?.displayName}`) + sharedTag);
      } else {
        console.log(chalk.yellow(`  ⚠ ${profile.commandName} → ${provider?.displayName}`) + sharedTag);
        if (!wrapperExists) {
          console.log(chalk.gray(`    Missing wrapper script`));
        } else if (!wrapperExecutable) {
          console.log(chalk.gray(`    Wrapper not executable`));
        }
        if (!configExists) {
          console.log(chalk.gray(`    Missing config file`));
        }
      }

      // Check profile data directory size
      try {
        const { stdout } = await execFileAsync('du', ['-sk', profileDir], { timeout: 5000 });
        const sizeKB = parseInt(stdout.split('\t')[0], 10);
        if (!isNaN(sizeKB) && sizeKB > 5 * 1024 * 1024) { // 5GB in KB
          const sizeGB = (sizeKB / (1024 * 1024)).toFixed(1);
          console.log(chalk.yellow(`    ⚠ Profile data is large (${sizeGB} GB)`));
          largeProfiles.push(profile.commandName);
        }
      } catch {
        // du not available or dir doesn't exist — skip size check
      }

      // Check symlinks for profiles that share data with a master profile
      if (profile.sharedWith) {
        const isCodex = profile.cliType === 'codex'
          || profile.commandName.startsWith('codex');
        const masterDir = ['claude', 'codex'].includes(profile.sharedWith)
          ? path.join(os.homedir(), `.${profile.sharedWith}`)
          : config.getProfileDir(profile.sharedWith);

        const expectedDirs = isCodex ? CODEX_SHAREABLE_DIRS : SHAREABLE_DIRS;
        const expectedFiles = isCodex
          ? [...CODEX_SHAREABLE_FILES, ...CODEX_SHAREABLE_DBS]
          : [...SHAREABLE_FILES];

        console.log(chalk.gray(`    Shared symlinks (→ ${profile.sharedWith}):`));
        for (const item of [...expectedDirs, ...expectedFiles]) {
          const linkPath = path.join(profileDir, item);
          const expectedTarget = path.join(masterDir, item);
          let status: 'ok' | 'missing' | 'not-symlink' | 'wrong-target' = 'ok';

          try {
            const stat = fs.lstatSync(linkPath);
            if (stat.isSymbolicLink()) {
              const actual = fs.readlinkSync(linkPath);
              if (actual !== expectedTarget) {
                try {
                  if (fs.realpathSync(linkPath) !== fs.realpathSync(expectedTarget)) {
                    status = 'wrong-target';
                  }
                } catch {
                  status = 'wrong-target';
                }
              }
            } else {
              status = 'not-symlink';
            }
          } catch {
            status = 'missing';
          }

          if (status === 'ok') {
            console.log(chalk.green(`      ✓ ${item}`));
          } else {
            const isSqlite = item.endsWith('.sqlite');
            let problem = '';
            let fix = '';

            if (status === 'missing') {
              problem = 'missing';
              fix = isSqlite
                ? `ln -s "${expectedTarget}" "${linkPath}" (ensure master DB exists first)`
                : `ln -s "${expectedTarget}" "${linkPath}"`;
            } else if (status === 'not-symlink') {
              problem = 'real file (not symlinked)';
              fix = isSqlite
                ? `merge divergent data then replace with symlink (needs DB merge)`
                : `rm "${linkPath}" && ln -s "${expectedTarget}" "${linkPath}"`;
            } else {
              problem = `wrong target → ${fs.readlinkSync(linkPath)}`;
              fix = `rm "${linkPath}" && ln -s "${expectedTarget}" "${linkPath}"`;
            }

            console.log(chalk.red(`      ✗ ${item}`) + chalk.gray(` — ${problem}`));
            symlinkIssues.push({ profile: profile.commandName, item, problem, fix });
          }
        }
      }
    }
  }

  // Profile health summary
  if (profiles.length > 0) {
    console.log(chalk.bold('\nProfile Summary:'));
    const totalProfiles = profiles.length;
    const summaryColor = healthyProfileCount === totalProfiles
      ? chalk.green
      : healthyProfileCount > 0
        ? chalk.yellow
        : chalk.red;
    console.log(summaryColor(`  ${healthyProfileCount} of ${totalProfiles} profiles healthy`));
    if (largeProfiles.length > 0) {
      console.log(chalk.yellow(`  ${largeProfiles.length} profile${largeProfiles.length > 1 ? 's' : ''} over 5 GB: ${largeProfiles.join(', ')}`));
    }
  }

  // Summary
  const cacheStale = fs.existsSync(cachePath) && (Date.now() - fs.statSync(cachePath).mtimeMs > 24 * 60 * 60 * 1000);
  const hasIssues = !isInPath(binDir) ||
    symlinkIssues.length > 0 ||
    largeProfiles.length > 0 ||
    reauthNeeded.length > 0 ||
    cacheStale ||
    profiles.some(p => {
      const wrapperPath = path.join(binDir, p.commandName);
      return !fs.existsSync(wrapperPath);
    });

  console.log();

  // Print symlink fix suggestions if any
  if (symlinkIssues.length > 0) {
    console.log(chalk.bold('Suggested fixes:\n'));

    const sqliteIssues = symlinkIssues.filter(i => i.item.endsWith('.sqlite') && i.problem.includes('real file'));
    const simpleIssues = symlinkIssues.filter(i => !sqliteIssues.includes(i));

    for (const issue of simpleIssues) {
      console.log(chalk.gray(`# ${issue.profile}/${issue.item} — ${issue.problem}`));
      console.log(`  ${issue.fix}`);
    }

    if (sqliteIssues.length > 0) {
      console.log(chalk.yellow('\nSQLite databases need merge before symlinking:'));
      for (const issue of sqliteIssues) {
        console.log(chalk.gray(`  ${issue.profile}/${issue.item}`));
      }
      console.log(chalk.gray('\nRun sweech resync <profile> to flush WAL, merge, and re-symlink.'));
      console.log(chalk.gray('Or fix manually with an AI agent — the DBs may have divergent threads.'));
    }

    console.log();
  }

  if (hasIssues) {
    console.log(chalk.yellow('⚠️  Some issues detected. See above for details.\n'));
    process.exitCode = 1;
  } else {
    console.log(chalk.green('✅ Everything looks good! 🎉\n'));
  }
}

/**
 * sweetch path - PATH configuration helper
 */
export async function runPath(): Promise<void> {
  console.log(chalk.bold('\n📍 PATH Configuration\n'));

  const config = new ConfigManager();
  const binDir = config.getBinDir();
  const inPath = isInPath(binDir);
  const shell = detectShell();
  const rcFile = getShellRCFile();

  if (inPath) {
    console.log(chalk.green(`Status: ✓ Configured`));
    console.log(chalk.gray(`  ${binDir} is in your PATH`));
    console.log(chalk.gray(`  Shell: ${shell}`));
    console.log();
    return;
  }

  console.log(chalk.yellow(`Status: ✗ Not configured`));
  console.log(chalk.gray(`  ${binDir} is not in your PATH\n`));

  console.log(chalk.bold('To use your commands, add this to your shell:\n'));

  const exportCmd = `export PATH="$HOME/.sweech/bin:$PATH"`;

  if (shell === 'zsh') {
    console.log(chalk.cyan(`  # For zsh (default on macOS)`));
    console.log(chalk.white(`  echo '${exportCmd}' >> ~/.zshrc`));
    console.log(chalk.white(`  source ~/.zshrc\n`));
  } else if (shell === 'bash') {
    console.log(chalk.cyan(`  # For bash`));
    console.log(chalk.white(`  echo '${exportCmd}' >> ~/.bashrc`));
    console.log(chalk.white(`  source ~/.bashrc\n`));
  } else if (shell === 'fish') {
    console.log(chalk.cyan(`  # For fish`));
    console.log(chalk.white(`  set -Ua fish_user_paths $HOME/.sweech/bin`));
    console.log(chalk.white(`  # Or add to ~/.config/fish/config.fish\n`));
  }

  // Offer to add automatically
  const { autoAdd } = await inquirer.prompt([
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
          console.log(chalk.green(`\n✓ Added to ${rcFile}`));
          console.log(chalk.yellow(`\nRestart your terminal or run: ${chalk.bold(`source ${rcFile}`)}\n`));
        } else {
          console.log(chalk.green(`\n✓ Already in ${rcFile}`));
          console.log(chalk.yellow(`\nRestart your terminal or run: ${chalk.bold(`source ${rcFile}`)}\n`));
        }
      } else {
        fs.appendFileSync(rcFile, `\n# Added by sweetch\n${exportCmd}\n`);
        console.log(chalk.green(`\n✓ Added to ${rcFile}`));
        console.log(chalk.yellow(`\nRestart your terminal or run: ${chalk.bold(`source ${rcFile}`)}\n`));
      }
    } catch (error: any) {
      console.error(chalk.red(`\nFailed to update ${rcFile}:`, error.message));
      console.log(chalk.gray('Please add manually using the commands above.\n'));
    }
  }
}

/**
 * sweetch test - Test provider connection
 */
export async function runTest(commandName: string): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const profile = profiles.find(p => p.commandName === commandName);

  if (!profile) {
    console.error(chalk.red(`\nProfile '${commandName}' not found\n`));
    process.exit(1);
  }

  const provider = getProvider(profile.provider);
  const cli = getCLI(profile.cliType);

  console.log(chalk.bold(`\n🧪 Testing ${commandName} (${provider?.displayName})...\n`));

  // Check configuration
  process.stdout.write(chalk.gray('Checking configuration...        '));
  const profileDir = config.getProfileDir(commandName);
  const settingsPath = path.join(profileDir, 'settings.json');
  const wrapperPath = path.join(config.getBinDir(), commandName);

  if (!fs.existsSync(settingsPath)) {
    console.log(chalk.red('✗'));
    console.error(chalk.red(`\nConfig file not found: ${settingsPath}\n`));
    process.exit(1);
  }

  if (!fs.existsSync(wrapperPath)) {
    console.log(chalk.red('✗'));
    console.error(chalk.red(`\nWrapper script not found: ${wrapperPath}\n`));
    process.exit(1);
  }

  console.log(chalk.green('✓'));

  // Test CLI installation
  process.stdout.write(chalk.gray('Checking CLI installation...     '));
  try {
    await execFileAsync(cli?.command || 'claude', ['--version'], { timeout: 5000 });
    console.log(chalk.green('✓'));
  } catch {
    console.log(chalk.red('✗'));
    console.error(chalk.red(`\n${cli?.displayName} is not installed or not in PATH\n`));
    process.exit(1);
  }

  // Note: We can't actually test the API without making a real request
  // which would require the CLI's authentication flow
  console.log(chalk.gray('Testing API connection...        ') + chalk.yellow('⊘ Skipped'));
  console.log(chalk.gray('  (Requires CLI authentication flow)\n'));

  console.log(chalk.green('✅ Configuration is valid!\n'));
  console.log(chalk.gray('Configuration:'));
  console.log(chalk.gray(`  Provider: ${provider?.displayName}`));
  console.log(chalk.gray(`  Model: ${profile.model}`));
  console.log(chalk.gray(`  Config: ${profileDir}`));
  console.log(chalk.gray(`  Wrapper: ${wrapperPath}\n`));
  console.log(chalk.cyan(`To use: ${chalk.bold(commandName)}\n`));
}

/**
 * sweetch edit - Edit profile configuration
 */
export async function runEdit(commandName: string): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const profile = profiles.find(p => p.commandName === commandName);

  if (!profile) {
    console.error(chalk.red(`\nProfile '${commandName}' not found\n`));
    process.exit(1);
  }

  const provider = getProvider(profile.provider);

  console.log(chalk.bold(`\n✏️  Edit ${commandName}\n`));
  console.log(chalk.gray('Current configuration:'));
  console.log(chalk.gray(`  Provider: ${provider?.displayName}`));
  console.log(chalk.gray(`  Model: ${profile.model}`));
  const authMethod = profile.oauth ? 'OAuth' : 'API Key';
  const authDisplay = profile.apiKey
    ? `API Key: ${profile.apiKey.substring(0, 10)}***`
    : `OAuth (${profile.oauth?.provider})`;
  console.log(chalk.gray(`  Auth: ${authDisplay}`));
  console.log();

  const { field } = await inquirer.prompt([
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
    console.log(chalk.yellow('\nCancelled\n'));
    return;
  }

  let newValue: string;

  if (field === 'apiKey') {
    const answer = await inquirer.prompt([
      {
        type: 'password',
        name: 'value',
        message: 'Enter new API key:',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'API key required'
      }
    ]);
    newValue = answer.value.trim();
  } else if (field === 'model') {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'value',
        message: 'Enter new model name:',
        default: profile.model,
        validate: (input: string) => input.trim().length > 0 || 'Model name required'
      }
    ]);
    newValue = answer.value.trim();
  } else if (field === 'baseUrl') {
    const answer = await inquirer.prompt([
      {
        type: 'input',
        name: 'value',
        message: 'Enter new base URL:',
        default: profile.baseUrl,
        validate: (input: string) => input.trim().length > 0 || 'Base URL required'
      }
    ]);
    newValue = answer.value.trim();
  } else {
    return;
  }

  // Update profile
  profile[field as keyof ProfileConfig] = newValue as any;

  // Save to config.json
  const allProfiles = profiles.map(p =>
    p.commandName === commandName ? profile : p
  );
  fs.writeFileSync(config.getConfigFile(), JSON.stringify(allProfiles, null, 2));

  // Update settings.json
  if (provider) {
    config.createProfileConfig(commandName, provider, profile.apiKey, profile.cliType);
  }

  console.log(chalk.green(`\n✓ Updated ${field} for ${commandName}\n`));
}

/**
 * sweetch clone - Clone an existing profile
 */
export async function runClone(sourceName: string, targetName: string): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const source = profiles.find(p => p.commandName === sourceName);

  if (!source) {
    console.error(chalk.red(`\nProfile '${sourceName}' not found\n`));
    process.exit(1);
  }

  if (profiles.some(p => p.commandName === targetName)) {
    console.error(chalk.red(`\nProfile '${targetName}' already exists\n`));
    process.exit(1);
  }

  console.log(chalk.bold(`\n📋 Cloning ${sourceName} → ${targetName}...\n`));

  const { useSameKey } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'useSameKey',
      message: 'Use same API key?',
      default: true
    }
  ]);

  let apiKey = source.apiKey;

  if (!useSameKey) {
    const answer = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter API key for new profile:',
        mask: '*',
        validate: (input: string) => input.trim().length > 0 || 'API key required'
      }
    ]);
    apiKey = answer.apiKey.trim();
  }

  // Ask about sharing inheritance if source profile has sharedWith set
  let inheritSharedWith: string | undefined = undefined;
  if (source.sharedWith) {
    const { inheritShare } = await inquirer.prompt([
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
  const newProfile: ProfileConfig = {
    ...source,
    name: targetName,
    commandName: targetName,
    apiKey,
    createdAt: new Date().toISOString(),
    sharedWith: inheritSharedWith
  };

  config.addProfile(newProfile);

  const provider = getProvider(source.provider);
  const cli = getCLI(source.cliType);
  if (provider && cli) {
    config.createProfileConfig(targetName, provider, apiKey, cli.name);
  }
  if (cli) {
    config.createWrapperScript(targetName, cli);
  }

  // Set up shared dirs if clone inherits sharing
  if (inheritSharedWith) {
    config.setupSharedDirs(targetName, inheritSharedWith, source.cliType);
  }

  console.log(chalk.green(`\n✓ Created ${targetName} (${provider?.displayName})\n`));
}

/**
 * sweetch rename - Rename a profile
 */
export async function runRename(oldName: string, newName: string): Promise<void> {
  const config = new ConfigManager();
  const profiles = config.getProfiles();
  const profile = profiles.find(p => p.commandName === oldName);

  if (!profile) {
    console.error(chalk.red(`\nProfile '${oldName}' not found\n`));
    process.exit(1);
  }

  if (profiles.some(p => p.commandName === newName)) {
    console.error(chalk.red(`\nProfile '${newName}' already exists\n`));
    process.exit(1);
  }

  console.log(chalk.bold(`\n✏️  Renaming ${oldName} → ${newName}...\n`));

  // Remove old
  const oldProfileDir = config.getProfileDir(oldName);
  const oldWrapperPath = path.join(config.getBinDir(), oldName);

  // Update profile
  profile.name = newName;
  profile.commandName = newName;

  // Save updated profiles
  const updatedProfiles = profiles.map(p =>
    p.commandName === oldName ? profile : p
  );
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

  const cli = getCLI(profile.cliType);
  if (cli) {
    config.createWrapperScript(newName, cli);
  }

  console.log(chalk.green(`✓ Renamed ${oldName} → ${newName}\n`));
  console.log(chalk.gray('  Command: ' + newName));
  console.log(chalk.gray('  Config: ' + newProfileDir));
  console.log();
}

