# Backlog: web dashboard — execution plan

Spec: [docs/specs/dashboard-2026-05-18.md](dashboard-2026-05-18.md)
Status: READY for `/vy-go` parallel execution
Wave model: 3 parallel waves + 1 review wave

---

## Q&A confirmed (from spec authoring conversation)

- Q1 Settings: **drawer** (slide from right)
- Q2 Doctor: **hybrid** — structural live, network every 60s while focused
- Q3 Tile metadata: **always show pid + tty**
- Q4 Empty state: **all-panels-empty + setup wizard accessible from empty Sessions panel**
- Q5 tmux viewer count: **always show when ≥1**
- R13 Staleness indicators everywhere (4-state: fresh/muted/stale/never)

Backend `fetchedAt` infrastructure already landed in commit 1554355.

---

## Wave 1 — Foundation (5 parallel worktrees, no inter-dependencies)

### T-DASH-001 · apps/dashboard scaffold
**Files:** `apps/dashboard/{package.json,vite.config.ts,index.html,tsconfig.json,src/{App.tsx,main.tsx,api.ts,store.ts}}`, root `package.json` (add workspaces).
**Tasks:**
- Set up Vite + React 19 + TypeScript + Tailwind + @vykeai/vysual-react workspace.
- Wire `ThemeProvider theme={themes.sweech}` at root.
- Empty grid layout: hero strip + sessions row + 3-col mid rows.
- Stub all panel components as `<Card>Coming…</Card>` placeholders.
- Zustand store with slices: `sessions`, `accounts`, `audit`, `cost`, `doctor`, `settings`, `peers`.
- `useSSE` hook + auto-reconnect with exp-backoff.
- Build wires into root `npm run build`: `tsc && vite build apps/dashboard --outDir ../../dist/dashboard`.
**Done when:** `npm run build` succeeds, `dist/dashboard/index.html` exists, opening it in browser renders the empty grid with sweech theme tokens applied.

### T-DASH-002 · sessions.ts driver + sessions.db
**Files:** `src/sessions.ts` (new), `tests/sessions.test.ts` (new), `src/dbMigrations.ts` (new if absent).
**Tasks:**
- Use `node:sqlite` (built-in). Lazy-open `~/.sweech/sessions.db`.
- Schema per spec §Data model. WAL mode, no fsync on writes (perf).
- CRUD: `insert(launch)`, `updateStatus(id, status)`, `markActivity(id)`, `list(filter)`, `byId`, `bulkWipe(opts)`.
- Reconcile job: on daemon startup, any `live` row whose tmux session is gone OR pid is dead → flip to `crash-recoverable`.
- 20+ tests covering schema migration from empty, status lifecycle, filter SQL, retention wipe.
**Done when:** `npm test` green, all CRUD operations roundtrip.

### T-DASH-003 · terminalLauncher.ts
**Files:** `src/terminalLauncher.ts` (new), `tests/terminalLauncher.test.ts` (new).
**Tasks:**
- Detect installed terminals: Ghostty (`mdfind kMDItemCFBundleIdentifier == 'com.mitchellh.ghostty'`), iTerm2, Terminal.app, alacritty/kitty/wezterm via `which`.
- `launchTerminal({terminal,command,cwd,newWindow,title})` API.
- Per-terminal implementations:
  - **Ghostty** → `open "ghostty://run?command=..."`, fallback `ghostty -e <cmd>` if URL scheme not registered.
  - **iTerm2** → `osascript -e 'tell application "iTerm2" to create window with default profile command "..."'`
  - **Terminal.app** → `osascript -e 'tell application "Terminal" to do script "..."'`
  - **Generic** → `<binary> -e <cmd>`
- Refuse to launch if binary missing; return `{ok:false, reason}` with install hint.
- Mock `execFile` in tests; assert command strings exactly.
**Done when:** unit tests pass + manual smoke (one launch per detected terminal opens correctly).

### T-DASH-004 · tmux.ts integration
**Files:** `src/tmux.ts` (new), `tests/tmux.test.ts` (new).
**Tasks:**
- `tmuxAvailable()` — boolean cached for the process lifetime.
- `nameForSession(commandName, cwd, sid)` → `<basename(cwd)>-<commandName>-sweech` with `-<sid8>` suffix on collision.
- `wrapCommand(cmd, args, sessionName, opts)` returns the tmux-wrapped command for the wrapper to exec.
- `listLiveSessions()` parses `tmux list-sessions -F '#{session_name}|#{session_attached}|#{session_activity}'`.
- `attachClients(sessionName)` returns count via `tmux list-clients -t <name> | wc -l` — feeds Q5 badge.
- 12+ tests covering naming, collision suffix, attach-count parsing.
**Done when:** tests green; CLI smoke `tmux new -d -s test; sweech _tmux-probe` shows the session.

