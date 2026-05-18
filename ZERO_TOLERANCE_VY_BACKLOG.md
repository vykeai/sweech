## Backlog: Zero Tolerance v0.4 Recovery — 18 Tasks

### Wave Summary

- **Mode:** SHRED
- **Source:** `ZERO_TOLERANCE_BACKLOG.md`, generated from `PRODUCT_STORY.md`, `PRODUCT_GAPS.md`, and `BRUTAL_ASSESSMENT.md` on 2026-05-18
- **Tasks:** 18 total — S:4 M:10 L:4
- **Coverage:** 18 findings/recommendations → 18 tasks, with duplicate dashboard/session-recovery findings clustered into the product spine
- **Keel status:** ready to create as a Keel wave when a full Keel writer is available. The installed shim cannot safely run `keel wave create` or `keel task add`.

### Tasks

#### 1. Fix Jest green-output/non-zero-exit leak

- **Source:** "`npm test -- --runInBand` reports 89/89 suites passing, 2,237/2,242 tests passing/skipped, then exits `2`"
- **Criteria:**
  - [x] `npm test -- tests/doctorTokenRefresh.test.ts --runInBand` prints passing tests and exits `0`.
  - [x] `npm test -- --runInBand` prints passing tests and exits `0`.
  - [x] Tests that call `runDoctor()` restore `process.exitCode` and console spies after each capture.
  - [x] The fix does NOT change production `sweech doctor` severity exit-code behavior.
- **Size:** S
- **Depends on:** none
- **Risk:** low; already implemented in commit `b681dd4`.

#### 2. Regenerate or repair generated Keel views

- **Source:** "`views/roadmap.md` is empty; `views/tasks.md` shows only 3 tasks while task JSON has 120 files"
- **Criteria:**
  - [ ] `views/roadmap.md` shows active, ready, and todo waves including Wave 5 and Wave 7.
  - [ ] `views/tasks.md` includes all active, ready, blocked, and todo tasks from `keel/tasks/*.json`.
  - [ ] Regeneration command is documented in the task note or script output.
  - [ ] The fix does NOT hand-edit generated views as the final source.
- **Size:** S
- **Depends on:** none
- **Risk:** medium; current `keel` shim may not include the render command.

#### 3. Add binary acceptance criteria to every Wave 7 task JSON

- **Source:** "All `T-DASH-*` tasks are missing machine-readable acceptance criteria."
- **Criteria:**
  - [ ] Every `keel/tasks/T-DASH-*.json` has `acceptanceCriteria` with 3-5 binary criteria.
  - [ ] Every task has at least one negative criterion using "does NOT".
  - [ ] Criteria include explicit verification methods: test, grep, screenshot, curl, or manual smoke.
  - [ ] The criteria do NOT expand a task beyond one L-sized session.
- **Size:** M
- **Depends on:** none
- **Risk:** medium; criteria need to preserve the spec without creating mega-tasks.

#### 4. Split oversized Wave 7 panel and release tasks into one-session tasks

- **Source:** "Several tasks are too large for one safe session: `T-DASH-010`, `T-DASH-011`, `T-DASH-012`, `T-DASH-013`, `T-DASH-014`, `T-DASH-018`, `T-DASH-019`, `T-DASH-020`, `T-DASH-032`."
- **Criteria:**
  - [ ] Each listed task is split or scoped so no child task is larger than L.
  - [ ] Dependencies form a DAG and foundation tasks precede UI panel tasks.
  - [ ] `T-DASH-018` becomes a release gate checklist, not implementation work.
  - [ ] The split does NOT delete or narrow any promised feature without a deferred task.
- **Size:** M
- **Depends on:** task 3
- **Risk:** medium; scope discipline matters more than task count.

#### 5. Reorder Wave 7 around the session-recovery vertical slice

- **Source:** "The fastest path to something a real user could touch is ... launch a workspace, create a durable session row, tmux-wrap it, show it in a minimal React sessions panel, and click back into the session."
- **Criteria:**
  - [ ] Foundation order is `sessions.db` → `tmux.ts` → `terminalLauncher.ts` → dashboard server/SSE → wrapper writes → minimal Sessions UI.
  - [ ] `T-DASH-016` E2E starts once the first dashboard state endpoint exists.
  - [ ] Security review tasks cover terminal launch and HMAC federation before broad UI buildout.
  - [ ] The order does NOT put decorative panels before restore proof.
- **Size:** S
- **Depends on:** tasks 3, 4
- **Risk:** low; this is backlog surgery, not product code.

#### 6. Create durable `sessions.db` lifecycle storage

