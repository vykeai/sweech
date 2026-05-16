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
  agentsCommand?: string[]; // Subcommand for "show me my agents"
  sessionsCommand?: string[]; // Subcommand for "show me my past sessions"
  sessionNameFlag?: string; // CLI flag that sets a display name for a new session
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
    // --continue is the right default: resumes the cwd's most-recent session
    // without going through an account-level picker. claude --resume (the
    // picker) re-checks OAuth state and can force a re-login flow which is
    // undesirable for an automated launch. Crashed sessions that died with no
    // deferred-tool marker need to be resumed by explicit session id instead.
    resumeFlag: '--continue',
    agentsCommand: ['agents'],
    sessionsCommand: ['--resume'],
    sessionNameFlag: '--name',
  },
  codex: {
    name: 'codex',
    displayName: 'Codex (OpenAI)',
    command: 'codex',
    configDirEnvVar: 'CODEX_HOME',
    description: 'OpenAI Codex CLI - lightweight coding agent',
    installUrl: 'https://github.com/openai/codex',
    yoloFlag: '--dangerously-bypass-approvals-and-sandbox',
    // `resume` (no --last) opens the cwd-filtered picker which scans the
    // sessions/ directory — symlinked across shared profiles. `--last` queries
    // logs_2.sqlite which is per-profile (intentionally not shared, since the
    // codex app-server caches account-specific rate-limits there), so on a
    // shared profile like codex-ted, --last finds nothing even when the
    // master codex profile has recent sessions.
    resumeFlag: 'resume',
    agentsCommand: ['resume'], // codex has no `agents` — picker for prior sessions is closest
    sessionsCommand: ['resume'], // codex resume is the cwd-filtered session picker
    // codex has no equivalent of claude's --name (sessions are identified by cwd + id)
  },
  kimi: {
    name: 'kimi',
    displayName: 'Kimi (Moonshot AI)',
    command: 'kimi',
    configDirEnvVar: 'KIMI_SHARE_DIR',
    description: 'Kimi CLI - AI coding agent by Moonshot AI',
    installUrl: 'https://moonshotai.github.io/kimi-cli/',
    yoloFlag: '--yolo',
    resumeFlag: '--continue',
    // kimi has no agents/session picker exposed
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
