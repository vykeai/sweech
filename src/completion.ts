/**
 * Shell completion script generation and dynamic completion handler
 */

import { ConfigManager } from './config';
import { AliasManager } from './aliases';

/** All top-level subcommands */
const ALL_COMMANDS = [
  'init', 'add', 'list', 'ls', 'remove', 'rm', 'info',
  'update-wrappers', 'backup', 'backup-claude', 'restore',
  'stats', 'show', 'use', 'launch', 'run', 'auth', 'alias', 'discover', 'completion',
  'doctor', 'path', 'test', 'edit', 'clone', 'rename',
  'backup-chats', 'serve', 'usage', 'reset', 'update',
  'sessions', 'sync', 'audit', 'team', 'plugins',
  'peers', 'templates', 'share', 'unshare',
];

/** Commands that accept a profile name as first argument */
const PROFILE_COMMANDS = new Set([
  'remove', 'rm', 'show', 'stats', 'test', 'edit', 'clone', 'rename', 'backup-chats', 'use', 'launch', 'run', 'auth', 'share', 'unshare',
]);

/** Sort modes for `usage --sort` */
const USAGE_SORT_MODES = ['smart', 'status', 'manual'];

/** Sort fields for `stats --sort` */
const STATS_SORT_FIELDS = ['uses', 'recent', 'name'];

/**
 * Handle dynamic completion for `sweech --complete "<line>"`.
 * Returns one completion candidate per line on stdout.
 */
export function handleComplete(line: string): string[] {
  const parts = line.trim().split(/\s+/);

  // Remove the leading 'sweech' if present
  if (parts[0] === 'sweech') parts.shift();

  // No subcommand yet — complete subcommands
  if (parts.length === 0) return ALL_COMMANDS;

  const subcommand = parts[0];
  const trailingSpace = line.endsWith(' ');
  const argIndex = trailingSpace ? parts.length : parts.length - 1;
  const partial = trailingSpace ? '' : parts[parts.length - 1];

  // Still completing the subcommand itself (first word, no trailing space)
  if (argIndex === 0) {
    return ALL_COMMANDS.filter(c => c.startsWith(partial));
  }

  // Check for flag completions anywhere in the line
  const prevWord = trailingSpace ? parts[parts.length - 1] : parts[parts.length - 2];

  if (prevWord === '--sort') {
    if (subcommand === 'usage') {
      return USAGE_SORT_MODES.filter(m => m.startsWith(partial));
    }
    if (subcommand === 'stats') {
      return STATS_SORT_FIELDS.filter(f => f.startsWith(partial));
    }
  }

  // Profile name completions
  if (PROFILE_COMMANDS.has(subcommand) && argIndex === 1) {
    const config = new ConfigManager();
    const profiles = config.getProfiles();
    const names = profiles.map(p => p.commandName);
    return names.filter(n => n.startsWith(partial));
  }

  // alias subcommand
  if (subcommand === 'alias') {
    if (argIndex === 1) {
      return ['list', 'remove'].filter(a => a.startsWith(partial));
    }
    if (argIndex === 2 && parts[1] === 'remove') {
      const aliasManager = new AliasManager();
      const aliases = Object.keys(aliasManager.getAliases());
      return aliases.filter(a => a.startsWith(partial));
    }
  }

  // completion shell argument
  if (subcommand === 'completion' && argIndex === 1) {
    return ['bash', 'zsh', 'fish'].filter(s => s.startsWith(partial));
  }

  // Flag completions (when partial starts with -)
  if (partial.startsWith('-') || (trailingSpace && false)) {
    // Could extend further per-command, but leave generic for now
  }

  return [];
}

