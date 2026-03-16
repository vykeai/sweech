"use strict";
/**
 * Supported CLI types and their configurations
 * This allows sweetch to manage multiple AI coding CLIs
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORTED_CLIS = void 0;
exports.getCLI = getCLI;
exports.getDefaultCLI = getDefaultCLI;
exports.getCLIList = getCLIList;
exports.SUPPORTED_CLIS = {
    claude: {
        name: 'claude',
        displayName: 'Claude Code',
        command: 'claude',
        configDirEnvVar: 'CLAUDE_CONFIG_DIR',
        description: 'Anthropic Claude Code CLI',
        installUrl: 'https://code.claude.com/',
        yoloFlag: '--dangerously-skip-permissions',
        resumeFlag: '--continue',
    },
    codex: {
        name: 'codex',
        displayName: 'Codex (OpenAI)',
        command: 'codex',
        configDirEnvVar: 'CODEX_HOME',
        description: 'OpenAI Codex CLI - lightweight coding agent',
        installUrl: 'https://github.com/openai/codex',
        yoloFlag: '--yolo',
        resumeFlag: 'resume --last',
    },
};
function getCLI(name) {
    return exports.SUPPORTED_CLIS[name];
}
function getDefaultCLI() {
    return exports.SUPPORTED_CLIS.claude;
}
function getCLIList() {
    return Object.values(exports.SUPPORTED_CLIS).map(cli => ({
        name: `${cli.displayName} - ${cli.description}`,
        value: cli.name
    }));
}
