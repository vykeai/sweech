# 🍭 Sweech Architecture

This document explains how Sweech is architected to support multiple AI coding CLIs and providers.

## Design Goals

1. **CLI Agnostic** - Support Claude Code and Codex (OpenAI)
2. **Provider Flexible** - Easy to add new API providers (Qwen, MiniMax, etc.)
3. **Isolated Configs** - Each profile has its own configuration directory
4. **Wrapper-based** - Minimal code, maximum compatibility
5. **Extensible** - Easy to add new features without breaking existing configs

## Core Concepts

### Profile

A **profile** is a complete configuration for one AI assistant instance:

```typescript
{
  name: "claude-mini",
  commandName: "claude-mini",        // Command to invoke
  cliType: "claude",                 // Which CLI (claude or codex)
  provider: "minimax",               // API provider (minimax, qwen, etc.)
  apiKey: "sk-...",                  // API key
  baseUrl: "https://...",            // Provider API endpoint
  model: "MiniMax-M2",               // Model name
  createdAt: "2025-02-03T...",
  sharedWith?: "claude"              // Optional: commandName of master profile
}
```

**Shared Data Mode** — When `sharedWith` is set, the profile's `projects`, `plans`, `tasks`, `commands`, and `plugins` directories are symlinked to the master profile's corresponding directories. Auth files (`settings.json`, credentials) always remain isolated per profile.

### CLI

A **CLI** is the base coding assistant tool:

```typescript
{
  name: "claude",
  displayName: "Claude Code",
  command: "claude",                 // Binary name
  configDirEnvVar: "CLAUDE_CONFIG_DIR", // Environment variable
  description: "Anthropic Claude Code CLI"
}
```

Currently supported:
- ✅ Claude Code (Anthropic API)
- ✅ Codex (OpenAI API)

### Provider

A **provider** is an API backend:

```typescript
{
  name: "minimax",
  displayName: "MiniMax",
  baseUrl: "https://api.minimax.io/anthropic",
  defaultModel: "MiniMax-M2",
  description: "MiniMax M2 coding model"
}
```

Currently supported:
- Claude (Anthropic)
- Qwen (Alibaba)
- MiniMax
- Kimi (Moonshot AI)
- DeepSeek
- GLM (Zhipu)

## File Structure

```
~/
├── .claude/              # Default account (never touched by sweech)
│   ├── projects/         # Memory & project context
│   ├── plans/
│   ├── tasks/
│   ├── commands/
│   └── plugins/
├── .claude-qwen/         # Fresh profile (sibling to .claude/, fully isolated)
│   └── settings.json     # CLI-specific settings
├── .claude-rai/          # Shared profile (sibling to .claude/)
│   ├── settings.json     # Own auth (isolated)
│   ├── projects -> ../.claude/projects   # Symlink to master
│   ├── plans    -> ../.claude/plans      # Symlink to master
│   ├── tasks    -> ../.claude/tasks      # Symlink to master
│   ├── commands -> ../.claude/commands   # Symlink to master
│   └── plugins  -> ../.claude/plugins    # Symlink to master
└── .sweech/
    ├── config.json       # List of all profiles (includes sharedWith)
    ├── aliases.json      # Command aliases (work=claude-qwen)
    ├── usage.json        # Usage tracking data
    ├── last-launch.json  # Remembered launcher state
    └── bin/
        ├── claude-qwen   # Wrapper script
        └── claude-rai    # Wrapper script
```

Profile directories live at `~/.claude-<name>/` as siblings to `~/.claude/`.
All command names must start with `claude-`.

### config.json

Master list of profiles:

```json
[
  {
    "name": "claude-mini",
    "commandName": "claude-mini",
    "cliType": "claude",
    "provider": "minimax",
    "apiKey": "sk-...",
    "baseUrl": "https://api.minimax.io/anthropic",
    "model": "MiniMax-M2",
    "createdAt": "2025-02-03T..."
  },
  {
    "name": "claude-rai",
    "commandName": "claude-rai",
    "cliType": "claude",
    "provider": "anthropic",
    "createdAt": "2025-02-03T...",
    "sharedWith": "claude"
  }
]
```

The `sharedWith` field stores the `commandName` of the master profile. `"claude"` refers to the default `~/.claude/` directory.

### settings.json