export function generateBashCompletion(): string {
  const config = new ConfigManager();
  const aliasManager = new AliasManager();
  const profiles = config.getProfiles();
  const aliases = aliasManager.getAliases();

  const commandNames = profiles.map(p => p.commandName).join(' ');
  const aliasNames = Object.keys(aliases).join(' ');

  return `# Bash completion for sweech
_sweech_completion() {
    local cur prev commands
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    # Try dynamic completions first (reads live config)
    if command -v sweech &>/dev/null; then
        local line="\${COMP_WORDS[*]}"
        local completions
        completions="$(sweech --complete "\${line}" 2>/dev/null)"
        if [[ $? -eq 0 && -n "\${completions}" ]]; then
            COMPREPLY=( $(compgen -W "\${completions}" -- "\${cur}") )
            return 0
        fi
    fi

    # Fallback: static completions (from when this script was generated)
    commands="add list ls remove rm info backup restore stats show alias discover completion init update-wrappers backup-claude doctor path test edit clone rename backup-chats serve usage reset update sessions sync audit team plugins peers templates"

    case "\${prev}" in
        sweech)
            COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
            return 0
            ;;
        remove|rm|show|stats|edit|test|clone|rename|backup-chats)
            local profiles="${commandNames}"
            COMPREPLY=( $(compgen -W "\${profiles}" -- "\${cur}") )
            return 0
            ;;
        --sort)
            local second_word="\${COMP_WORDS[1]}"
            if [[ "\${second_word}" == "usage" ]]; then
                COMPREPLY=( $(compgen -W "smart status manual" -- "\${cur}") )
            elif [[ "\${second_word}" == "stats" ]]; then
                COMPREPLY=( $(compgen -W "uses recent name" -- "\${cur}") )
            fi
            return 0
            ;;
        alias)
            if [[ \${COMP_CWORD} -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "list remove" -- "\${cur}") )
            elif [[ \${COMP_CWORD} -eq 3 && "\${COMP_WORDS[2]}" == "remove" ]]; then
                local aliases="${aliasNames}"
                COMPREPLY=( $(compgen -W "\${aliases}" -- "\${cur}") )
            fi
            return 0
            ;;
        completion)
            COMPREPLY=( $(compgen -W "bash zsh" -- "\${cur}") )
            return 0
            ;;
    esac
}

complete -F _sweech_completion sweech
`;
}

export function generateZshCompletion(): string {
  const config = new ConfigManager();
  const aliasManager = new AliasManager();
  const profiles = config.getProfiles();
  const aliases = aliasManager.getAliases();

  const commandNames = profiles.map(p => p.commandName).join(' ');
  const aliasNames = Object.keys(aliases).join(' ');

  return `#compdef sweech

_sweech() {
    local -a commands profiles aliases_list

    commands=(
        'init:Interactive onboarding'
        'add:Add a new provider'
        'list:List all configured providers'
        'ls:List all configured providers (alias)'
        'remove:Remove a configured provider'
        'rm:Remove a configured provider (alias)'
        'info:Show sweech configuration'
        'update-wrappers:Regenerate CLI wrapper scripts'
        'backup:Create encrypted backup'
        'backup-claude:Backup Claude configuration'
        'restore:Restore from backup'
        'stats:Show usage statistics'
        'show:Show provider details'
        'alias:Manage command aliases'
        'discover:Discover available providers'
        'completion:Generate shell completion'
        'doctor:Check installation health'
        'path:Show config path'
        'test:Test a provider connection'
        'edit:Edit a provider config'
        'clone:Clone a profile'
        'rename:Rename a profile'
        'backup-chats:Backup chat history'
        'serve:Start federation server'
        'usage:Show account usage windows'
        'reset:Reset to defaults'
        'update:Update sweech'
        'sessions:Manage sessions'
        'sync:Sync configuration'
        'audit:Audit configuration'
        'team:Team management'
        'plugins:Manage plugins'
        'peers:Manage federation peers'
        'templates:Manage profile templates'
    )

    # Dynamic completions via --complete
    if (( \$+commands[sweech] )); then
        local line="\${words[*]}"
        local -a dynamic_completions
        dynamic_completions=(\${(f)"$(sweech --complete "\${line}" 2>/dev/null)"})
        if [[ \$? -eq 0 && \${#dynamic_completions} -gt 0 && "\${dynamic_completions[1]}" != "" ]]; then
            _describe 'dynamic completions' dynamic_completions
            return
        fi
    fi

    # Fallback: static completions
    profiles=(${commandNames})
    aliases_list=(${aliasNames})

    case "$state" in
        command)
            _describe 'sweech commands' commands
            ;;
        profile)
            _arguments "*:profile:($profiles)"
            ;;
        alias_name)
            _arguments "*:alias:($aliases_list)"
            ;;
    esac

    case $words[2] in
        remove|rm|show|stats|edit|test|clone|rename|backup-chats)
            _arguments "*:profile:($profiles)"
            ;;
        usage)
            _arguments \\
                '--json[Output machine-readable JSON]' \\
                '--refresh[Force-refresh live usage]' \\
                '--sort[Sort order]:sort mode:(smart status manual)' \\
                '--no-group[Show all in one list]' \\
                '-m[Show per-model breakdowns]' \\
                '--models[Show per-model breakdowns]'
            ;;
        stats)
            _arguments \\
                '*:profile:($profiles)' \\
                '--json[Output as JSON]' \\
                '--sort[Sort by]:sort field:(uses recent name)'
            ;;
        alias)
            if [[ $words[3] == "remove" ]]; then
                _arguments "*:alias:($aliases_list)"
            else
                _arguments "1:action:(list remove)"
            fi
            ;;
        completion)
            _arguments "1:shell:(bash zsh fish)"
            ;;
    esac
}

_sweech "$@"
`;
}