- **Source:** "The v0.4 spec depends on a durable session ledger..."
- **Criteria:**
  - [ ] `src/sessions.ts` creates and migrates `~/.sweech/sessions.db` with the spec schema.
  - [ ] CRUD covers insert, updateStatus, markActivity, list, byId, and bulkWipe.
  - [ ] Reconcile marks dead live rows as `crash-recoverable`.
  - [ ] Tests cover empty migration, lifecycle, filters, and wipe behavior.
  - [ ] It does NOT corrupt or rewrite existing `~/.sweech` config/history files.
- **Size:** L
- **Depends on:** task 1
- **Risk:** high; persistent user data and migration behavior need careful tests.

#### 7. Add tmux naming, wrapping, and live-session probes

- **Source:** "tmux-backed crash recovery, one-click terminal restore..."
- **Criteria:**
  - [ ] `src/tmux.ts` exposes availability, deterministic names, wrapCommand, listLiveSessions, and attachClients.
  - [ ] Session-name collisions append a stable short suffix.
  - [ ] Tests cover naming, collision, list parsing, and client count parsing.
  - [ ] The wrapper does NOT require tmux when tmux is disabled or missing.
- **Size:** M
- **Depends on:** task 6
- **Risk:** medium; tmux availability varies by machine.

#### 8. Add safe terminal launcher for Ghostty, iTerm2, Terminal.app, and generic terminals

- **Source:** "Click `↗ jump` → terminal launcher opens user's preferred terminal..."
- **Criteria:**
  - [ ] `src/terminalLauncher.ts` launches Ghostty, iTerm2, Terminal.app, or generic `-e` command.
  - [ ] Missing terminal returns `{ ok:false, reason }` with install hint.
  - [ ] Tests assert exact `execFile`/`osascript` argument construction.
  - [ ] The launcher does NOT invoke shell interpolation with untrusted session/cwd values.
- **Size:** M
- **Depends on:** task 7
- **Risk:** high; terminal commands are security-sensitive.

#### 9. Extend dashboard server with static app, state routes, and SSE

- **Source:** "Dashboard state API: not present. Dashboard SSE stream: not present."
- **Criteria:**
  - [ ] `src/dashboardServer.ts` serves `dist/dashboard/` at `/`.
  - [ ] `/dashboard/state`, `/dashboard/sessions`, `/dashboard/sessions/:id/restore`, and `/dashboard/events` exist.
  - [ ] SSE sends typed events and a 15s heartbeat.
  - [ ] Routes bind to localhost by default and reject non-local dashboard access.
  - [ ] The server does NOT remove existing `/fed/*` contracts.
- **Size:** L
- **Depends on:** tasks 6, 8
- **Risk:** high; route/auth mistakes affect the control plane.

#### 10. Make wrappers write session rows and tmux-wrap launches

- **Source:** "launch a workspace, create a durable session row, tmux-wrap it..."
- **Criteria:**
  - [ ] Wrapper launch creates a `sessions.db` row with workspace, cwd, pid, tmux name, timestamps, and status.
  - [ ] Hidden CLI hooks update lifecycle on launch/close without exceeding 50ms normal overhead.
  - [ ] Killing or detaching a tmux session reconciles to the expected status.
  - [ ] The wrapper does NOT break existing `sweech use`, `sweech run`, `--resume`, or `--yolo` behavior.
- **Size:** L
- **Depends on:** tasks 6, 7, 9
- **Risk:** high; wrapper regressions break the core CLI.

#### 11. Scaffold the React dashboard around real state, not placeholders only

- **Source:** "Do not build the dashboard as a decorative shell. The flagship feature is one-click recovery into the right terminal/tmux session."
- **Criteria:**
  - [ ] `apps/dashboard` builds into `dist/dashboard`.
  - [ ] The initial app consumes `/dashboard/state` and `/dashboard/events`.
  - [ ] Empty states and loading states exist for sessions/accounts/cost/doctor panels.
  - [ ] The scaffold does NOT replace real state with permanent mock-only tiles.
- **Size:** L
- **Depends on:** task 9
- **Risk:** medium; UI can drift into mock/demo behavior if state contracts are weak.

#### 12. Build the minimal Sessions panel with one-click restore

- **Source:** "show it in a minimal React sessions panel, and click back into the session."
- **Criteria:**
  - [ ] Live, detached, recoverable, and closed sessions render as distinct tile states.
  - [ ] Tile includes workspace, cwd, machine, pid, tmux name, timestamps, and restore button.
  - [ ] Restore calls the local restore endpoint and reports success/failure.
  - [ ] Screenshot proof exists for empty state and populated state.
  - [ ] The panel does NOT hide failed restore errors.
- **Size:** M
- **Depends on:** tasks 10, 11
- **Risk:** high; this is the core user-visible v0.4 proof.

#### 13. Keep legacy dashboard until React restore flow is proven, then retarget