CLI-specific configuration (for Claude Code):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimax.io/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "MiniMax-M2",
    "API_TIMEOUT_MS": "3000000"
  }
}
```

### Wrapper Script

Bash script that sets environment variables:

```bash
#!/bin/bash
# 🍭 Sweech wrapper for claude-qwen (Claude Code)
export CLAUDE_CONFIG_DIR="/Users/you/.claude-qwen"
exec claude "$@"
```

## How It Works

### Adding a Provider

1. **Interactive prompt** - User selects provider and enters details
2. **Create profile** - Add entry to `config.json`
3. **Generate settings** - Create `profiles/<name>/settings.json`
4. **Create wrapper** - Generate executable script in `bin/<name>`
5. **Done!** - User can now run the command

### Invoking a Command

```bash
$ claude-mini
```

1. Shell finds `~/.sweech/bin/claude-qwen`
2. Wrapper exports `CLAUDE_CONFIG_DIR=/Users/you/.claude-qwen`
3. Wrapper executes `claude "$@"`
4. Claude reads config from the sibling directory
5. Claude uses the configured provider with specified settings

### Backup Process

1. **User initiates** - `sweetch backup`
2. **Ask password** - Prompt for encryption password
3. **Create ZIP** - Archive `profiles/`, `bin/`, and `config.json`
4. **Encrypt** - AES-256 encrypt the ZIP file
5. **Save** - Write encrypted file to disk

### Restore Process

1. **User initiates** - `sweetch restore backup.zip`
2. **Ask password** - Prompt for decryption password
3. **Decrypt** - Decrypt the backup file
4. **Extract** - Unzip to `~/.sweech/`
5. **Permissions** - Make wrapper scripts executable
6. **Done!** - All profiles restored

## Code Organization

```
src/
├── cli.ts              # Main CLI entry point (commander) — includes update command
├── launcher.ts         # Interactive TUI launcher (raw terminal) — shared tag, model label
├── config.ts           # Config manager — SHAREABLE_DIRS, setupSharedDirs, sharedWith
├── providers.ts        # Provider templates
├── clis.ts             # CLI definitions (claude, codex) + yolo flags
├── interactive.ts      # Interactive prompts — dataMode + sharedWith prompts
├── profileCreation.ts  # Profile creation flow (OAuth + setupSharedDirs)
├── backup.ts           # Backup/restore logic (encryption)
├── usage.ts            # Usage tracking and statistics
├── aliases.ts          # Command alias management
├── completion.ts       # Shell completion generation
├── systemCommands.ts   # System command collision detection
├── utilityCommands.ts  # doctor, path, test, edit, clone, rename — symlink check, clone sharing
├── reset.ts            # Safe reset/uninstall
├── init.ts             # Interactive onboarding
└── oauth.ts            # OAuth token management
```

### Key Classes

**ConfigManager** (`config.ts`)
- Manages `~/.sweech/` directory
- CRUD operations for profiles
- Creates wrapper scripts
- Handles backward compatibility

**Methods:**
- `getProfiles()` - List all profiles
- `addProfile(profile)` - Add new profile
- `removeProfile(name)` - Delete profile (unlinks symlinked dirs instead of deleting)
- `createProfileConfig()` - Generate settings.json
- `createWrapperScript()` - Generate wrapper script (with usage tracking)
- `setupSharedDirs(commandName, masterCommandName)` - Symlink SHAREABLE_DIRS from a new profile to a master profile

**UsageTracker** (`usage.ts`)
- Tracks provider usage with timestamps
- Stores data in `~/.sweech/usage.json`
- Calculates statistics (total uses, frequency, last used)

**Methods:**
- `logUsage(commandName)` - Log a command execution
- `getStats(commandName?)` - Get usage statistics
- `clearStats(commandName?)` - Clear usage data

**AliasManager** (`aliases.ts`)
- Manages command aliases (shortcuts)
- Stores aliases in `~/.sweech/aliases.json`
- Resolves aliases to actual commands

**Methods:**
- `getAliases()` - Get all aliases
- `addAlias(alias, command)` - Add new alias
- `removeAlias(alias)` - Remove alias
- `resolveAlias(name)` - Resolve alias to command

## Shared Data System

### SHAREABLE_DIRS

Defined in `config.ts`:

```typescript
export const SHAREABLE_DIRS = ['projects', 'plans', 'tasks', 'commands', 'plugins'] as const;
```

These directories contain memory, transcripts, plans, tasks, custom commands, and plugins — all safe to share across profiles.

**NOT shared:** `settings.json`, `cache`, `session-env`, shell snapshots, credentials. These are auth and runtime data that must remain per-profile.

### setupSharedDirs

When `dataMode === 'shared'` during `sweech add` (or `sweech clone` with inheritance), `ConfigManager.setupSharedDirs(commandName, masterCommandName)` is called:

1. Determine `masterDir` — either `~/.claude/` (if master is `'claude'`) or `~/.claude-<master>/`
2. For each dir in `SHAREABLE_DIRS`:
   - Ensure the target dir exists in master (create it if not)
   - Remove any existing dir/symlink at the profile's link path
   - Create a symlink: `~/.claude-<name>/<dir>` → `<masterDir>/<dir>`

### Symlink-aware removeProfile

`ConfigManager.removeProfile(commandName)` uses `lstatSync` to detect whether the profile directory is itself a symlink. If so, it uses `unlinkSync` instead of `rmSync` to preserve shared data in the master.

### Doctor Symlink Check

`runDoctor()` in `utilityCommands.ts` loops over `SHAREABLE_DIRS` for each profile that has `sharedWith` set. For each dir, it:

1. Calls `lstatSync` on the link path to check it's a symlink
2. Calls `realpathSync` on both the link and the expected target
3. Reports ✓ if they resolve to the same canonical path, ✗ otherwise

## Feature Details

### Usage Tracking

Wrapper scripts automatically log usage when executed:
- Logs to `~/.sweech/usage.json` in background
- Stores: command name, ISO timestamp
- Keeps last 1000 records
- Non-blocking (runs in background process)

Display statistics:
```bash
sweetch stats              # All providers
sweetch stats claude-mini  # Specific provider
```

### Command Aliases

Create shortcuts for frequently used commands:
```bash
sweetch alias work=claude-mini
sweetch alias personal=claude-qwen
```

Then use:
```bash
work      # Runs claude-mini
personal  # Runs claude-qwen
```

Aliases are resolved by the alias manager and stored in `aliases.json`.

### Provider Discovery

Shows all available providers with:
- Configuration status (✓ configured, ○ not configured)
- Description and pricing
- Default models
- Your existing command names

### Shell Completion

Generates completion scripts for bash/zsh with:
- Command completion (add, list, remove, etc.)
- Provider name completion
- Alias completion
- Subcommand completion

## Adding New Provider

To add a new provider (e.g., Gemini):

### 1. Define the Provider

Edit `src/providers.ts`:

```typescript
export const PROVIDERS: Record<string, ProviderConfig> = {
  // ... existing providers
  gemini: {
    name: 'gemini',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/anthropic',
    defaultModel: 'gemini-pro',
    description: 'Google Gemini models',
    pricing: 'Free tier + pay-as-you-go'
  }
};
```

### 2. Test

```bash
npm run build
sweetch add
# Select Gemini, enter API key
# Done! Provider is ready
```

No code changes needed elsewhere - the system is fully data-driven!

## Environment Variables

Each CLI has its own environment variables:

### Claude Code
- `CLAUDE_CONFIG_DIR` - Config directory
- `ANTHROPIC_BASE_URL` - API endpoint
- `ANTHROPIC_AUTH_TOKEN` - API key
- `ANTHROPIC_MODEL` - Model name
- `ANTHROPIC_SMALL_FAST_MODEL` - Fast model

### Codex (OpenAI)
- `CODEX_HOME` - Config directory (set via wrapper script)
- `OPENAI_API_KEY` - API key
- `OPENAI_BASE_URL` - API endpoint
- `OPENAI_MODEL` - Model name
- `OPENAI_SMALL_FAST_MODEL` - Fast model

## Security Considerations

### API Keys

- Stored in `settings.json` (plaintext)
- Protected by file permissions (user-only read/write)
- Never logged or displayed
- Included in encrypted backups only

### Backups

- AES-256-CBC encryption
- PBKDF2 key derivation (100,000 iterations)
- Password never stored
- No password recovery possible

### .gitignore

Prevents accidental commits:
- `*.zip` - Backup files
- `.sweech/` - Config directory
- `config.json` - Profile data
- `settings.json` - API keys

## Backward Compatibility

### Legacy Profile Migration

Profiles without `cliType` field (from initial versions):

```typescript
// Old format
{
  name: "claude-mini",
  provider: "minimax",
  // ... no cliType
}

