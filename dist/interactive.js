"use strict";
/**
 * Interactive prompts for adding providers
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.interactiveAddProvider = interactiveAddProvider;
exports.confirmRemoveProvider = confirmRemoveProvider;
const inquirer_1 = __importDefault(require("inquirer"));
const chalk_1 = __importDefault(require("chalk"));
const providers_1 = require("./providers");
const systemCommands_1 = require("./systemCommands");
const cliDetection_1 = require("./cliDetection");
const customProvider_1 = require("./customProvider");
async function interactiveAddProvider(existingProfiles = []) {
    console.log('\n🍭 Sweetch - Add New Provider\n');
    // Show existing setup if any
    if (existingProfiles.length > 0) {
        console.log(chalk_1.default.bold('Your current setup:'));
        // Group by CLI type
        const grouped = existingProfiles.reduce((acc, p) => {
            const cliType = p.cliType || 'claude';
            if (!acc[cliType])
                acc[cliType] = [];
            acc[cliType].push(p);
            return acc;
        }, {});
        Object.entries(grouped).forEach(([cliType, profiles]) => {
            console.log(chalk_1.default.cyan(`  • ${cliType}:`), chalk_1.default.gray(`${profiles.length} profile${profiles.length > 1 ? 's' : ''} (${profiles.map(p => p.commandName).join(', ')})`));
        });
        console.log();
    }
    // Detect installed CLIs
    console.log(chalk_1.default.gray('🔍 Detecting installed CLIs...\n'));
    const detectedCLIs = await (0, cliDetection_1.detectInstalledCLIs)();
    const installedCount = detectedCLIs.filter(d => d.installed).length;
    if (installedCount === 0) {
        console.log(chalk_1.default.red('✗ No supported CLIs found. Please install at least one:'));
        detectedCLIs.forEach(d => {
            if (d.cli.installUrl) {
                console.log(chalk_1.default.yellow(`  • ${d.cli.displayName}: ${d.cli.installUrl}`));
            }
        });
        console.log();
        throw new Error('No supported CLIs installed');
    }
    const answers = await inquirer_1.default.prompt([
        {
            type: 'list',
            name: 'cliType',
            message: 'Which CLI are you configuring?',
            choices: (0, cliDetection_1.formatCLIChoices)(detectedCLIs),
            when: () => installedCount > 1 // Skip if only one CLI installed
        },
        {
            type: 'list',
            name: 'providerType',
            message: (answers) => {
                const selectedCLI = detectedCLIs.find(d => d.cli.name === (answers.cliType || 'claude'));
                return `What would you like to add for ${selectedCLI?.cli.displayName}?`;
            },
            choices: (answers) => {
                const cliType = answers.cliType || detectedCLIs.find(d => d.installed)?.cli.name || 'claude';
                const cliName = detectedCLIs.find(d => d.cli.name === cliType)?.cli.displayName || 'this CLI';
                return [
                    {
                        name: `Another ${cliName} account (official provider)`,
                        value: 'official'
                    },
                    {
                        name: 'External AI provider (MiniMax, Qwen, Kimi, DeepSeek, etc.)',
                        value: 'external'
                    }
                ];
            }
        },
        {
            type: 'list',
            name: 'provider',
            message: 'Choose a provider:',
            choices: (answers) => {
                if (answers.providerType === 'official') {
                    const cliType = answers.cliType || 'claude';
                    if (cliType === 'claude') {
                        return [
                            {
                                name: 'Claude (Anthropic) - Official Anthropic Claude models',
                                value: 'anthropic'
                            }
                        ];
                    }
                    if (cliType === 'codex') {
                        return [
                            {
                                name: 'OpenAI - Official OpenAI Codex models',
                                value: 'openai'
                            }
                        ];
                    }
                    return [];
                }
                // For external, show compatible providers for the selected CLI
                const cliType = answers.cliType || detectedCLIs.find(d => d.installed)?.cli.name || 'claude';
                return (0, providers_1.getProviderList)(cliType).filter(p => p.value !== 'anthropic');
            },
            pageSize: 10
        },
        {
            type: 'input',
            name: 'commandName',
            message: 'What command name?',
            default: (answers) => {
                const provider = (0, providers_1.getProvider)(answers.provider);
                const providerName = provider?.name || answers.provider;
                const cliType = answers.cliType || 'claude';
                if (cliType === 'codex') {
                    return providerName === 'openai' ? 'codex-work' : `codex-${providerName}`;
                }
                const defaultMap = {
                    'minimax': 'claude-mini',
                    'qwen': 'claude-qwen',
                    'kimi': 'claude-kimi',
                    'deepseek': 'claude-deep',
                    'glm': 'claude-glm',
                    'anthropic': 'claude-work'
                };
                return defaultMap[providerName] || 'claude-';
            },
            validate: async (input, answers) => {
                const trimmed = input.trim().toLowerCase();
                if (!trimmed || trimmed.length === 0) {
                    return 'Command name is required';
                }
                if (!/^[a-z0-9-]+$/.test(trimmed)) {
                    return 'Use only lowercase letters, numbers, and hyphens (e.g., "claude-mini", "cmini")';
                }
                if (trimmed === 'claude' || trimmed === 'codex') {
                    return `Cannot use "${trimmed}" - this is reserved for your default account`;
                }
                const cliType = answers.cliType || 'claude';
                const prefix = cliType === 'codex' ? 'codex-' : 'claude-';
                if (!trimmed.startsWith(prefix)) {
                    return `Command name must start with "${prefix}" (e.g., "${prefix}work", "${prefix}pole")`;
                }
                // Check for clashes with existing commands
                const existing = existingProfiles.find(p => p.commandName === trimmed);
                if (existing) {
                    const provider = (0, providers_1.getProvider)(existing.provider);
                    return `Command "${trimmed}" already exists (${provider?.displayName || existing.provider}). Choose a different name.`;
                }
                // Check for system command collisions
                const systemCheck = await (0, systemCommands_1.validateCommandName)(trimmed);
                if (!systemCheck.valid) {
                    return systemCheck.error || 'Invalid command name';
                }
                // Show warning but allow (for non-critical system commands)
                if (systemCheck.warning) {
                    console.log('\n' + chalk_1.default.yellow(systemCheck.warning));
                }
                return true;
            },
            transformer: (input) => input.toLowerCase().trim()
        },
        {
            type: 'list',
            name: 'dataMode',
            message: 'Memory & data setup:',
            choices: (answers) => {
                const profiles = existingProfiles.map(p => p.commandName);
                const masters = ['claude', ...profiles];
                return [
                    {
                        name: chalk_1.default.bold('Fresh') + chalk_1.default.gray(' — fully isolated (own memory, transcripts, plans, commands, plugins)'),
                        value: 'fresh'
                    },
                    {
                        name: chalk_1.default.bold('Shared') + chalk_1.default.gray(' — symlink memory & data to another profile\n') +
                            chalk_1.default.gray('    Same memory, transcripts, plans, tasks, commands, plugins.\n') +
                            chalk_1.default.gray('    Auth & credentials stay separate. Good for: same person, two subscriptions.'),
                        value: 'shared'
                    }
                ];
            }
        },
        {
            type: 'list',
            name: 'sharedWith',
            message: 'Share data with which profile?',
            when: (answers) => answers.dataMode === 'shared',
            choices: (answers) => {
                const cliType = answers.cliType || 'claude';
                const defaultName = cliType === 'codex' ? 'codex' : 'claude';
                const defaultDir = `~/.${defaultName}/`;
                const sameCliProfiles = existingProfiles.filter(p => (p.cliType || 'claude') === cliType);
                return [
                    {
                        name: `${defaultName} ${chalk_1.default.gray(`(your default ${defaultDir})`)}`,
                        value: defaultName
                    },
                    ...sameCliProfiles.map(p => ({
                        name: `${p.commandName} ${chalk_1.default.gray(`(~/.${p.commandName}/)`)}`,
                        value: p.commandName
                    }))
                ];
            }
        },
        {
            type: 'list',
            name: 'authMethod',
            message: 'How would you like to authenticate?',
            choices: (answers) => {
                const provider = answers.provider;
                const cliType = answers.cliType || 'claude';
                const providerConfig = (0, providers_1.getProvider)(provider);
                // OAuth only available for official providers (anthropic for claude, openai for codex)
                if ((cliType === 'claude' && provider === 'anthropic') ||
                    (cliType === 'codex' && provider === 'openai')) {
                    return [
                        {
                            name: 'OAuth (browser login - adds another account without logging out)',
                            value: 'oauth'
                        },
                        {
                            name: 'API Key (static token from platform.anthropic.com)',
                            value: 'api-key'
                        }
                    ];
                }
                // Local providers — auth is optional
                if (providerConfig?.authOptional) {
                    return [
                        {
                            name: 'None (local provider, no auth needed)',
                            value: 'none'
                        },
                        {
                            name: 'API Key (if your local setup requires one)',
                            value: 'api-key'
                        }
                    ];
                }
                // For third-party providers, only API key is available
                return [
                    {
                        name: 'API Key (required for external providers)',
                        value: 'api-key'
                    }
                ];
            },
            default: (answers) => {
                const cliType = answers.cliType || 'claude';
                const provider = answers.provider;
                const providerConfig = (0, providers_1.getProvider)(provider);
                // Default to OAuth for official subscription providers
                if ((cliType === 'claude' && provider === 'anthropic') ||
                    (cliType === 'codex' && provider === 'openai')) {
                    return 'oauth';
                }
                // Default to no auth for local providers
                if (providerConfig?.authOptional) {
                    return 'none';
                }
                return 'api-key';
            }
        },
        {
            type: 'password',
            name: 'apiKey',
            message: (answers) => {
                const provider = (0, providers_1.getProvider)(answers.provider);
                return `Enter API key for ${provider?.displayName}:`;
            },
            mask: '*',
            when: (answers) => answers.authMethod === 'api-key',
            validate: (input) => {
                if (!input || input.trim().length === 0) {
                    return 'API key is required';
                }
                return true;
            }
        }
    ]);
    // Set CLI type (default to first installed if not explicitly chosen)
    const cliType = answers.cliType || detectedCLIs.find(d => d.installed)?.cli.name || 'claude';
    // Handle custom provider setup
    let customProviderConfig;
    let customProviderPrompts;
    if (answers.provider === 'custom') {
        console.log(); // Add spacing before custom provider prompts
        customProviderPrompts = await (0, customProvider_1.promptCustomProvider)();
        customProviderConfig = (0, customProvider_1.createCustomProviderConfig)(customProviderPrompts, answers.commandName);
        // Show summary of custom provider
        console.log(chalk_1.default.green('\n✓ Custom provider configured:'));
        console.log(chalk_1.default.cyan('  Base URL:'), customProviderConfig.baseUrl);
        console.log(chalk_1.default.cyan('  API Format:'), customProviderConfig.apiFormat);
        console.log(chalk_1.default.cyan('  Model:'), customProviderConfig.defaultModel);
        console.log();
    }
    return {
        cliType,
        provider: answers.provider,
        commandName: answers.commandName.toLowerCase().trim(),
        apiKey: answers.apiKey ? answers.apiKey.trim() : undefined,
        authMethod: answers.authMethod,
        customProviderConfig,
        customProviderPrompts,
        sharedWith: answers.dataMode === 'shared' ? answers.sharedWith : undefined
    };
}
async function confirmRemoveProvider(commandName) {
    const { confirm } = await inquirer_1.default.prompt([
        {
            type: 'confirm',
            name: 'confirm',
            message: `Are you sure you want to remove '${commandName}'?`,
            default: false
        }
    ]);
    return confirm;
}
