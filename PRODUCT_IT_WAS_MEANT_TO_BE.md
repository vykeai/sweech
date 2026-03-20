# Sweech -- Product Archaeology

## Vision

Sweech lets you switch between Claude Code, Codex, and 10+ AI providers seamlessly. Each
provider gets its own command name, its own config directory, and its own API credentials.
Run Claude on one task, Codex on another, a local model on a third -- all simultaneously,
all without conflicts. The thesis: you should be able to use every AI coding tool that exists
without any of them interfering with each other.

## What It Does

- **Profile management**: create named profiles that each become a separate CLI command
  (e.g., `claude-mini`, `codex-qwen`, `claude-deep`)
- **Multi-CLI support**: works with Claude Code and Codex CLIs, each with independent configs
- **10+ provider backends**: Anthropic, OpenAI, Qwen (Alibaba), MiniMax, Kimi (Moonshot AI),
  DeepSeek, GLM (Zhipu), OpenRouter, and custom providers via configuration
- **Shared data mode**: profiles can share project context (plans, tasks, commands, plugins)
  while keeping auth isolated -- `sharedWith` symlinks data dirs to a master profile
- **Credential isolation**: each profile has its own API key, base URL, and model config
- **Chat backup**: export and backup conversation history across profiles
- **Audit logging**: track which profile was used for what, when
- **Tab completion**: shell completions for all commands and profiles
- **Fed integration**: fedServer and fedClient modules for service registration and discovery
- **Launcher**: launch profiles with environment isolation via launchd on macOS
- **Charts**: usage visualization across profiles and providers
- **Interactive mode**: guided profile creation and configuration
- **Custom providers**: define new providers with name, base URL, default model, and description

## Architecture

- **Language**: TypeScript
- **Source modules** (under `src/`):
  - `cli.ts` -- main CLI entry point and command router
  - `clis.ts` -- CLI type definitions (Claude Code, Codex)
  - `config.ts` -- profile and global configuration management
  - `accountSelector.ts` -- account selection logic for multi-account providers
  - `aliases.ts` -- command alias management
  - `credentialStore.ts` -- secure credential storage
  - `customProvider.ts` -- custom provider definition and management
  - `launcher.ts` -- profile launcher with environment isolation
  - `launchd.ts` -- macOS launchd integration
  - `backup.ts` -- configuration backup and restore
  - `chatBackup.ts` -- conversation history backup
  - `auditLog.ts` -- usage audit trail
  - `charts.ts` -- usage visualization
  - `interactive.ts` -- guided interactive configuration
  - `completion.ts` -- shell tab completion generation
  - `fedClient.ts` / `fedServer.ts` -- fed service integration
  - `events.ts` -- event system for inter-module communication
  - `init.ts` -- first-run initialization
  - `cliDetection.ts` -- auto-detect installed CLIs
- **macOS menu bar**: `macos-menubar/` contains a native Swift menu bar companion for quick
  profile switching
- **Testing**: Jest test suite under `tests/`
- **Distribution**: npm package

## Current State

**What works:**
- Profile creation and management for Claude Code and Codex CLIs
- All 10+ providers are configurable and functional
- Shared data mode correctly symlinks project context while isolating auth
- Chat backup and audit logging track usage across profiles
- Tab completion works in bash/zsh
- Custom provider definition works
- CLI detection finds installed tools automatically

**Known limitations:**
- macOS menu bar companion is early stage
- No automatic profile recommendation based on task type
- Charts and usage visualization are basic
- Fed integration exists but isn't deeply used yet

## What It Was Meant To Be

The unrealized vision is an intelligent AI assistant manager that understands which provider
and model is best for each task and routes automatically. Instead of manually switching
profiles, Sweech would observe the task context -- "this is a Swift file," "this is a code
review," "this needs vision capabilities" -- and activate the right profile.

Profile performance would be tracked: which profile produces better first-pass results for
which languages, which provider has lower latency for quick edits vs deep architecture work,
which models cost less for bulk operations. The macOS menu bar would show active profiles,
current costs, and suggest switches.

The deeper ambition is a "conductor" mode where Sweech orchestrates multiple profiles
simultaneously on different aspects of the same feature -- Claude on architecture, Codex on
implementation, a local model on test generation -- coordinating their outputs into a single
coherent delivery. Today Sweech solves the "I want to use multiple AI tools without conflicts"
problem. The vision of intelligent, context-aware, multi-model orchestration from a single
manager remains unrealized.
