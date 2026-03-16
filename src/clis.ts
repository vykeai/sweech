/**
 * Supported CLI types and their configurations
 * This allows sweetch to manage multiple AI coding CLIs
 */

export interface CLIConfig {
  name: string;
  displayName: string;
  command: string;
  configDirEnvVar: string;
  description: string;
  installUrl?: string;
  checkInstalled?: () => boolean;
  yoloFlag?: string;   // The actual CLI flag for skip-permissions mode
  resumeFlag?: string; // Flag/subcommand to resume last session
}

export const SUPPORTED_CLIS: Record<string, CLIConfig> = {
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
  cursor: {
    name: 'cursor',
    displayName: 'Cursor',
    command: 'cursor',
    configDirEnvVar: 'CURSOR_CONFIG_DIR',
    description: 'Cursor AI IDE',
    installUrl: 'https://cursor.sh/',
    yoloFlag: '--yolo',
    resumeFlag: '--resume',
  },
  windsurf: {
    name: 'windsurf',
    displayName: 'Windsurf',
    command: 'windsurf',
    configDirEnvVar: 'WINDSURF_CONFIG_DIR',
    description: 'Windsurf AI coding assistant',
    installUrl: 'https://windsurf.ai/',
    yoloFlag: '--yolo',
    resumeFlag: '--resume',
  },
  aider: {
    name: 'aider',
    displayName: 'Aider',
    command: 'aider',
    configDirEnvVar: 'AIDER_CONFIG_DIR',
    description: 'Aider AI pair programming',
    installUrl: 'https://aider.chat/',
    yoloFlag: '--yes',
  },
  gemini: {
    name: 'gemini',
    displayName: 'Gemini CLI',
    command: 'gemini',
    configDirEnvVar: 'GEMINI_CONFIG_DIR',
    description: 'Google Gemini CLI',
    yoloFlag: '--sandbox=none',
  },
  amazonq: {
    name: 'amazonq',
    displayName: 'Amazon Q',
    command: 'q',
    configDirEnvVar: 'Q_CONFIG_DIR',
    description: 'Amazon Q Developer CLI',
    yoloFlag: '--trust-all-tools',
  },
};

export function getCLI(name: string): CLIConfig | undefined {
  return SUPPORTED_CLIS[name];
}

export function getDefaultCLI(): CLIConfig {
  return SUPPORTED_CLIS.claude;
}

export function getCLIList(): Array<{ name: string; value: string }> {
  return Object.values(SUPPORTED_CLIS).map(cli => ({
    name: `${cli.displayName} - ${cli.description}`,
    value: cli.name
  }));
}
