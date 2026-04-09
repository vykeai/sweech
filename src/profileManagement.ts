import * as fs from 'fs';
import * as path from 'path';
import { ConfigManager, ProfileConfig } from './config';
import { getCLI } from './clis';
import { createProfile } from './profileCreation';
import { getProvider, getProvidersForCLI, type CLIType, type ProviderConfig } from './providers';
import { isDefaultCLIDirectory } from './reset';
import { validateCommandName } from './systemCommands';

export interface ManageableProvider {
  name: string;
  displayName: string;
  description: string;
  cliType: CLIType;
  supportsOAuth: boolean;
  requiresApiKey: boolean;
  defaultCommandName: string;
}

export interface ProfileCreateInput {
  cliType: string;
  provider: string;
  commandName: string;
  authMethod?: string;
  apiKey?: string;
  sharedWith?: string;
  model?: string;
  baseUrl?: string;
}

export interface ProfileMutationResult {
  commandName: string;
  profileDir: string;
  cliType: string;
  provider: string;
  sharedWith?: string;
}

export interface ProfileRenameResult {
  oldName: string;
  newName: string;
  profileDir: string;
  updatedDependents: string[];
}

export interface ProfileRemoveResult {
  commandName: string;
  removedDependents: string[];
}

function requireCLI(cliType: string) {
  const cli = getCLI(cliType);
  if (!cli) {
    throw new Error(`CLI '${cliType}' not found`);
  }
  return cli;
}

function requireProvider(providerName: string, cliType: CLIType): ProviderConfig {
  const provider = getProvider(providerName);
  if (!provider) {
    throw new Error(`Provider '${providerName}' not found`);
  }
  if (!provider.compatibility.includes(cliType)) {
    throw new Error(`Provider '${providerName}' is not compatible with CLI '${cliType}'`);
  }
  if (provider.isCustom) {
    throw new Error('Custom providers are not supported in SweechBar yet');
  }
  return provider;
}

function isOfficialOAuthProvider(cliType: CLIType, providerName: string): boolean {
  return (cliType === 'claude' && providerName === 'anthropic')
    || (cliType === 'codex' && providerName === 'openai');
}

function defaultCommandName(cliType: CLIType, providerName: string): string {
  if (cliType === 'codex') {
    return providerName === 'openai' ? 'codex-work' : `codex-${providerName.replace(/-openai$/, '')}`;
  }

  const defaults: Record<string, string> = {
    anthropic: 'claude-work',
    minimax: 'claude-mini',
    qwen: 'claude-qwen',
    kimi: 'claude-kimi',
    'kimi-coding': 'claude-kimi-coding',
    deepseek: 'claude-deep',
    glm: 'claude-glm',
    dashscope: 'claude-dash',
  };

  return defaults[providerName] || `claude-${providerName}`;
}

async function validateProfileName(
  commandName: string,
  cliType: CLIType,
  profiles: ProfileConfig[],
  skipExistingName?: string
): Promise<string> {
  const trimmed = commandName.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('Command name is required');
  }

  if (!/^[a-z0-9-]+$/.test(trimmed)) {
    throw new Error('Use only lowercase letters, numbers, and hyphens');
  }

  if (trimmed === 'claude' || trimmed === 'codex') {
    throw new Error(`Cannot use "${trimmed}" - this is reserved for your default account`);
  }

  const prefix = cliType === 'codex' ? 'codex-' : 'claude-';
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`Command name must start with "${prefix}"`);
  }

  if (profiles.some(p => p.commandName === trimmed && p.commandName !== skipExistingName)) {
    throw new Error(`Command name '${trimmed}' already exists`);
  }

  const systemCheck = await validateCommandName(trimmed);
  if (!systemCheck.valid) {
    throw new Error(systemCheck.error || 'Invalid command name');
  }

  return trimmed;
}

function validateShareTarget(sharedWith: string | undefined, cliType: CLIType, profiles: ProfileConfig[]): string | undefined {
  if (!sharedWith) return undefined;

  const trimmed = sharedWith.trim().toLowerCase();
  const defaultTarget = cliType === 'codex' ? 'codex' : 'claude';
  if (trimmed === defaultTarget) {
    return trimmed;
  }

  const target = profiles.find(p => p.commandName === trimmed);
  if (!target) {
    throw new Error(`Share target '${trimmed}' not found`);
  }
  if ((target.cliType || 'claude') !== cliType) {
    throw new Error(`Share target '${trimmed}' must use the same CLI type`);
  }

  return trimmed;
}