// Automatically upgraded to:
{
  name: "claude-mini",
  cliType: "claude",  // Default added
  provider: "minimax"
}
```

Handled in `ConfigManager.getProfiles()`:

```typescript
return profiles.map((p: any) => ({
  ...p,
  cliType: p.cliType || 'claude'
}));
```

## Future Enhancements

### Planned Features

1. **Multi-CLI Support** - Choose CLI when adding provider
2. **Provider Health Check** - Test API connectivity
3. **Usage Tracking** - Monitor token usage per provider
4. **Config Sync** - Cloud sync for backups
5. **Shell Completion** - Tab completion for commands
6. **Web Dashboard** - Visual management interface

### Easy Additions

Because of the architecture, these are straightforward:

**New CLI:** Add to `clis.ts` (5 lines)
**New Provider:** Add to `providers.ts` (6 lines)
**New Feature:** Add command in `cli.ts`
**New Setting:** Update `settings.json` template

## Testing

### Manual Testing

```bash
# Build
npm run build

# Add provider
sweetch add

# List providers
sweetch list

# Create backup
sweetch backup

# Remove provider
sweetch remove claude-mini

# Restore backup
sweetch restore sweetch-backup.zip

# Test command
claude-mini --version
```

### Unit Tests (Future)

```
tests/
├── config.test.ts
├── providers.test.ts
├── backup.test.ts
└── cli.test.ts
```

## Contributing

When adding features:

1. **Maintain backward compatibility** - Old configs should work
2. **Update this document** - Explain architecture changes
3. **Add to .gitignore** - Don't commit sensitive files
4. **Test thoroughly** - Backup/restore, add/remove, etc.
5. **Update README** - Document user-facing changes

---

Back to [README](README.md)
