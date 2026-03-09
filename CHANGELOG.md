# 🍭 Sweech Changelog

## v0.2.1 (2026-03-09)

### ✨ New Features

#### 🔗 Shared Data Mode (`sweech add`)
- After the command name prompt, users now choose between:
  - **Fresh** — fully isolated profile (own memory, transcripts, plans, commands, plugins)
  - **Shared** — symlink memory & data dirs to a master profile (auth stays separate)
- If shared, users pick which profile to share with (`claude` default or any existing sweech profile)
- Shared dirs: `projects`, `plans`, `tasks`, `commands`, `plugins`
- NOT shared: `settings.json`, `cache`, `session-env`, credentials
- `sharedWith` stored in config for tracking and dependency detection

#### 📋 `sweech list` improvements
- Profiles with `sharedWith` show `[shared ↔ claude]` tag in magenta
- Master profiles show `(← shared by: claude-rai, claude-work)` reverse dependency tag
- Default claude footer also shows which profiles share with it

#### ⚠️ `sweech remove` improvements
- Warns if other profiles share data with the profile being removed ("Their symlinks will break")
- Asks for confirmation before proceeding
- Safely unlinks symlinked profile directories instead of deleting them (prevents data loss)

#### 🏥 `sweech doctor` improvements
- Checks symlink validity for shared profiles
- Reports ✓/✗ for each of the 5 shared dirs (`projects`, `plans`, `tasks`, `commands`, `plugins`)
- Shows `[shared ↔ <master>]` tag next to profile name

#### 📋 `sweech clone` improvements
- If the source profile has `sharedWith` set, asks: "Should the clone also share with X?"
- If confirmed, sets up symlinks and records `sharedWith` on the cloned profile

#### 🔄 `sweech update` (new command)
- Self-updates sweech from `github:vykeai/sweech`
- Runs: `npm install -g github:vykeai/sweech`

#### 🎮 Launcher improvements
- Profiles with `sharedWith` show `[shared]` indicator in the TUI
- Model name shown in label when set (e.g. `Claude (Anthropic) · qwen-plus`)

### 🔬 Testing

Added **28 new tests** (380 total, up from 352):

- **`setupSharedDirs`** — creates symlinks for all `SHAREABLE_DIRS`, creates master dir if missing, works with both `claude` default and sweech profile as master
- **`removeProfile` with symlinks** — uses `unlinkSync` not `rmSync` when profile dir is a symlink
- **Shared profile list output** — `sharedWith` tag, reverse dependency tag, default claude footer
- **Doctor symlink check** — valid symlinks pass, broken/non-symlink paths fail, all dirs are checked
- **Clone with shared inheritance** — `sharedWith` propagates when user confirms, not propagated when declined
- **Dependent warning logic** — correctly identifies profiles that will lose symlinks on removal

### 📦 Commands Reference

```bash
sweech add                     # Add provider (now includes data mode: Fresh/Shared)
sweech list                    # List providers (shows [shared ↔ X] and reverse tags)
sweech remove <name>           # Remove provider (warns about dependent shared profiles)
sweech doctor                  # Health check (now checks symlink validity)
sweech clone <src> <dest>      # Clone (inherits sharedWith if user confirms)
sweech update                  # NEW: Self-update from github:vykeai/sweech
```

---

## v0.2.0 (2025-02-xx)

### ✨ New Features in v0.2.0

- 🎮 **Interactive Launcher** — `sweech` with no arguments opens a TUI to select profile, toggle yolo and resume with keyboard
- 📁 **Sibling Directories** — Profiles live at `~/.claude-<name>/` as siblings to `~/.claude/`
- 🔒 **Enforced Naming** — All commands must start with `claude-` (e.g., `claude-work`, `claude-rai`)
- 💾 **Remembers Last Choice** — Launcher saves and restores previous selection, yolo, and resume state
- 🧠 **Updated Models** — Default Anthropic models updated to claude-sonnet-4-6 / claude-haiku-4-5

---

## v0.1.0 (2025-02-03)

### 🎉 Initial Beta Release

Complete CLI tool for managing multiple AI coding assistants with dual CLI support, custom providers, and advanced features.

### ✨ Major Features

#### 🚀 Dual CLI Support
- **Claude Code** - Full support for Anthropic Claude CLI
- **Codex** - Full support for OpenAI Codex CLI
- **Auto-detection** - Automatically detects installed CLIs with version checking
- **Provider Filtering** - Shows only compatible providers for selected CLI

