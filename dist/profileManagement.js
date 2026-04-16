"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getManageableProviders = getManageableProviders;
exports.createManagedProfile = createManagedProfile;
exports.renameManagedProfile = renameManagedProfile;
exports.removeManagedProfile = removeManagedProfile;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const clis_1 = require("./clis");
const profileCreation_1 = require("./profileCreation");
const providers_1 = require("./providers");
const reset_1 = require("./reset");
const systemCommands_1 = require("./systemCommands");
function requireCLI(cliType) {
    const cli = (0, clis_1.getCLI)(cliType);
    if (!cli) {
        throw new Error(`CLI '${cliType}' not found`);
    }
    return cli;
}
function requireProvider(providerName, cliType) {
    const provider = (0, providers_1.getProvider)(providerName);
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
function isOfficialOAuthProvider(cliType, providerName) {
    return (cliType === 'claude' && providerName === 'anthropic')
        || (cliType === 'codex' && providerName === 'openai');
}
function defaultCommandName(cliType, providerName) {
    if (cliType === 'codex') {
        return providerName === 'openai' ? 'codex-work' : `codex-${providerName.replace(/-openai$/, '')}`;
    }
    const defaults = {
        anthropic: 'claude-work',
        minimax: 'claude-mini',
        qwen: 'claude-qwen',
        kimi: 'claude-kimi',
        'kimi-coding': 'claude-kimi-coding',
        deepseek: 'claude-deep',
        glm: 'claude-glm',
        dashscope: 'claude-dash',
        ollama: 'claude-ollama',
    };
    return defaults[providerName] || `claude-${providerName}`;
}
async function validateProfileName(commandName, cliType, profiles, skipExistingName) {
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
    const systemCheck = await (0, systemCommands_1.validateCommandName)(trimmed);
    if (!systemCheck.valid) {
        throw new Error(systemCheck.error || 'Invalid command name');
    }
    return trimmed;
}
function validateShareTarget(sharedWith, cliType, profiles) {
    if (!sharedWith)
        return undefined;
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
function getManageableProviders(cliType) {
    return (0, providers_1.getProvidersForCLI)(cliType)
        .filter(provider => !provider.isCustom)
        .map(provider => ({
        name: provider.name,
        displayName: provider.displayName,
        description: provider.description,
        cliType,
        supportsOAuth: isOfficialOAuthProvider(cliType, provider.name),
        requiresApiKey: !isOfficialOAuthProvider(cliType, provider.name) && !provider.authOptional,
        defaultCommandName: defaultCommandName(cliType, provider.name),
    }));
}
async function createManagedProfile(input, config = new config_1.ConfigManager()) {
    const cli = requireCLI(input.cliType);
    const cliType = cli.name;
    const profiles = config.getProfiles();
    const commandName = await validateProfileName(input.commandName, cliType, profiles);
    const provider = requireProvider(input.provider, cliType);
    const authMethod = input.authMethod === 'api-key' ? 'api-key' : 'oauth';
    const sharedWith = validateShareTarget(input.sharedWith, cliType, profiles);
    if (!isOfficialOAuthProvider(cliType, provider.name) && !provider.authOptional && authMethod === 'oauth') {
        throw new Error(`Provider '${provider.name}' requires an API key`);
    }
    const apiKey = input.apiKey?.trim();
    if (authMethod === 'api-key' && !apiKey && !provider.authOptional) {
        throw new Error('API key is required for this provider');
    }
    const effectiveProvider = {
        ...provider,
        ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
        ...(input.model?.trim() ? { defaultModel: input.model.trim() } : {}),
    };
    await (0, profileCreation_1.createProfile)({
        cliType,
        provider: provider.name,
        commandName,
        apiKey,
        authMethod,
        sharedWith,
    }, effectiveProvider, cli, config, { quiet: true });
    return {
        commandName,
        profileDir: config.getProfileDir(commandName),
        cliType,
        provider: provider.name,
        sharedWith,
    };
}
async function renameManagedProfile(oldName, newName, config = new config_1.ConfigManager()) {
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.commandName === oldName);
    if (!profile) {
        throw new Error(`Profile '${oldName}' not found`);
    }
    const cliType = (profile.cliType || 'claude');
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
function removeManagedProfile(commandName, options = {}, config = new config_1.ConfigManager()) {
    const profiles = config.getProfiles();
    const profile = profiles.find(p => p.commandName === commandName);
    if (!profile) {
        throw new Error(`Profile '${commandName}' not found`);
    }
    const profileDir = config.getProfileDir(commandName);
    if ((0, reset_1.isDefaultCLIDirectory)(profileDir)) {
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
