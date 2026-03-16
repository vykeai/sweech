# sweech roadmap

Last updated: 2026-03-16

---

## Phase 1 — Polish & Stability (now)

### SweechBar menu bar app
- [ ] Launch at login (launchd plist or Login Items)
- [ ] Click account card to copy profile launch command
- [ ] Notification when account goes from ok -> limit_reached
- [ ] Notification when capacity opens up (limit -> ok)
- [ ] Sparkle auto-updater or self-update from GitHub release
- [ ] Dark/light theme following system appearance
- [ ] Compact mode toggle (show only bars, no labels)
- [ ] Drag to reorder accounts
- [ ] Right-click account for quick actions (test, edit, open config dir)
- [ ] Show current active sessions (which terminals are running which profile)

### CLI hardening
- [ ] Fix 3 failing configManager.test.ts symlink assertions
- [ ] `sweech serve` as proper launchd daemon with auto-restart
- [ ] `sweech serve --install` to create and load launchd plist
- [ ] `sweech serve --uninstall` to remove launchd plist
- [ ] Graceful shutdown on SIGTERM/SIGINT for serve
- [ ] Health check endpoint (`/healthz`) for monitoring
- [ ] Rate-limit serve endpoint responses (prevent abuse)

### Usage tracking
- [ ] Show cost estimates (map plan tier to $/msg approximation)
- [ ] Historical usage graphs (daily/weekly trends) in `sweech stats`
- [ ] Export usage data as CSV/JSON
- [ ] Per-session message breakdown in `sweech stats <name>`

---

## Phase 2 — More CLIs & Providers

### Enable commented-out CLIs
- [ ] Cursor support (config dir detection, wrapper generation)
- [ ] Windsurf support
- [ ] Aider support (Python-based, needs different wrapper strategy)
- [ ] Gemini CLI (Google) — new entry
- [ ] Amazon Q CLI — new entry

### Provider improvements
- [ ] Model discovery — query provider APIs for available models
- [ ] Model picker in `sweech add` — list models from API instead of manual entry
- [ ] Provider health dashboard in `sweech doctor` — ping each API endpoint
- [ ] Auto-detect provider from API key format (sk-ant-*, sk-*, etc.)
- [ ] Provider-specific rate limit parsing (not just Claude/Codex)

### OAuth improvements
- [ ] Local HTTP callback server for OAuth (no manual code paste)
- [ ] Auto token refresh in background (before expiry)
- [ ] Token rotation alerts (when refresh token is near expiry)
- [ ] Secure token migration between profiles

---

## Phase 3 — Intelligence & Automation

### Smart routing
- [ ] `sweech auto` — pick the best available account based on current usage
- [ ] Failover: if active account hits limit, suggest/switch to next available
- [ ] Priority queue: configure account preference order per project
- [ ] Project-aware routing: `.sweech.json` in project root to pin account
- [ ] Model routing: map task types to specific models (quick=haiku, deep=opus)

### Session management
- [ ] `sweech sessions` — list active CLI sessions across all profiles
- [ ] `sweech kill <session-id>` — terminate a running session
- [ ] Session tagging — name sessions for easy identification
- [ ] Session cost tracking — cumulative token/message usage per session

### Automation
- [ ] Cron-style usage reports (daily email/webhook summary)
- [ ] Webhook on limit_reached (Slack, Discord, HTTP)
- [ ] GitHub Action for sweech setup in CI
- [ ] `sweech rotate` — cycle through accounts on limit

---

## Phase 4 — Cross-Platform & Distribution

### Cross-platform
- [ ] Linux Keychain equivalent (libsecret/kwallet) for live usage
- [ ] Windows Credential Manager support
- [ ] Cross-platform live usage via API token file fallback
- [ ] Test suite for Windows path handling

### Distribution
- [ ] Homebrew formula (`brew install sweech`)
- [ ] npm global install (`npm install -g sweech`)
- [ ] Binary releases (pkg/vercel/bun compile)
- [ ] SweechBar as signed .app in GitHub releases
- [ ] SweechBar in Mac App Store (sandbox considerations)
- [ ] Auto-update checker (`sweech update --check`)

---

## Phase 5 — Federation & Teams

### Fed integration
- [ ] Full fed widget contract (actions: add/remove profile from fed UI)
- [ ] Bidirectional: fed can trigger `sweech` commands
- [ ] Multi-machine aggregation (see all machines' accounts in one view)
- [ ] Remote usage API (query usage from another machine)

### Team features
- [ ] Shared team config (org-level provider settings)
- [ ] Team usage dashboard (aggregate across team members)
- [ ] Invite flow (share provider config securely)
- [ ] Usage budgets per team member
- [ ] Admin controls (lock accounts, set limits)

---

## Phase 6 — Advanced Features

### Backup & sync
- [ ] iCloud sync for profiles (encrypted)
- [ ] Git-based config sync (push/pull sweech config)
- [ ] Scheduled auto-backup (daily/weekly)
- [ ] Backup to S3/GCS with encryption

### Security
- [ ] Audit log — track all sweech operations
- [ ] 2FA for destructive operations (reset, remove)
- [ ] Encrypted config at rest (not just backups)
- [ ] API key rotation reminders
- [ ] Vulnerability scanning of dependencies

### Developer experience
- [ ] `sweech plugin` system — extend with custom commands
- [ ] `sweech template` — pre-built profile configs (e.g., "coding-max", "research-pro")
- [ ] Shell prompt integration (show active profile in PS1)
- [ ] VS Code extension (profile picker in status bar)
- [ ] JetBrains plugin
- [ ] Raycast extension

---

## Won't do (for now)

- IDE-embedded Claude (out of scope — sweech is CLI infrastructure)
- Token-level billing/metering (provider responsibility)
- Model fine-tuning management (too provider-specific)
- Chat history search/browsing (use `sweech backup-chats` + external tools)