#### 🏠 Custom & Local Providers
- **Localhost Support** - LM Studio, Ollama, llama.cpp (http://localhost:1234)
- **LAN Support** - Share one server across household (192.168.x.x)
- **Remote Hosts** - Custom domains and self-hosted instances
- **API Format Selection** - Choose OpenAI-compatible or Anthropic-compatible
- **Auto-Compatibility** - Determines CLI compatibility from API format
- **URL Validation** - Supports localhost, LAN IPs, and custom domains

#### 🌐 10+ Cloud Providers
- **Anthropic Claude** - Official Claude models
- **Qwen (Alibaba)** - Both Anthropic and OpenAI APIs ($0.14-$2.49/M tokens)
- **DeepSeek** - Both Anthropic and OpenAI APIs ($0.28/M tokens - cheapest!)
- **OpenRouter** - Universal gateway to 300+ models (Claude, GPT, Gemini, Llama)
- **MiniMax** - M2 coding model ($10/month)
- **Kimi K2** - 256K context window ($0.14-$2.49/M tokens)
- **GLM 4.6** - Zhipu coding plan ($3/month)
- **Custom/Local** - User-defined providers (FREE for local!)

#### 💾 Backup & Migration
- **Encrypted Backups** - AES-256-CBC with PBKDF2 key derivation
- **Password Protection** - Secure interactive password prompts
- **Chat History Backup** - Export conversation transcripts
- **Full Restore** - Migrate entire setup between machines
- **Team Sharing** - Share configs with team members

#### 🔧 Advanced Commands
- **`doctor`** - Health check for installation and profiles
- **`test`** - Test provider connection and configuration
- **`edit`** - Edit provider settings interactively
- **`clone`** - Clone provider configurations
- **`rename`** - Rename providers
- **`backup-chats`** - Export chat history separately
- **`reset`** - Safe cleanup without touching default directories

#### 🛡️ Safety & Security
- **Default Directory Protection** - Never touches ~/.claude/ or ~/.codex/
- **Smart Reset** - Removes only sweech-created providers
- **System Command Protection** - Prevents shadowing critical commands
- **Input Validation** - Strict command name format validation
- **Secure Execution** - Uses execFile instead of shell execution
- **Encrypted Storage** - AES-256-CBC encryption for backups
- **PBKDF2 Key Derivation** - 100,000 iterations for password security

### 📦 Core Commands

```bash
# Provider Management
sweech add                     # Add provider (interactive)
sweech list                    # List all providers
sweech remove <name>           # Remove provider
sweech info                    # Show configuration
sweech show <name>             # Show provider details
sweech edit <name>             # Edit provider config
sweech clone <src> <dest>      # Clone provider config
sweech rename <old> <new>      # Rename provider
sweech test <name>             # Test provider connection

# Backup & Migration
sweech backup                  # Create encrypted backup
sweech restore <file>          # Restore from backup
sweech backup-chats <name>     # Export chat history

# Utilities
sweech stats [name]            # Usage statistics
sweech alias [action]          # Manage command aliases
sweech discover                # Browse available providers
sweech doctor                  # Check installation health
sweech path                    # Show bin directory path
sweech completion <shell>      # Generate shell completion

# Maintenance
sweech reset                   # Remove all sweech providers
sweech update-wrappers         # Regenerate wrapper scripts
```

### 🔬 Testing

Comprehensive test suite with **346 tests passing**:

**Test Breakdown:**
- **Provider Tests**: 62 tests
  - Provider filtering by CLI compatibility (22 tests)
  - Provider configurations (40 tests)
- **Custom Provider Tests**: 36 tests
  - URL validation (localhost, LAN, remote)
  - API format selection
  - Config creation
  - Real-world use cases (LM Studio, Ollama, llama.cpp)
- **System Commands**: 27 tests
  - Collision detection
  - Validation
  - Warnings
- **Chat Backup Tests**: 22 tests
  - AES-256 encryption
  - PBKDF2 key derivation
  - Transcript export
- **Reset Tests**: 12 tests
  - Default directory protection
  - Safe cleanup
  - Profile removal
- **Utility Commands**: 40 tests
  - Doctor, test, edit, clone, rename
- **Usage Tracking**: 25 tests
- **Shell Completion**: 32 tests
- **Alias Management**: 22 tests
- **Config Manager**: 20 tests
- **Backup/Restore**: 20 tests
- **Interactive**: 27 tests
- **CLI Detection**: 21 tests

**Coverage:**
- ✅ 346 tests passing
- ✅ 15 test suites
- ✅ 100% pass rate

### 🏗️ Architecture

#### Provider Compatibility System
- `compatibility: CLIType[]` - Specifies which CLIs work with each provider
- `apiFormat: 'anthropic' | 'openai'` - Determines protocol compatibility
- Provider filtering based on selected CLI
- Dual provider endpoints (DeepSeek, Qwen support both APIs)

#### Custom Provider System
- Interactive prompts for custom provider setup
- URL validation (localhost, LAN IPs, domains)
- API format selection (OpenAI vs Anthropic)
- Dynamic provider config creation
- Stored in profile for future editing

#### CLI Detection
- Auto-detect installed CLIs with version checking
- Support for Claude Code and Codex

### 📚 Documentation

Complete documentation suite:
- **[README.md](README.md)** - Main documentation with all features
- **[PROVIDERS.md](PROVIDERS.md)** - Complete provider guide (10+ providers)
- **[CUSTOM-PROVIDERS.md](CUSTOM-PROVIDERS.md)** - Local & custom LLM setup guide
- **[BACKUP.md](BACKUP.md)** - Backup & restore guide
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Technical architecture
- **[TESTING.md](TESTING.md)** - Testing guide
- **[CHANGELOG.md](CHANGELOG.md)** - Version history (this file)

### 🚀 Provider Support Matrix

| Provider | CLI Support | API Format | Cost | Notes |
|----------|-------------|------------|------|-------|
| Claude (Anthropic) | Claude | Anthropic | Varies | Official Claude models |
| Qwen (Alibaba) | Claude | Anthropic | $0.14-$2.49/M | DashScope Anthropic API |
| Qwen (OpenAI) | Codex | OpenAI | $0.14-$2.49/M | DashScope OpenAI API |
| DeepSeek | Claude | Anthropic | $0.28/M | Lowest cost |
| DeepSeek (OpenAI) | Codex | OpenAI | $0.28/M | Lowest cost |
| OpenRouter | Codex | OpenAI | Varies | 300+ models |
| MiniMax | Claude | Anthropic | $10/month | M2 coding model |
| Kimi K2 | Claude | Anthropic | $0.14-$2.49/M | 256K context |
| GLM 4.6 | Claude | Anthropic | $3/month | Zhipu coding plan |
| Custom/Local | Both | User choice | Self-hosted | LM Studio, Ollama, llama.cpp |

### 🎯 Use Cases

- **Multi-Account** - Work, personal, client accounts
- **Cost Optimization** - Mix free local LLMs with paid cloud providers
- **Context Switching** - Different providers per project
- **Team Collaboration** - Shared and personal accounts
- **LAN Sharing** - One server, multiple household machines
- **Provider Testing** - Test before committing to subscriptions

### 🔐 Security Considerations

- **API Keys**: Stored in `~/.sweech/profiles/*/settings.json`
- **File Permissions**: User-only read/write (0600)
- **Backup Encryption**: AES-256-CBC with user-provided password
- **No Password Recovery**: By design for security
- **Default Directory Protection**: ~/.claude/, ~/.codex/, etc. never touched
- **Git Ignore**: Backup files excluded from version control

### 🐛 Known Issues

None currently. Report issues at: https://github.com/czaku/sweech/issues

### 📝 Technical Details

- **Language:** TypeScript 5.3.3
- **Runtime:** Node.js 18+
- **Package Manager:** npm
- **Testing:** Jest 29.7.0 (346 tests)
- **Encryption:** Node.js crypto (AES-256-CBC, PBKDF2)
- **CLI Framework:** Commander 11.1.0
- **Prompts:** Inquirer 9.2.12

### 🎨 Dependencies

**Production:**
- `commander` ^11.1.0 - CLI framework
- `inquirer` ^9.2.12 - Interactive prompts
- `chalk` ^4.1.2 - Terminal colors
- `archiver` ^6.0.1 - ZIP creation
- `unzipper` ^0.10.14 - ZIP extraction

**Development:**
- `typescript` ^5.3.3 - Type safety
- `jest` ^29.7.0 - Testing framework
- `ts-jest` ^29.1.1 - TypeScript testing
- `@types/*` - Type definitions

### 🙏 Credits

Inspired by amazing community projects:
- [claude-multi](https://github.com/hmziqrs/claude-multi) by hmziqrs
- [cc-account-switcher](https://github.com/ming86/cc-account-switcher) by ming86
- [cc-compatible-models](https://github.com/Alorse/cc-compatible-models) by Alorse

Special thanks to the community for feedback and testing!

### 📄 License

MIT License - See [LICENSE](LICENSE) file

---

**Made with 🍭 by the Sweech community**
