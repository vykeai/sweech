"use strict";
/**
 * Shared profile creation logic for add and init commands
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProfile = createProfile;
const chalk_1 = __importDefault(require("chalk"));
const oauth_1 = require("./oauth");
const plugins_1 = require("./plugins");
/**
 * Create a new profile with OAuth or API key authentication
 */
async function createProfile(answers, provider, cli, config) {
    // Determine if we should use native CLI authentication (OAuth flow)
    // Use native auth when:
    // - User selected OAuth AND
    // - Using official provider (anthropic for claude, openai for codex)
    const isOfficialProvider = (cli.name === 'claude' && answers.provider === 'anthropic') ||
        (cli.name === 'codex' && answers.provider === 'openai');
    const useNativeAuth = answers.authMethod === 'oauth' && isOfficialProvider;
    // Handle OAuth if selected (but not for native auth - CLI handles it)
    let oauthToken = undefined;
    if (answers.authMethod === 'oauth' && !useNativeAuth) {
        oauthToken = await (0, oauth_1.getOAuthToken)(cli.name, answers.provider);
        console.log(chalk_1.default.green('✓ OAuth authentication successful'));
    }
    // Create profile object
    const profile = {
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
    config.createProfileConfig(answers.commandName, provider, answers.apiKey, cli.name, oauthToken, useNativeAuth);
    config.createWrapperScript(answers.commandName, cli);
    // Set up shared dirs if symlink mode
    if (answers.sharedWith) {
        config.setupSharedDirs(answers.commandName, answers.sharedWith, answers.cliType);
    }
    // Run plugin onProfileCreate hooks (errors are caught inside runHook)
    try {
        (0, plugins_1.runHook)('onProfileCreate', profile);
    }
    catch { /* plugin errors must not crash CLI */ }
    // Display success message
    console.log(chalk_1.default.green('\n✓ Provider added successfully!\n'));
    console.log(chalk_1.default.cyan('Command:'), chalk_1.default.bold(answers.commandName));
    console.log(chalk_1.default.cyan('Provider:'), provider.displayName);
    if (answers.sharedWith) {
        console.log(chalk_1.default.cyan('Data:'), `Shared with ${chalk_1.default.bold(answers.sharedWith)} (projects, plans, tasks, commands, plugins, hooks, agents, teams, todos, mcp.json, CLAUDE.md)`);
    }
    if (useNativeAuth) {
        console.log(chalk_1.default.cyan('Auth:'), 'OAuth (via CLI)');
        console.log();
        console.log(chalk_1.default.blue('ℹ'), chalk_1.default.gray(`Run ${chalk_1.default.cyan(answers.commandName)} to log in with your account`));
    }
    else {
        console.log(chalk_1.default.cyan('Model:'), provider.defaultModel);
        if (answers.authMethod === 'oauth') {
            console.log(chalk_1.default.cyan('Auth:'), 'OAuth Token');
        }
    }
}
