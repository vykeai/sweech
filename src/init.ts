/**
 * Interactive onboarding for first-time Sweech setup
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigManager } from './config';
import { interactiveAddProvider } from './interactive';
import { getProvider } from './providers';
import { getCLI } from './clis';
import { runDoctor } from './utilityCommands';
import { detectInstalledCLIs } from './cliDetection';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Check if sweech bin directory is in PATH
 */
function isInPath(): boolean {
  const binDir = path.join(os.homedir(), '.sweech', 'bin');
  const pathEnv = process.env.PATH || '';
  return pathEnv.split(path.delimiter).some(p => path.resolve(p) === binDir);
}

/**
 * Detect which shell the user is using
 */
function detectShell(): string {
  const shell = process.env.SHELL || '';

  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('fish')) return 'fish';

  // Default to bash
  return 'bash';
}

/**
 * Get the shell RC file path
 */
function getShellRcFile(shell: string): string {
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
export async function runInit(): Promise<void> {
  console.log(chalk.bold.cyan('\n🍭 Welcome to Sweech!\n'));
  console.log('Let\'s get you set up with your first AI provider.\n');

  const config = new ConfigManager();
  const existingProfiles = config.getProfiles();

  // Check if already configured
  if (existingProfiles.length > 0) {
    console.log(chalk.yellow('⚠️  You already have providers configured:\n'));
    existingProfiles.forEach(profile => {
      console.log(chalk.gray(`  • ${profile.commandName}`));
    });
    console.log();

    const { continueAnyway } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continueAnyway',
        message: 'Would you like to add another provider?',
        default: true
      }
    ]);

    if (!continueAnyway) {
      console.log(chalk.green('\n✓ You\'re all set! Run `sweech list` to see your providers.\n'));
      return;
    }
    console.log();
  }

  // Step 1: Check PATH
  if (!isInPath()) {
    console.log(chalk.bold('Step 1: Add Sweech to your PATH\n'));

    const shell = detectShell();
    const rcFile = getShellRcFile(shell);
    const pathLine = 'export PATH="$HOME/.sweech/bin:$PATH"';

    console.log(chalk.yellow('⚠️  Sweech bin directory is not in your PATH yet.\n'));
    console.log('To use your providers, add this to your shell configuration:\n');
    console.log(chalk.cyan(`  ${pathLine}\n`));
    console.log(chalk.gray(`Add to: ${rcFile}\n`));

    const { addToPath } = await inquirer.prompt([
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
            console.log(chalk.green(`\n✓ Added to ${rcFile}`));
            console.log(chalk.yellow('\n⚠️  Restart your terminal or run:'));
            console.log(chalk.cyan(`  source ${rcFile}\n`));
          } else {
            console.log(chalk.green('\n✓ Already in PATH\n'));
          }
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`\n✗ Failed to update ${rcFile}:`, msg));
        console.log(chalk.yellow('\nPlease add it manually.\n'));
      }
    } else {
      console.log(chalk.yellow('\n⚠️  Remember to add it to your PATH manually!\n'));
    }
  } else {
    console.log(chalk.green('✓ Sweech is in your PATH\n'));
  }

  // Step 2: Check installed CLIs
  console.log(chalk.bold('Step 2: Detect installed CLIs\n'));

  const detectionResults = await detectInstalledCLIs();
  const anyInstalled = detectionResults.some(r => r.installed);

  for (const result of detectionResults) {
    if (result.installed) {
      const version = result.version ? chalk.gray(` (${result.version})`) : '';
      console.log(chalk.green(`✓ ${result.cli.displayName} detected${version}`));
    } else {
      console.log(chalk.gray(`○ ${result.cli.displayName} not found`));
      if (result.cli.installUrl) {
        console.log(chalk.gray(`  Install: ${result.cli.installUrl}`));
      }
    }
  }

  if (!anyInstalled) {
    console.log(chalk.yellow('\n⚠️  No supported CLIs found!'));
    console.log('You\'ll need to install Claude Code or Codex to use Sweech.\n');

    const { installLater } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'installLater',
        message: 'Continue anyway? (You can configure providers later)',
        default: false
      }
    ]);

    if (!installLater) {
      console.log(chalk.yellow('\nInstall a CLI first, then run `sweech init` again.\n'));
      return;
    }
  }

  console.log();

  // Step 3: Add first provider
  console.log(chalk.bold('Step 3: Add your first provider\n'));

  try {
    const answers = await interactiveAddProvider(existingProfiles);

    const provider = answers.customProviderConfig || getProvider(answers.provider);
    if (!provider) {
      console.error(chalk.red(`\n✗ Provider '${answers.provider}' not found`));
      return;
    }

    const cli = getCLI(answers.cliType);
    if (!cli) {
      console.error(chalk.red(`\n✗ CLI '${answers.cliType}' not found`));
      return;
    }

    // Create profile with OAuth or API key
    const { createProfile } = await import('./profileCreation');
    await createProfile(answers, provider, cli, config);
    console.log();

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(chalk.red('\n✗ Setup failed:', msg));
    return;
  }

  // Step 4: Verify setup
  console.log(chalk.bold('Step 4: Verify installation\n'));

  const { runDoctorCheck } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'runDoctorCheck',
      message: 'Run health check to verify everything works?',
      default: true
    }
  ]);

  if (runDoctorCheck) {
    console.log();
    await runDoctor();
  }

  // Final summary
  console.log(chalk.bold.green('\n🎉 Setup complete!\n'));
  console.log(chalk.bold('Next steps:\n'));

  if (!isInPath()) {
    console.log(chalk.yellow('1. Restart your terminal or run:'));
    const shell = detectShell();
    const rcFile = getShellRcFile(shell);
    console.log(chalk.cyan(`   source ${rcFile}\n`));
  }

  const profiles = config.getProfiles();
  if (profiles.length > 0) {
    const firstProfile = profiles[0];
    console.log(chalk.cyan(`2. Try your new command:`));
    console.log(chalk.bold.cyan(`   ${firstProfile.commandName}\n`));
  }

  console.log(chalk.gray('3. Add more providers:'));
  console.log(chalk.gray('   sweech add\n'));

  console.log(chalk.gray('4. View all providers:'));
  console.log(chalk.gray('   sweech list\n'));

  console.log(chalk.gray('Happy sweeching! 🍭\n'));
}