export function getManageableProviders(cliType: CLIType): ManageableProvider[] {
  return getProvidersForCLI(cliType)
    .filter(provider => !provider.isCustom)
    .map(provider => ({
      name: provider.name,
      displayName: provider.displayName,
      description: provider.description,
      cliType,
      supportsOAuth: isOfficialOAuthProvider(cliType, provider.name),
      requiresApiKey: !isOfficialOAuthProvider(cliType, provider.name),
      defaultCommandName: defaultCommandName(cliType, provider.name),
    }));
}

export async function createManagedProfile(
  input: ProfileCreateInput,
  config = new ConfigManager()
): Promise<ProfileMutationResult> {
  const cli = requireCLI(input.cliType);
  const cliType = cli.name as CLIType;
  const profiles = config.getProfiles();
  const commandName = await validateProfileName(input.commandName, cliType, profiles);
  const provider = requireProvider(input.provider, cliType);
  const authMethod = input.authMethod === 'api-key' ? 'api-key' : 'oauth';
  const sharedWith = validateShareTarget(input.sharedWith, cliType, profiles);

  if (!isOfficialOAuthProvider(cliType, provider.name) && authMethod === 'oauth') {
    throw new Error(`Provider '${provider.name}' requires an API key`);
  }

  const apiKey = input.apiKey?.trim();
  if (authMethod === 'api-key' && !apiKey) {
    throw new Error('API key is required for this provider');
  }

  const effectiveProvider: ProviderConfig = {
    ...provider,
    ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(input.model?.trim() ? { defaultModel: input.model.trim() } : {}),
  };

  await createProfile(
    {
      cliType,
      provider: provider.name,
      commandName,
      apiKey,
      authMethod,
      sharedWith,
    },
    effectiveProvider,
    cli,
    config,
    { quiet: true }
  );

  return {
    commandName,
    profileDir: config.getProfileDir(commandName),
    cliType,
    provider: provider.name,
    sharedWith,
  };
}

export async function renameManagedProfile(
  oldName: string,
  newName: string,
  config = new ConfigManager()
): Promise<ProfileRenameResult> {
  const profiles = config.getProfiles();
  const profile = profiles.find(p => p.commandName === oldName);
  if (!profile) {
    throw new Error(`Profile '${oldName}' not found`);
  }

  const cliType = (profile.cliType || 'claude') as CLIType;
  const trimmedNewName = await validateProfileName(newName, cliType, profiles, oldName);

  const updatedDependents = profiles
    .filter(p => p.sharedWith === oldName)
    .map(p => p.commandName);

  const updatedProfiles = profiles.map(existing => {
    if (existing.commandName === oldName) {
      return {
        ...existing,
        name: trimmedNewName,
        commandName: trimmedNewName,
      };
    }
    if (existing.sharedWith === oldName) {
      return {
        ...existing,
        sharedWith: trimmedNewName,
      };
    }
    return existing;
  });

  fs.writeFileSync(config.getConfigFile(), JSON.stringify(updatedProfiles, null, 2));

  const oldProfileDir = config.getProfileDir(oldName);
  const newProfileDir = config.getProfileDir(trimmedNewName);
  if (fs.existsSync(oldProfileDir)) {
    fs.renameSync(oldProfileDir, newProfileDir);
  }

  const oldWrapperPath = path.join(config.getBinDir(), oldName);
  if (fs.existsSync(oldWrapperPath)) {
    fs.unlinkSync(oldWrapperPath);
  }

  const cli = requireCLI(cliType);
  config.createWrapperScript(trimmedNewName, cli);

  for (const dependent of updatedProfiles.filter(p => p.sharedWith === trimmedNewName)) {
    config.setupSharedDirs(dependent.commandName, trimmedNewName, dependent.cliType);
  }

  return {
    oldName,
    newName: trimmedNewName,
    profileDir: newProfileDir,
    updatedDependents,
  };
}

export function removeManagedProfile(
  commandName: string,
  options: { forceDependents?: boolean } = {},
  config = new ConfigManager()
): ProfileRemoveResult {
  const profiles = config.getProfiles();
  const profile = profiles.find(p => p.commandName === commandName);
  if (!profile) {
    throw new Error(`Profile '${commandName}' not found`);
  }

  const profileDir = config.getProfileDir(commandName);
  if (isDefaultCLIDirectory(profileDir)) {
    throw new Error(`Cannot remove default CLI directory: ${profileDir}`);
  }

  const dependents = profiles
    .filter(p => p.sharedWith === commandName)
    .map(p => p.commandName);

  if (dependents.length > 0 && !options.forceDependents) {
    throw new Error(`Profile '${commandName}' is shared by: ${dependents.join(', ')}`);
  }

  config.removeProfile(commandName);

  return {
    commandName,
    removedDependents: dependents,
  };
}