- **Source:** "Keep the legacy dashboard until the new dashboard passes an end-to-end restore flow, then delete it in the retarget task."
- **Criteria:**
  - [ ] `sweech dashboard` opens the React dashboard only after the restore E2E passes.
  - [ ] `src/dashboard.ts` is removed only in the retarget commit.
  - [ ] README/help text reflects the actual dashboard behavior.
  - [ ] The retarget does NOT remove legacy functionality before replacement proof exists.
- **Size:** M
- **Depends on:** task 12
- **Risk:** medium; premature deletion would remove the only working dashboard.

#### 14. Add LAN dashboard federation routes with HMAC protection

- **Source:** "LAN dashboard federation: not present."
- **Criteria:**
  - [ ] `/fed/dashboard/state`, `/fed/dashboard/restore`, and `/fed/dashboard/summary` exist.
  - [ ] Each route requires valid HMAC except public compatibility metadata.
  - [ ] Two local daemon instances can exchange state with isolated data dirs.
  - [ ] The federation routes do NOT send raw conversation JSONL across machines.
- **Size:** M
- **Depends on:** tasks 9, 12
- **Risk:** high; HMAC and privacy boundaries must be exact.

#### 15. Add AI session summaries after the session spine works

- **Source:** "AI-generated session summaries: not present."
- **Criteria:**
  - [ ] `src/sessionSummarizer.ts` summarizes recent JSONL activity into title, one-liner, and bullets.
  - [ ] Local-first provider path is attempted before metered fallback.
  - [ ] Summary cost/provider/model are stored in `sessions.db`.
  - [ ] Prompt construction does NOT allow raw transcript instructions to override the summary contract.
- **Size:** M
- **Depends on:** task 12
- **Risk:** high; prompt-injection and spend controls matter.

#### 16. Add subscription balance as a shared routing contract

- **Source:** "There are two routing layers in play... These need one shared scoring contract."
- **Criteria:**
  - [ ] Balance score is computed per `<provider>:<accountId>` using usage/cache/history/billing data.
  - [ ] `sweech auto --balance` uses the same score exposed to the dashboard panel.
  - [ ] CLI and dashboard display the same recommended account for the same fixture.
  - [ ] The score does NOT override hard-limit or disabled/hidden account exclusions.
- **Size:** M
- **Depends on:** task 12
- **Risk:** medium; scoring changes can alter account selection behavior.

#### 17. Add daily briefing only after balance and sessions are real

- **Source:** "Daily briefing: not present."
- **Criteria:**
  - [ ] `sweech briefing` summarizes session recovery, balance risks, and recommended next launches.
  - [ ] Dashboard banner and SweechBar badge read the same briefing state.
  - [ ] Dismissal persists per day.
  - [ ] Briefing generation does NOT spend cloud budget when local-only mode/cap is active.
- **Size:** M
- **Depends on:** tasks 15, 16
- **Risk:** medium; depends on two new data products being real first.

#### 18. Final v0.4 release proof gate

- **Source:** "Capture screenshots and terminal proof for the dashboard, session tile, and restore flow."
- **Criteria:**
  - [ ] `npm run build`, `npx tsc --noEmit`, `npm test -- --runInBand`, and `swift build` all exit `0`.
  - [ ] Playwright screenshots prove empty dashboard, populated sessions, restore error, and restore success states.
  - [ ] Manual terminal proof shows launch → tmux session → dashboard tile → restore.
  - [ ] README and CHANGELOG match shipped behavior.
  - [ ] The release does NOT claim any unimplemented panel or automation as shipped.
- **Size:** M
- **Depends on:** tasks 2-17
- **Risk:** medium; this is a gate and should not contain implementation work.

### Verification

- [x] Every task scores 4+ on vagueness.
- [x] Every task has binary acceptance criteria.
- [x] No task is larger than L.
- [x] Dependencies form a DAG.
- [x] Stopping at 50% leaves useful product infrastructure: fixed gates, repaired backlog, session ledger, tmux/terminal/server foundations, and wrapper integration.
- [x] Full scope is larger than one 1-2 week wave if all downstream features are included; tasks 1-12 should be treated as the first executable recovery wave, with tasks 13-18 as follow-on gates/extensions.

### Keel Creation

Create as Keel wave? **Ready, but blocked by local Keel shim.**

Intended commands once full Keel writer is available:

```bash
keel wave create "Zero Tolerance v0.4 Recovery"
keel task add "Fix Jest green-output/non-zero-exit leak" --wave <wave-id> --priority critical
keel note add --task <task-id> "Acceptance criteria:\n- [x] npm test -- tests/doctorTokenRefresh.test.ts --runInBand exits 0\n- [x] npm test -- --runInBand exits 0\n- [x] Tests that call runDoctor restore process.exitCode and console spies\n- [x] Does NOT change production sweech doctor severity exit-code behavior"
```