/**
 * Top-level subcommands paired with their fish-friendly descriptions.
 * Kept inline (not pulled from Commander) so that the generator works
 * even when invoked from a stripped install.
 */
const FISH_SUBCOMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['init', 'Interactive onboarding'],
  ['add', 'Add a new provider'],
  ['list', 'List all configured workspaces'],
  ['ls', 'List all configured workspaces (alias)'],
  ['remove', 'Remove a configured provider'],
  ['rm', 'Remove a configured provider (alias)'],
  ['info', 'Show sweech configuration'],
  ['update-wrappers', 'Regenerate CLI wrapper scripts'],
  ['backup', 'Create encrypted backup'],
  ['backup-claude', 'Backup Claude configuration'],
  ['restore', 'Restore from backup'],
  ['stats', 'Show usage statistics'],
  ['show', 'Show provider details'],
  ['use', 'Launch a workspace'],
  ['launch', 'Launch a workspace (alias)'],
  ['run', 'Run a workspace command'],
  ['auth', 'Manage workspace authentication'],
  ['alias', 'Manage command aliases'],
  ['discover', 'Discover available providers'],
  ['completion', 'Generate shell completion script'],
  ['doctor', 'Check installation health'],
  ['path', 'Show config path'],
  ['test', 'Test a provider connection'],
  ['edit', 'Edit a provider config'],
  ['clone', 'Clone a profile'],
  ['rename', 'Rename a profile'],
  ['backup-chats', 'Backup chat history'],
  ['serve', 'Start federation server'],
  ['usage', 'Show account usage windows'],
  ['reset', 'Reset to defaults'],
  ['update', 'Update sweech'],
  ['sessions', 'Manage sessions'],
  ['sync', 'Sync configuration'],
  ['audit', 'Audit configuration'],
  ['team', 'Team management'],
  ['plugins', 'Manage plugins'],
  ['peers', 'Manage federation peers'],
  ['templates', 'Manage profile templates'],
  ['share', 'Share a profile with a peer'],
  ['unshare', 'Revoke a shared profile'],
];

/** Subcommands that take a workspace/profile name as their first positional. */
const FISH_WORKSPACE_COMMANDS = [
  'remove', 'rm', 'show', 'stats', 'use', 'launch', 'run', 'auth',
  'test', 'edit', 'clone', 'rename', 'backup-chats', 'share', 'unshare',
];

