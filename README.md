# 🍭 Sweech

> **Switch between Claude Code, Codex, and 10+ AI providers seamlessly**

Sweech is the ultimate CLI tool for managing multiple AI coding assistants. Use Claude, Codex, Qwen, DeepSeek, OpenRouter, and local LLMs - all simultaneously with different command names.

Sweech is also the account control plane for the broader routing stack:

- it owns named local accounts such as `claude-ted`, `claude-rai`, `codex-luke`
- it tracks account health, rate-limit windows, and refresh state
- it can recommend which account should be used first when a router such as `omnai` or `cloudy` asks

[![Tests](https://img.shields.io/badge/tests-733%20passing-brightgreen.svg)](https://github.com/vykeai/sweech)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![npm](https://img.shields.io/npm/v/sweech.svg)](https://www.npmjs.com/package/sweech)

```bash
# Use them all at once! 🎉
claude              # Your default Claude account
claude-qwen         # Qwen (Alibaba) - $0.14/M tokens
claude-deep         # DeepSeek via Claude Code - $0.28/M tokens (cheapest!)
```

## Features

| Feature | CLI | Launcher TUI | SweechBar (macOS) |
|---------|-----|-------------|-------------------|
| Smart sort (expiry-first) | `sweech usage` | `s` key | Settings |
| Live usage bars (5h + 7d) | `sweech usage` | auto | auto |
| Per-model buckets | `sweech usage -m` | `m` key | Settings toggle |
| Sparkline history (24h) | `sweech usage --history` | `h` key | — |
| Profile launch | `sweech use <name>` | Enter | Launch menu |
| Re-authentication | `sweech auth <name>` | — | — |
| Global hotkey | — | — | Cmd+Shift+S |
| Threshold notifications | — | — | 70% / 90% alerts |
| Token refresh visibility | JSON output | key icon | Token badge |
| Webhook events | Config-driven | — | — |
| Dynamic shell completion | Tab | — | — |

### Highlights

- **Smart Sort** — Profiles with expiring weekly quota automatically rank first. Never waste what resets soonest.
- **SweechBar** — macOS menu bar app with live usage, smart sort, launch buttons, and Cmd+Shift+S global hotkey.
- **Federation API** — `sweech serve` exposes `/fed/widget`, `/fed/alerts`, `/fed/status` for integration with routing tools.
- **733 tests** — Comprehensive coverage including integration tests, edge cases, and OAuth flows.
- **AES-256 backups** — Encrypted backup/restore of all profile configurations and chat history.

---

## 🎯 Quick Start

### 1-Minute Setup

**Step 1:** Install from GitHub

```bash
curl -fsSL https://raw.githubusercontent.com/vykeai/sweech/main/install-from-github.sh | bash
```

**Step 2:** Run interactive onboarding

```bash
sweech init
```

The `init` command will guide you through:
- ✅ Adding Sweech to your PATH automatically
- ✅ Detecting installed CLIs (Claude Code, Codex)
- ✅ Setting up your first provider
- ✅ Running a health check to verify everything works

### First Provider - Interactive Setup

Run this command:

```bash
sweech add
```

All command names must start with `claude-` (e.g., `claude-work`, `claude-qwen`, `claude-rai`).

**That's it!** Your new command is ready to use.

### Interactive Launcher

Just type `sweech` with no arguments:

```
🍭 Sweech

❯ claude              (default account)
  claude-rai [shared] (Claude (Anthropic))
  claude-qwen         (Qwen · qwen-plus)

  [ ] yolo (y)    [ ] resume (r)

  → claude

  ↑↓ select  y yolo  r resume  ⏎ launch  q quit
```

- **↑↓** to select profile
- **y** to toggle yolo mode (`--dangerously-skip-permissions`)
- **r** to toggle resume (`--continue` last conversation)
- **Enter** to launch

Your selection is remembered between sessions. Profiles with shared data show `[shared]`; model name shown when set.

---

## 🌟 Key Features

### 🔗 Shared Data Mode

When running `sweech add`, after entering the command name you choose a data mode:

```
? Memory & data setup:
❯ Fresh — fully isolated (own memory, transcripts, plans, commands, plugins)
  Shared — symlink memory & data to another profile
    Same memory, transcripts, plans, tasks, commands, plugins.
    Auth & credentials stay separate.
    Good for: same person, two subscriptions.
```

If you choose **Shared**, you then pick which profile to share with:

```
? Share data with which profile?
❯ claude (your default ~/.claude/)
  claude-rai (~/.claude-rai/)
```

**What gets shared:**
- `projects/` — memory & project context
- `plans/` — project plans
- `tasks/` — task lists
- `commands/` — custom slash commands
- `plugins/` — plugins

**What stays isolated (per-profile):**
- `settings.json` — provider config, API keys
- `cache/` — model cache
- `session-env` — session environment
- `credentials` — auth tokens

**Viewing shared profiles:**

```bash
$ sweech list

🍭 Configured Providers:

▸ claude-rai [shared ↔ claude]
  CLI: Claude Code
  Provider: Claude (Anthropic)
  Model: default

▸ claude-work
  CLI: Claude Code
  Provider: Claude (Anthropic)
  Model: default

Default Claude account is in ~/.claude/ (use "claude" command)
  (← shared by: claude-rai)
```

### 🎨 Multiple CLI Support

Switch between different coding assistants:

```bash
# Claude Code (Anthropic API)
claude              # Default account
claude-qwen         # Qwen via Anthropic API
claude-deep         # DeepSeek via Anthropic API

# Codex (OpenAI API)
codex-deepseek      # DeepSeek via OpenAI API
codex-router        # OpenRouter (300+ models)
codex-qwen          # Qwen via OpenAI API
```

### 🔐 Multiple Claude Accounts (OAuth)

Add multiple Claude subscription accounts **without logging out**:

```bash
# Add another Claude account
$ sweech add
? CLI: Claude Code
? Provider: Claude (Anthropic)
? How would you like to authenticate?
  ❯ OAuth (browser login - adds another account without logging out)
    API Key (static token from platform.anthropic.com)
? Command name: claude-work
? Memory & data setup: Fresh

✓ Provider added successfully!
Command: claude-work
```

Each profile gets its own isolated authentication:
- `claude` → Your personal account
- `claude-work` → Your work account
- No need to log out/in to switch!

### 🧠 Live account recommendation

Sweech now exposes a recommendation endpoint for routers that need the best account right now:

```text
GET /fed/recommendation?cliType=claude
GET /fed/recommendation?cliType=codex
```

Current recommendation policy:

1. exclude accounts already rejected or at hard limit
2. prefer quota that resets sooner so expiring capacity gets used first
3. prefer accounts with higher healthy weekly/session utilization

That makes Sweech a living control plane instead of a static alias list. `omnai` and `cloudy` can use this recommendation when you do not pin an explicit account.

### 🏠 Custom & Local Providers

Use localhost, LAN servers, or custom hosts:

```bash
# LM Studio (localhost)
$ sweech add
? CLI: Codex
? Provider: Custom Provider
? Base URL: http://localhost:1234
? API format: OpenAI-compatible
? Model: llama-3.1-8b-instruct
✓ Command: lm-studio

# Ollama (localhost)
? Base URL: http://localhost:11434/v1
? API format: OpenAI-compatible
? Model: codellama:7b
✓ Command: ollama-code

# Home LAN Server
? Base URL: http://192.168.1.100:8080
? API format: Anthropic-compatible
? Model: custom-model-v1
✓ Command: home-server
```

📖 Complete guide: [CUSTOM-PROVIDERS.md](CUSTOM-PROVIDERS.md)

### 🌐 10+ Cloud Providers

| Provider | CLI | Cost | Notes |
|----------|-----|------|-------|
| **Claude (Anthropic)** | Claude | Varies | Official Claude models |
| **Qwen (Alibaba)** | Claude/Codex | $0.14-$2.49/M | Both APIs supported |
| **DeepSeek** | Claude/Codex | $0.28/M | **Cheapest!** Both APIs |
| **OpenRouter** | Codex | Varies | **300+ models** (Claude, GPT, Gemini, Llama) |
| **MiniMax** | Claude | $10/month | M2 coding model |
| **Kimi K2** | Claude | $0.14-$2.49/M | 256K context window |
| **GLM 4.6** | Claude | $3/month | Zhipu coding plan |
| **Custom/Local** | Both | FREE | LM Studio, Ollama, llama.cpp |

📖 Complete guide: [PROVIDERS.md](PROVIDERS.md)

### 💾 Backup & Restore

Migrate between machines with encrypted backups:

```bash
# Create backup (password-protected)
$ sweech backup
? Enter password: ********
✓ Backup created: sweech-backup-20250203.zip

# Restore on new machine
$ sweech restore sweech-backup-20250203.zip
? Enter password: ********
✓ All profiles restored
✓ Wrapper scripts executable
```

**Includes:**
- All provider configs
- Wrapper scripts
- Aliases
- Usage statistics
- **Complete profile data** (with `sweech backup-chats` - backs up entire profile including settings, credentials, chat history, plugins, and cache)

**Security:**
- AES-256-CBC encryption
- PBKDF2 key derivation (100,000 iterations)
- No password recovery

📖 Complete guide: [BACKUP.md](BACKUP.md)

### 📊 Usage Statistics

Track which providers you use most:

```bash
$ sweech stats

📊 Usage Statistics:

▸ claude-qwen
  Total uses: 142
  Last used: 2/3/2025, 4:32:18 PM
  Avg per day: 8.3

▸ lm-studio
  Total uses: 89
  Last used: 2/3/2025, 3:15:42 PM
  Avg per day: 5.2
```

### 🔗 Command Aliases

Create shortcuts for frequent providers:

```bash
$ sweech alias work=claude-qwen
$ sweech alias local=lm-studio
$ sweech alias fast=codex-deepseek

# Use short names
$ work      # Runs: claude-qwen
$ local     # Runs: lm-studio
$ fast      # Runs: codex-deepseek
```

---

## 📦 All Commands

### Core

```bash
sweech                         # Interactive launcher TUI
sweech use <name>              # Launch a profile directly
sweech auth <name>             # Re-authenticate expired token
sweech add                     # Add provider (interactive)
sweech list                    # List all providers with live status
sweech remove <name>           # Remove provider
sweech info [--json]           # Show configuration
```

### Usage & Monitoring

```bash
sweech usage                   # Live usage bars (5h + 7d windows)
sweech usage -m                # Per-model bucket breakdown
sweech usage --history         # 24h sparkline trends
sweech usage --json            # Machine-readable output
sweech stats [name] [--json]   # Launch statistics with visual bars
sweech serve [--port]          # Start federation HTTP server
```

### Provider Management

```bash
sweech show <name>             # Detailed info with live rate limits
sweech edit <name>             # Edit provider config
sweech clone <src> <dest>      # Clone provider config
sweech rename <old> <new>      # Rename provider
sweech test <name>             # Test provider connection
```

### Backup & Migration

```bash
sweech backup                  # Create AES-256 encrypted backup
sweech restore <file>          # Restore from backup
sweech backup-chats <name>     # Export chat history
sweech backup-claude           # Backup ~/.claude/ directory
```

### Utilities

```bash
sweech doctor                  # Health check (PATH, CLIs, credentials, symlinks)
sweech alias [action]          # Manage command aliases
sweech discover                # Browse available providers
sweech completion <shell>      # Shell completion (bash/zsh) with dynamic profiles
sweech webhooks                # Show configured webhooks
sweech path                    # Show bin directory
sweech update                  # Self-update from GitHub
```

---

## 🎯 Real-World Examples

### Shared Memory, Two Subscriptions

Same projects and memory across both accounts:

```bash
$ sweech add
? Command name: claude-work
? Memory & data setup: Shared
? Share data with which profile: claude (your default ~/.claude/)

# Now claude-work shares projects, plans, tasks, commands, plugins with claude
# Auth stays separate — two subscription accounts, one memory
```

```bash
$ sweech list

▸ claude-work [shared ↔ claude]
  CLI: Claude Code
  Provider: Claude (Anthropic)

Default Claude account is in ~/.claude/ (use "claude" command)
  (← shared by: claude-work)
```

### Cost Optimization

Mix free and paid providers:

```bash
# FREE: Local Ollama for quick iterations
$ ollama-code "add error handling"

# CHEAP: DeepSeek for production code ($0.28/M tokens)
$ codex-deepseek "implement user authentication"

# QUALITY: Claude for complex architecture (official pricing)
$ claude "design the database schema"
```

💰 **Save hundreds per month** with smart provider switching!

### Team Collaboration

Share provider configs with your team:

```bash
# Team lead creates backup
$ sweech backup -o team-config.zip

# Team members restore
$ sweech restore team-config.zip

# Everyone has the same providers! 🎉
```

### Project-Based Workflows

Use aliases for different projects:

```bash
$ sweech alias frontend=claude-qwen
$ sweech alias backend=codex-deepseek
$ sweech alias mobile=claude-kimi     # 256K context for large codebases

# In each project
$ cd ~/frontend && frontend
$ cd ~/backend && backend
$ cd ~/mobile && mobile
```

### LAN Household Setup

One server, multiple machines:

```bash
# Server machine (192.168.1.100)
# Run LM Studio with network access enabled

# All household machines
$ sweech add
? Provider: Custom Provider
? Base URL: http://192.168.1.100:1234
? API format: OpenAI-compatible
? Model: llama-3.1-70b
✓ Command: home-ai

# Free AI for the whole household! 🏠
```

---

## 🛡️ Safety & Security

### Default Directory Protection

Sweech **never touches** your default CLI directories:

- `~/.claude/` - Protected ✅
- `~/.codex/` - Protected ✅

The `claude` and `codex` commands work exactly as before!

### Safe Remove with Symlinks

When removing a profile, sweech checks whether other profiles share data with it:

```bash
$ sweech remove claude-main

⚠️  The following profiles are sharing data with this one: claude-work, claude-rai
   Their symlinks will break.
? Remove anyway? (y/N)
```

Symlinked profile directories are unlinked (not deleted), so shared data in the master is never lost.

### Smart Reset

```bash
$ sweech reset

⚠️  This will remove ALL sweech-created providers.
   Your default ~/.claude/ directory will NOT be touched.

? Remove all sweech providers? Yes

✓ Removed 5 providers
✓ Cleaned ~/.sweech/
✗ Protected ~/.claude/ (untouched)
```

### Secure Backups

- AES-256-CBC encryption
- PBKDF2 key derivation (100,000 iterations)
- Password never stored
- API keys encrypted at rest

---

## 🔧 Advanced Usage

### Health Check

```bash
$ sweech doctor

🏥 Sweech Health Check

Environment:
  ✓ Node.js: v22.1.0
  ✓ sweech: v0.2.1

PATH Configuration:
  ✓ /Users/you/.sweech/bin is in PATH

Installed CLIs:
  ✓ Claude Code (2.x.x)
  ✗ Codex: Not installed

Profiles (2):
  ✓ claude-rai → Claude (Anthropic) [shared ↔ claude]
    Shared symlinks (→ claude):
      ✓ projects
      ✓ plans
      ✓ tasks
      ✓ commands
      ✓ plugins
  ✓ claude-qwen → Qwen (Alibaba)

✅ Everything looks good! 🎉
```

### Test Provider Connection

```bash
$ sweech test claude-qwen

🧪 Testing claude-qwen...

✓ Config exists
✓ Wrapper script exists
✓ Wrapper script executable
✓ Provider: Qwen (Alibaba)
✓ Base URL: https://dashscope-intl.aliyuncs.com/apps/anthropic
✓ Model: qwen-plus

All checks passed! ✅
```

### Self-Update

```bash
$ sweech update

🔄 Updating sweech...

# Runs: npm install -g github:vykeai/sweech

✓ sweech updated successfully
```

### Shell Completion

```bash
# Bash
$ sweech completion bash > ~/.sweech-completion.bash
$ echo 'source ~/.sweech-completion.bash' >> ~/.bashrc
$ source ~/.bashrc

# Zsh
$ sweech completion zsh > ~/.sweech-completion.zsh
$ echo 'source ~/.sweech-completion.zsh' >> ~/.zshrc
$ source ~/.zshrc

# Now use tab completion
$ sweech <TAB>
add       backup    clone     doctor    edit      list      update    ...
```

---

## 📋 Prerequisites

- **Node.js** 18 or higher
- **Claude Code CLI** (for Claude providers): `npm install -g @anthropic/claude-code`
- **Codex CLI** (for Codex providers): See [Codex installation](https://github.com/openai/codex)
- **API keys** for cloud providers you want to use
- **Local LLM server** (optional): LM Studio, Ollama, llama.cpp

---

## 🚀 Installation

### One-Line Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/vykeai/sweech/main/install-from-github.sh | bash
```

### Homebrew (macOS)

```bash
brew install vykeai/tap/sweech
brew install --cask vykeai/tap/sweech-bar
```

### Manual Install

**Option 1:** Install from GitHub

```bash
npm install -g github:vykeai/sweech
```

**Option 2:** Clone and build

```bash
git clone https://github.com/vykeai/sweech.git
```

```bash
cd sweech && npm install && npm run build && npm link
```

### Post-Install

Add sweech bin to PATH (choose your shell):

**Bash:**

```bash
echo 'export PATH="$HOME/.sweech/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

**Zsh:**

```bash
echo 'export PATH="$HOME/.sweech/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

**Fish:**

```bash
echo 'set -gx PATH $HOME/.sweech/bin $PATH' >> ~/.config/fish/config.fish && source ~/.config/fish/config.fish
```

Verify installation:

```bash
sweech --version
```

```bash
sweech doctor
```

---

## 🏗️ How It Works

Sweech creates wrapper scripts that set environment variables before launching the CLI:

```bash
# ~/.sweech/bin/claude-qwen
#!/bin/bash
export CLAUDE_CONFIG_DIR="$HOME/.claude-qwen"
exec claude "$@"
```

**Directory Structure:**

```
~/
├── .claude/                  # Default account (untouched)
├── .claude-rai/              # Shared profile (sibling)
│   ├── settings.json         # Isolated — own auth
│   ├── projects -> ../.claude/projects   # Symlink to master
│   ├── plans    -> ../.claude/plans      # Symlink to master
│   ├── tasks    -> ../.claude/tasks      # Symlink to master
│   ├── commands -> ../.claude/commands   # Symlink to master
│   └── plugins  -> ../.claude/plugins    # Symlink to master
├── .claude-qwen/             # Fresh profile (fully isolated)
│   ├── settings.json
│   ├── projects/
│   └── ...
└── .sweech/
    ├── config.json           # Provider registry (includes sharedWith)
    ├── last-launch.json      # Remembered launcher state
    └── bin/
        ├── claude-rai        # Wrapper script
        └── claude-qwen       # Wrapper script
```

**Shared profiles** symlink their data directories to a master profile (either `~/.claude/` or another sweech profile). Auth files (`settings.json`, credentials) are always kept separate.

**Each provider is completely isolated for auth:**

- Own config directory at `~/.claude-<name>/` (sibling to `~/.claude/`)
- Own settings, credentials
- Own wrapper script

Your default `~/.claude/` stays **completely untouched** (unless a profile chooses to share with it).

---

## 🔑 Getting API Keys

### Cloud Providers

- **Qwen**: [DashScope Console](https://dashscope.console.aliyun.com/)
- **MiniMax**: [MiniMax Platform](https://platform.minimax.io/)
- **Kimi**: [Moonshot AI Platform](https://platform.moonshot.cn/)
- **DeepSeek**: [DeepSeek Platform](https://platform.deepseek.com/)
- **GLM**: [Zhipu AI Platform](https://open.bigmodel.cn/)
- **OpenRouter**: [OpenRouter](https://openrouter.ai/)

### Local LLMs (No API Key Needed!)

- **LM Studio**: [lmstudio.ai](https://lmstudio.ai/) - GUI, easiest setup
- **Ollama**: [ollama.ai](https://ollama.ai/) - CLI-focused, fast
- **llama.cpp**: [GitHub](https://github.com/ggerganov/llama.cpp) - Maximum control

📖 See [CUSTOM-PROVIDERS.md](CUSTOM-PROVIDERS.md) for setup guides

---

## 🧪 Testing

Comprehensive test suite with 733 tests across 30 suites:

```bash
npm test            # Run all tests
npm run build       # TypeScript build
```

**Test Coverage:**
- 733 tests across 30 suites
- Launcher integration tests (entry building, render, keyboard, launch command)
- Federation server edge cases (rate limiting, CORS, alerts, status)
- OAuth flow tests
- Charts and sparkline tests
- Account selector scoring tests
- Live usage cache TTL and staleness
- Webhook delivery and retry logic
- Usage history recording and pruning
- ✅ Reset protection
- ✅ All commands tested
- ✅ Shared data mode (setupSharedDirs, symlink removal, list tags, doctor checks, clone inheritance)

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

### Add New Providers

Edit `src/providers.ts`:

```typescript
{
  name: 'new-provider',
  displayName: 'New Provider',
  baseUrl: 'https://api.newprovider.com/anthropic',
  defaultModel: 'model-name',
  description: 'Description',
  pricing: '$X/M tokens',
  compatibility: ['claude'], // or ['codex'] or both
  apiFormat: 'anthropic' // or 'openai'
}
```

### Add New CLI Support
### Report Issues

Found a bug? [Open an issue](https://github.com/vykeai/sweech/issues)

---

## 📚 Documentation

- **[README.md](README.md)** - Main documentation (you are here)
- **[PROVIDERS.md](PROVIDERS.md)** - Complete provider guide
- **[CUSTOM-PROVIDERS.md](CUSTOM-PROVIDERS.md)** - Local & custom LLM setup
- **[BACKUP.md](BACKUP.md)** - Backup & restore guide
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Technical architecture
- **[TESTING.md](TESTING.md)** - Testing guide
- **[CHANGELOG.md](CHANGELOG.md)** - Version history

---

## 🙏 Credits & Inspiration

Inspired by amazing projects:

- [claude-multi](https://github.com/hmziqrs/claude-multi) by hmziqrs
- [cc-account-switcher](https://github.com/ming86/cc-account-switcher) by ming86
- [cc-compatible-models](https://github.com/Alorse/cc-compatible-models) by Alorse

Special thanks to the community for feedback and testing!

---

## 📄 License

MIT License - See [LICENSE](LICENSE) file

---

## 💡 Tips & Tricks

### Quick Command Names

Use short, memorable names:

```bash
sweech alias q=claude-qwen
```

```bash
sweech alias d=codex-deepseek
```

```bash
sweech alias l=lm-studio
```

### Monitor Costs

Check which providers you use most:

```bash
$ sweech stats

# If you barely use a paid provider, consider canceling
# If you heavily use a cheap provider, keep it!
```

### Export Profile Data

Before removing a provider, export complete profile (including chats, settings, and credentials):

```bash
$ sweech backup-chats claude-qwen
✓ Backed up to: sweech-chats-claude-qwen-20250203.zip
```

### Test Before Using

Test new providers before critical work:

```bash
sweech test new-provider
```

```bash
new-provider "Hello, test message"
```

---

## 🌟 Star Us!

If Sweech saves you money or time, please ⭐ star this repo!

**Made with 🍭 by the Sweech community**

---

## 📞 Support

- 📖 **Documentation**: Read the guides above
- 🐛 **Bug Reports**: [GitHub Issues](https://github.com/vykeai/sweech/issues)
- 💬 **Discussions**: [GitHub Discussions](https://github.com/vykeai/sweech/discussions)
- 📧 **Email**: (Coming soon)

---

**Happy coding with Sweech! 🍭**
