/**
 * Shared profile creation logic for add and init commands
 */

import chalk from 'chalk';
import { ConfigManager, ProfileConfig } from './config';
import { ProviderConfig } from './providers';
import { CLIConfig } from './clis';
import { AddProviderAnswers } from './interactive';
import { getOAuthToken, OAuthToken } from './oauth';
import { runHook } from './plugins';

/**
 * Create a new profile with OAuth or API key authentication
 */
export async function createProfile(
  answers: AddProviderAnswers,
  provider: ProviderConfig,
  cli: CLIConfig,
  config: ConfigManager
): Promise<void> {
  // Determine if we should use native CLI authentication (OAuth flow)
  // Use native auth when:
  // - User selected OAuth AND
  // - Using official provider (anthropic for claude, openai for codex)
  const isOfficialProvider =
    (cli.name === 'claude' && answers.provider === 'anthropic') ||
    (cli.name === 'codex' && answers.provider === 'openai');
  const useNativeAuth = answers.authMethod === 'oauth' && isOfficialProvider;

  // Handle OAuth if selected (but not for native auth - CLI handles it)
  let oauthToken: OAuthToken | undefined = undefined;
  if (answers.authMethod === 'oauth' && !useNativeAuth) {
    oauthToken = await getOAuthToken(cli.name, answers.provider);
    console.log(chalk.green('✓ OAuth authentication successful'));
  }

  // Create profile object
  const profile: ProfileConfig = {
    name: answers.commandName,
    commandName: answers.commandName,
    cliType: cli.name,
    provider: answers.provider,
    apiKey: answers.apiKey || undefined,
    oauth: oauthToken,
    baseUrl: provider.baseUrl,
    model: provider.defaultModel,
    smallFastModel: provider.smallFastModel,
    createdAt: new Date().toISOString(),
    // Store custom provider details if present
    ...(answers.customProviderPrompts && {
      customProvider: answers.customProviderPrompts
    }),
    // Store symlink relationship if shared mode
    ...(answers.sharedWith && { sharedWith: answers.sharedWith })
  };

  // Save profile
  config.addProfile(profile);
  config.createProfileConfig(
    answers.commandName,
    provider,
    answers.apiKey,
    cli.name,
    oauthToken,
    useNativeAuth
  );
  config.createWrapperScript(answers.commandName, cli);

  // Set up shared dirs if symlink mode
  if (answers.sharedWith) {
    config.setupSharedDirs(answers.commandName, answers.sharedWith, answers.cliType);
  }

  // Run plugin onProfileCreate hooks (errors are caught inside runHook)
  try { runHook('onProfileCreate', profile); } catch { /* plugin errors must not crash CLI */ }

  // Display success message
  console.log(chalk.green('\n✓ Provider added successfully!\n'));
  console.log(chalk.cyan('Command:'), chalk.bold(answers.commandName));
  console.log(chalk.cyan('Provider:'), provider.displayName);
  if (answers.sharedWith) {
    console.log(chalk.cyan('Data:'), `Shared with ${chalk.bold(answers.sharedWith)} (projects, plans, tasks, commands, plugins, hooks, agents, teams, todos, mcp.json, CLAUDE.md)`);
  }

  if (useNativeAuth) {
    console.log(chalk.cyan('Auth:'), 'OAuth (via CLI)');
    console.log();
    console.log(chalk.blue('ℹ'), chalk.gray(`Run ${chalk.cyan(answers.commandName)} to log in with your account`));
  } else {
    console.log(chalk.cyan('Model:'), provider.defaultModel);
    if (answers.authMethod === 'oauth') {
      console.log(chalk.cyan('Auth:'), 'OAuth Token');
    }
  }
}