/**
 * Escape a description for safe use inside a single-quoted fish argument.
 * Fish only requires escaping single quotes and backslashes inside '...'.
 */
function fishEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function generateFishCompletion(): string {
  const config = new ConfigManager();
  const aliasManager = new AliasManager();
  const profiles = config.getProfiles();
  const aliases = aliasManager.getAliases();

  const commandNames = profiles.map(p => p.commandName);
  const aliasNames = Object.keys(aliases);

  const lines: string[] = [];
  lines.push('# Fish completion for sweech');
  lines.push('# Install: sweech completion fish > ~/.config/fish/completions/sweech.fish');
  lines.push('');

  // Disable file completion by default — we will add it back where useful.
  lines.push('complete -c sweech -f');
  lines.push('');

  // Helper function: emit dynamic workspace names by calling sweech itself.
  // Falls back to the snapshot list baked in below if the live call fails.
  lines.push('function __sweech_workspaces');
  lines.push('    command sweech list --json 2>/dev/null | command jq -r \'.workspaces[]?.commandName\' 2>/dev/null');
  lines.push('end');
  lines.push('');

  // Subcommands — only when no subcommand has been chosen yet.
  lines.push('# Subcommands');
  for (const [name, desc] of FISH_SUBCOMMANDS) {
    lines.push(`complete -c sweech -n __fish_use_subcommand -a ${name} -d '${fishEscape(desc)}'`);
  }
  lines.push('');

  // Workspace name completion — only after workspace-accepting subcommands.
  const wsCondition = `__fish_seen_subcommand_from ${FISH_WORKSPACE_COMMANDS.join(' ')}`;
  lines.push('# Workspace names (dynamic via `sweech list --json`)');
  lines.push(`complete -c sweech -n '${wsCondition}' -a '(__sweech_workspaces)' -d Workspace`);
  // Snapshot fallback so completion works even without jq or a live sweech.
  if (commandNames.length > 0) {
    lines.push(`complete -c sweech -n '${wsCondition}' -a '${commandNames.join(' ')}' -d Workspace`);
  }
  lines.push('');

  // `completion <shell>` — restrict to bash | zsh | fish.
  lines.push('# completion <shell>');
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish' -d Shell");
  lines.push('');

  // `alias <action> [name]`
  lines.push('# alias <action>');
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from alias; and not __fish_seen_argument_from list remove' -a list -d 'List aliases'");
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from alias; and not __fish_seen_argument_from list remove' -a remove -d 'Remove an alias'");
  if (aliasNames.length > 0) {
    lines.push(`complete -c sweech -n '__fish_seen_subcommand_from alias; and __fish_seen_argument_from remove' -a '${aliasNames.join(' ')}' -d Alias`);
  }
  lines.push('');

  // --sort modes for usage / stats.
  lines.push('# --sort values');
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from usage' -l sort -xa 'smart status manual' -d 'Sort order'");
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from stats' -l sort -xa 'uses recent name' -d 'Sort field'");
  lines.push('');

  // Common top-level flags.
  lines.push('# Top-level flags');
  lines.push("complete -c sweech -l help -d 'Show help'");
  lines.push("complete -c sweech -s h -d 'Show help'");
  lines.push("complete -c sweech -l version -d 'Show version'");
  lines.push("complete -c sweech -s V -d 'Show version'");
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from list ls' -l json -d 'Output as JSON'");
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from list ls' -l refresh -d 'Force live quota fetch'");
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from stats usage' -l json -d 'Output as JSON'");
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from usage' -l refresh -d 'Force-refresh live usage'");
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from usage' -l no-group -d 'Show all workspaces in one list'");
  lines.push("complete -c sweech -n '__fish_seen_subcommand_from usage' -s m -l models -d 'Show per-model breakdowns'");
  lines.push('');

  return lines.join('\n') + '\n';
}