### T-DASH-005 · dashboardServer.ts + SSE plumbing
**Files:** `src/dashboardServer.ts` (new), `tests/dashboardServer.test.ts` (new), edits to existing `src/fedServer.ts` to mount routes.
**Tasks:**
- Static file serving of `dist/dashboard/` at `/`.
- REST routes per spec §API. Use existing fedServer's HTTP plumbing.
- SSE handler at `/dashboard/events` that holds connection and pushes typed events. EventBus pattern: each mutation in sessions/audit/doctor pushes to subscribers.
- `event: session.changed`, `event: audit.flagged`, `event: doctor.tick`, `event: peer.online/offline`, `event: cost.tick`, `event: summary.updated`.
- Heartbeat every 15s to keep proxies happy.
- 10+ tests: route handlers, SSE event format, auth (localhost-only refuses external).
**Done when:** `curl -N http://127.0.0.1:<port>/dashboard/events` streams events.

---

## Wave 2 — Wrapper integration + backend features (depends on Wave 1)

### T-DASH-006 · Wrapper writes sessions.db + tmux-wraps
**Files:** `src/config.ts` (createWrapperScript edit).
**Depends:** T-DASH-002, T-DASH-004.
**Tasks:**
- Wrapper now writes a sessions.db row on launch (sid extracted from claude's pending jsonl by re-stat after exec or pre-allocated).
- tmux wrap: `tmux new -d -s <name> -- <claude command>` when tmux enabled.
- Bash pre-check now extended: check sessions.db exists; create row if missing.
- Hidden CLI `_session-launched` writes the row (called by wrapper synchronously, < 50ms).
- Tmux exit hook: `set-hook -g session-closed 'run "sweech _session-closed #{session_name}"'` in default tmux config? Or polling reconciler in daemon.
- Update `tests/shareTopologyHeal.test.ts` to assert new wrapper template includes sessions.db write.
**Done when:** running `claude-pole` produces a row; killing it flips status; tests pass.

### T-DASH-007 · Nuke old dashboard.ts + retarget command
**Files:** delete `src/dashboard.ts`, edit `src/cli.ts` `dashboard` command.
**Depends:** T-DASH-001, T-DASH-005.
**Tasks:**
- Delete `src/dashboard.ts` entirely.
- Edit `sweech dashboard` action handler to: start fed daemon if down, open browser to `http://127.0.0.1:<fedPort>/`.
- Update README + AGENTS.md mentions.
- Remove dead tests.
**Done when:** `sweech dashboard` opens the new React app; old HTML page is gone.

### T-DASH-008 · sessionSummarizer.ts (AI tiles)
**Files:** `src/sessionSummarizer.ts` (new), `tests/sessionSummarizer.test.ts` (new).
**Depends:** T-DASH-002.
**Tasks:**
- Reads jsonl events (last 20-30), aiTitle, message counts; constructs prompt.
- Calls `sweech auto --provider ollama` (or shells out to a local ollama URL) first; on timeout/error, falls back to `sweech auto --budget 0.005`.
- Writes back to sessions.db: `summary_one`, `summary_bullets`, `summary_provider`, `summary_model`, `summary_cost_usd`, `summary_at`, `summary_msg_at`, `summary_stale=0`.
- Queue with debounce: process at most 1 every 5s. Hybrid trigger: eager every 50 msgs + on session-end; lazy on dashboard viewport scroll.
- Emit SSE `summary.updated` events.
- 15+ tests: prompt construction, response parsing, fallback chain, debouncing, staleness flag.
**Done when:** running on a real jsonl produces a summary row in <30s.

### T-DASH-009 · Federation routes
**Files:** edits to `src/fedServer.ts` adding `/fed/dashboard/*` group.
**Depends:** T-DASH-005.
**Tasks:**
- `GET /fed/dashboard/state` — peer's snapshot (sessions + accounts + status). HMAC required.
- `POST /fed/dashboard/restore` — RPC to spawn ghostty+tmux on this peer. HMAC.
- `POST /fed/dashboard/summary` — receive a pushed summary from a peer (for federated summary backfill).
- mDNS announcement extended: TXT record `caps=dashboard-v1`.
- Discovery polling: every 10s while dashboard is open, daemon refreshes peers cache.
- Test cross-machine integration with two daemons on different ports + separate sessions.db.
**Done when:** two local daemons see each other in `/fed/dashboard/state`.

---

## Wave 3 — Panels (parallel, depend on Wave 1+2)

### T-DASH-010 · Sessions panel ★ (the headline)
**Files:** `apps/dashboard/src/panels/Sessions.tsx`, `apps/dashboard/src/components/SessionTile.tsx`, supporting hooks.
**Depends:** T-DASH-001, T-DASH-005, T-DASH-008.
**Tasks:**
- Full sessions grid with filters (machine, status, workspace, search), sort (last-active default).
- Tile design per spec: status dot, ★ for local, machine pill, workspace name, cwd, AI summary, 3-5 recent activities, message count, sparkline, timestamps, tmux name, pid + tty (Q3), viewer count badge (Q5), `↗ jump` button.
- Restore handler — calls `POST /dashboard/sessions/:id/restore` (or `/fed/dashboard/restore` for remote).
- Click tile body opens detail dialog with full timeline.
- Empty state: setup wizard CTA per Q4.
- Skeleton states while summaries are pending.
- 10+ component tests (vitest + RTL).
**Done when:** real sessions render correctly across states; click `↗ jump` opens Ghostty+tmux.

### T-DASH-011 · Workspaces / Accounts / Cost panels
**Files:** `apps/dashboard/src/panels/{Workspaces,Accounts,Cost}.tsx`.
**Depends:** T-DASH-001, T-DASH-005.
**Tasks:**
- **Workspaces**: grid of workspace cards, status pill, sharedWith chip, last-used, click → edit dialog.
- **Accounts**: per-account usage bar (UsageBar from vysual), staleness chip (R13), 5h + 7d windows, tokenStatus pill.
- **Cost**: Sparkline week-to-date, cost breakdown by provider, summary spend (from sessionSummarizer rollup).
- Every card shows freshness chip per R13.

### T-DASH-012 · Audit / Failover / Routing / Billing panels
**Files:** `apps/dashboard/src/panels/{Audit,Failover,Routing,Billing}.tsx`.
**Depends:** T-DASH-001, T-DASH-005.
**Tasks:**
- **Audit**: list findings with severity dot; one-click `[fix →]` for `cli_type_mismatch` + `provider_misconfig` (calls `POST /dashboard/audit/fix-*`). Existing audit engine reused.
- **Failover**: active cooldowns + history; `[clear]` button per row.
- **Routing**: project pins list with cwd → workspace mapping; quick `pin set`/`pin unset` actions.
- **Billing**: 30-day calendar grid, billing-day markers from `~/.sweech/billing.json`.

### T-DASH-013 · Doctor / Logs / Plugins / Templates panels
**Files:** `apps/dashboard/src/panels/{Doctor,Logs,Plugins,Templates}.tsx`.
**Depends:** T-DASH-001, T-DASH-005.
**Tasks:**
- **Doctor**: row per check with severity dot, structural live + network every 60s (Q2 hybrid). Manual refresh button.
- **Logs**: tail `~/.sweech/logs/lifecycle.jsonl` via SSE; filter by event type.
- **Plugins**: list installed plugins; `[install pkg…]` dialog.
- **Templates**: saved templates; CRUD via existing CLI surface.

### T-DASH-014 · Federation panel + Settings drawer
**Files:** `apps/dashboard/src/panels/Federation.tsx`, `apps/dashboard/src/panels/Settings.tsx`, `apps/dashboard/src/components/SettingsDrawer.tsx`.
**Depends:** T-DASH-001, T-DASH-005, T-DASH-009.
**Tasks:**
- **Federation panel**: peer cards with last-seen, capabilities, session counts. Manual-refresh button.
- **Settings drawer (Q1)** — slides in from right, sections: General · tmux · Terminal · Summaries · Federation · Retention · Refresh cadence. Each row reads/writes `/dashboard/settings`.
- **Setup wizard** (Q4 empty state entry point): multi-step modal: detect CLIs → pick provider → create first workspace → done.

### T-DASH-015 · Hero strip + freshness chips + viewer-count badge
**Files:** `apps/dashboard/src/components/{HeroStrip,FreshnessChip,ViewerCountBadge}.tsx`.
**Depends:** T-DASH-001.
**Tasks:**
- Top-of-page hero: live count, recoverable count, cost-MTD, doctor severity dot.
- `<FreshnessChip fetchedAt={n} />` shared component per R13 (4-state).
- `<ViewerCountBadge count={n} />` per Q5 (hides when ≤ 1).
- 8+ component tests.

### T-DASH-019 · Subscription balance (provider-based)
**Files:** `src/subscriptionBalance.ts` (new), `apps/dashboard/src/panels/Balance.tsx`, `src/cli.ts` (new `sweech balance` subcommand).
**Depends:** T-DASH-001, T-DASH-005.
**Tasks:**
- Subscription model: key = `<provider>:<accountId>`, target utilization + window per spec §Q6 (default billing-aligned, rolling-weekly fallback).
- Compute gap per subscription from existing rate-limit-cache + history + billing.json.
- Map workspaces → subscriptions (existing `profile.provider` + account binding).
- Routing: `sweech auto --balance` weights candidates by gap score; tiebreak existing.
- CLI: `sweech balance show | set <sub> --target X | suggest | hint`.
- Panel: table per spec mockup, "[auto-use ★★ for next launch]" CTA.
- 15+ tests covering gap computation, billing-window resolution, multiple-account-per-provider.

### T-DASH-020 · Daily briefing
**Files:** `src/briefing.ts` (new), `apps/dashboard/src/components/TodaysBriefing.tsx`, `src/cli.ts` (`sweech briefing`).
**Depends:** T-DASH-019.
**Tasks:**
- Background job at user-configured time (default 09:00 local) computes briefing from sessions.db + balance state.
- AI suggestion section uses existing hybrid local-first summariser pattern (~£0.001/day).
- Surfaces: dashboard sticky banner (per-day dismissible), macOS notification, `sweech briefing` CLI, SweechBar badge.
- Settings: `briefing.time`, `briefing.channels`, `briefing.includeSuggestions`.
- 10+ tests covering content generation, channel routing, dismissal persistence.

### T-DASH-021 · opencode cliType support
**Files:** `src/clis.ts` (add entry), `src/config.ts` createWrapperScript (XDG_CONFIG_HOME isolation branch).
**Depends:** T-DASH-001.
**Tasks:**
- Register: `command: 'opencode'`, `yoloFlag: '--dangerously-skip-permissions'`, `resumeFlag: '--continue'`, `sessionNameFlag: '--title'`.
- Wrapper sets `XDG_CONFIG_HOME=<profileDir>/.config` and `XDG_DATA_HOME=<profileDir>/.local/share` for opencode profiles.
- Reuse settings.json env hoist pattern from codex.
- Add `sessions/` discovery for opencode session listing (reuse claude `--session` flag semantics).
- 10+ tests: wrapper template, env construction, settings.json round-trip.
- Reference upstream runner: `/Users/luke/dev/sweech/packages/engine/runner/opencode.ts`.

### T-DASH-022 · gemini-cli cliType support
**Files:** `src/clis.ts`, `src/config.ts` createWrapperScript (or extend opencode path).
**Depends:** T-DASH-021 (XDG isolation pattern).
**Tasks:**
- Register: `command: 'gemini'`, `yoloFlag: '-y'`, `nonInteractiveFlag: '-p'`, no resume.
- Auth: prefer OAuth via `gemini auth login`, fall back to `GEMINI_API_KEY` env.
- Config dir: `~/.gemini/` per-profile via XDG redirect.
- Tests + smoke.
- Reference: `/Users/luke/dev/sweech/packages/engine/runner/gemini.ts`.

### T-DASH-024 · jcode cliType support
**Files:** `src/clis.ts`, wrapper template, install detection.
**Depends:** T-DASH-021 (XDG pattern).
**Tasks:**
- Register `command: 'jcode'`. Install path via homebrew tap `1jehuang/homebrew-jcode` or `curl install.sh`.
- Multi-session aware — sweech's session model needs to capture jcode's `--session` semantics.
- Performance-optimized (per upstream README), so wrapper must add minimal overhead.
- XDG isolation per profile.
- 10+ tests covering registration + wrapper.
- Reference: `gh repo view 1jehuang/jcode`, install script at `master/scripts/install.sh`.

### T-DASH-026 · mDNS sweech.local hostname
**Files:** edits to existing `src/fedServer.ts` mDNS announcer + `src/cli.ts` dashboard command.
**Depends:** T-DASH-007.
**Tasks:**
- Register `sweech.local` A record via the fed daemon's existing mDNS responder (Bonjour).
- Dashboard URL becomes `http://sweech.local:<port>/` when mDNS is up; fall back to `127.0.0.1:<port>` silently when not.
- Browser auto-open uses the prettiest available URL.
- Collision handling: if `sweech.local` is already claimed (another sweech instance, conflicting service), prefix with hostname: `<short-hostname>-sweech.local`.
- 5+ tests: URL resolution priority, fallback path, collision suffix.

### T-DASH-027 · cute-hud notification integration
**Files:** `src/notify.ts` (new, cute-hud broker), edits to `src/briefing.ts` to use it.
**Depends:** T-DASH-020 (briefing).
**Tasks:**
- Detect cute-hud install (`which cute-hud`). If missing, fall back to `osascript display notification`.
- JSON-line protocol per `vykeai/cute-hud` README: `{mode,title,badge,action,countdown,...}` piped to stdin.
- Map briefing severities → cute-hud modes: at-risk subs → `warning`, on-track → `info`, summary read → `idle`.
- Respect macOS Focus mode — cute-hud already does; sweech also adds a settings flag `briefing.skipDuringFocus: true` default.
- Tests: command construction, fallback path when cute-hud absent.

### T-DASH-028 · cmd+K command palette
**Files:** `apps/dashboard/src/components/CommandPalette.tsx`, registry of palette commands per panel.
**Depends:** T-DASH-001.
**Tasks:**
- Keyboard shortcut `cmd+K` (mac) / `ctrl+K` (linux) opens a centered modal with search input.
- Fuzzy search across: sessions (by workspace/cwd/title), workspaces, accounts, audit findings, settings keys.
- Each result has a default action: `enter` triggers (jump to session, open workspace edit, fix audit, toggle setting).
- Recent commands ring-buffer in zustand store, surfaced when input is empty.
- Keyboard navigation: ↑↓ + enter; ESC to close.
- 12+ tests: fuzzy matching, action dispatch, recent ring buffer.

### T-DASH-029 · sweech bare-invocation dashboard auto-open
**Files:** `src/cli.ts` default action handler (currently shows help on no args).
**Depends:** T-DASH-007.
**Tasks:**
- New setting: `dashboard.openOnBareInvocation: false` default.
- When `true` and `sweech` is run with no args, behave as `sweech dashboard`.
- When `false`, current behaviour (show help) — print one hint line "tip: run `sweech dashboard` to open the control panel".
- `sweech dash` registered as alias of `sweech dashboard`.
- 5+ tests covering the toggle.

### T-DASH-025 · Cloud-vs-local provider classification
**Files:** `src/providers.ts` (add `pricingModel` field on every entry), `src/usageProxy.ts` (new, Tier 2/3 estimators), `~/.sweech/balance-manual.json` (Tier 4 manual entries), tests.
**Depends:** none — independent foundation for T-DASH-019.
**Tasks:**
- Add `pricingModel: 'paid' | 'free' | 'metered'` to ProviderConfig type.
- Annotate every entry: anthropic/openai/kimi/glm/minimax/dashscope/openrouter/ollama-cloud/kimi-coding → `paid`; groq/deepseek/gemini/nvidia → `metered`; ollama-local + custom-with-localhost → `free`.
- Auto-classifier for user-created custom providers: localhost-pattern + authOptional → `free`, else `paid`.
- `usageProxy.ts`: Tier 2 (cost × token sums from sessions.db) and Tier 3 (launch-count proxy) estimators.
- Balance panel + briefing both consult `pricingModel` to decide eligibility.
- Settings panel: per-provider override of detected tier.
- 20+ tests: classification, tier overrides, manual marker read/write.

### T-DASH-023 · goose cliType support
**Files:** `src/clis.ts`, `src/config.ts` createWrapperScript, goose YAML config writer.
**Depends:** T-DASH-021.
**Tasks:**
- Register: `command: 'goose'`, `yoloFlag: null` (config-driven via `GOOSE_MODE`), `resumeFlag: '--resume'`, `sessionNameFlag: '-n'`.
- Per-profile `config.yaml` generation (analogous to kimi's config.toml writer) — provider, model, mode.
- XDG isolation for `~/.config/goose/` and `~/.local/share/goose/`.
- Tests for YAML emission + provider-block round-trip.
- Reference: `/Users/luke/dev/sweech/packages/engine/runner/goose.ts`.

---

## Wave 4 — Review + ship (sequential)

### T-DASH-016 · E2E tests
**Files:** `tests/e2e/dashboard.spec.ts` (Playwright).
**Depends:** ALL prior tasks.
**Tasks:**
- Cold-load dashboard, see empty state.
- Launch claude-pole, see session tile populate via SSE.
- Click `↗ jump`, assert terminal launch attempted.
- Simulate Mac reboot (kill tmux server), see status flip to crash-recoverable.
- Filter + sort + search.
- Settings drawer open/edit/persist.
- Federation: two daemons, cross-machine restore.
**Done when:** Playwright suite green.

### T-DASH-017 · Codex adversarial review
**Files:** N/A (review).
**Depends:** all T-DASH-001..016 merged.
**Tasks:**
- Launch codex with a fresh-context adversarial reviewer prompt on the full diff.
- Required focus areas: race conditions in sessions.db (concurrent wrappers), SSE memory leaks, federation HMAC handling, terminalLauncher shell injection, summary prompt injection.
- Fix all critical + major findings before ship.
**Done when:** codex returns "approve" or only minor findings remain.

### T-DASH-018 · Ship
- Bump `package.json` version → `0.4.0`.
- Update CHANGELOG.
- `npm test`, `npm run build`, `git commit`, `git push`.
- Verify `sweech dashboard` works end-to-end on local laptop.
- Manual: real cross-machine restore (laptop → mac-studio) — deferred if mac-studio not upgraded.

---

## Execution order for `/vy-go`

```
PARALLEL Wave 1 (5 agents, each own worktree):
  ┣━ T-DASH-001 (frontend scaffold)
  ┣━ T-DASH-002 (sessions.db)
  ┣━ T-DASH-003 (terminalLauncher)
  ┣━ T-DASH-004 (tmux)
  ┗━ T-DASH-005 (dashboardServer + SSE)
                ↓ merge sequentially with `git merge --no-ff`
PARALLEL Wave 2 (4 agents):
  ┣━ T-DASH-006 (wrapper integration)
  ┣━ T-DASH-007 (nuke old dashboard)
  ┣━ T-DASH-008 (sessionSummarizer)
  ┗━ T-DASH-009 (federation routes)
                ↓ merge
PARALLEL Wave 3 (17 agents):
  ┣━ T-DASH-010 (Sessions panel)
  ┣━ T-DASH-011 (Workspaces/Accounts/Cost)
  ┣━ T-DASH-012 (Audit/Failover/Routing/Billing)
  ┣━ T-DASH-013 (Doctor/Logs/Plugins/Templates)
  ┣━ T-DASH-014 (Federation/Settings/Wizard)
  ┣━ T-DASH-015 (Hero/Freshness/Viewer chips)
  ┣━ T-DASH-019 (Balance backend + panel)
  ┣━ T-DASH-020 (Daily briefing)
  ┣━ T-DASH-021 (opencode cliType)
  ┣━ T-DASH-022 (gemini-cli cliType)
  ┣━ T-DASH-023 (goose cliType)
  ┣━ T-DASH-024 (jcode cliType)
  ┣━ T-DASH-025 (cloud-vs-local classification + usageProxy)
  ┣━ T-DASH-026 (sweech.local mDNS)
  ┣━ T-DASH-027 (cute-hud notification integration)
  ┣━ T-DASH-028 (cmd+K command palette)
  ┗━ T-DASH-029 (sweech bare-invocation auto-open + sweech dash alias)
                ↓ merge
SEQUENTIAL Wave 4:
  ┣━ T-DASH-016 (E2E)
  ┣━ T-DASH-017 (codex review)
  ┗━ T-DASH-018 (ship)
```

Total: **29 tasks across 4 waves**, ~17 unique agents in parallel at peak.

Acceptance criteria for "done with backlog":
- `sweech dashboard` opens new React app in default browser
- All 14 panels render with real data
- Cold-load < 800 ms on M-series Mac
- Cross-machine restore proven (when both ends upgraded)
- 100% test green (`npm test`) + Playwright E2E green
- Codex adversarial review approved
- Old `src/dashboard.ts` deleted
- Spec marked APPROVED + IMPLEMENTED-IN commit hash
