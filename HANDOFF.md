# Handoff — 2026-05-17 (wave T-LU-005/007/008/009 + 2 review rounds)

## What was completed this session

All 4 remaining MEDIUM-priority tasks from the prior wave shipped to `origin/main` (commit `a1a5952`). The wave totalled ~5,200 lines added across 9 new source modules + tests, ran 4 build agents in parallel, and survived **two adversarial review rounds** (Claude code-reviewer + security-reviewer + integration-audit, then codex/gpt-5.4 adversarial via `codex review --base`).

### Tasks shipped

- **T-LU-005** — `sweech serve --status` + `isLaunchdRunning()` + doctor launchd integration (`762a487`)
  - Existing `installLaunchd` / `uninstallLaunchd` were already wired; the gap was status detection + doctor wiring.
  - New `LaunchdStatus { installed, running, pid }` via `launchctl list ai.sweech.serve` PID-dict parse.
  - `sweech serve --status` exit codes 0/1/2 (running / installed-not-running / not-installed). Non-macOS exits 2.
  - `sweech doctor` shows "launchd daemon" row with four states (running with pid, installed-not-running warning, running standalone, not installed).
  - 27 tests in `tests/launchd.test.ts` (mock execSync + fs).

- **T-LU-007** — `sweech cost` + `routeWithinBudget()` API (`6ae65c2` + codex fix in `a1a5952`)
  - `src/costs.ts` — 30+ model pricing table (Claude 3.5/3.7/4.x, GPT-5 family, Kimi K2 variants, Qwen3 coder, DeepSeek, GLM 4.6/5/5.1, MiniMax M2.x, Grok). `~/.sweech/pricing.json` override.
  - `src/budgetRouter.ts` — `routeWithinBudget({cliType, maxCostPerCallUsd, projectPin})` for codeuctor + downstream callers. Honors cooldowns, tier caps, pin's maxTier.
  - `src/costCommand.ts` — `buildCostTable` + `buildProfileDetail` + `computeSpend7d`. JSON output has `schemaVersion: 'sweech.cost-table.v1'`, `producer: 'sweech'`.
  - 7d spend reads BOTH `audit.jsonl` `token_usage` events (exact) AND `~/.sweech/launches.log` (estimated via profile's default model × 5000 in / 1500 out). Codex caught that without launches.log ingestion, the column always showed $0.
  - `--budget` wired into `sweech auto`, `sweech launch`, `sweech cost`. Strict numeric parsing (`Number()`, not `parseFloat`) — rejects `nope`, `0abc`, `-0.5`.
  - 132 tests across `tests/costs.test.ts`, `tests/budgetRouter.test.ts`, `tests/costCommand.test.ts`.

- **T-LU-008** — `sweech profile audit` (`6ae65c2`)
  - `src/profileAudit.ts` — five finding kinds: `dormant`, `cross_bleed`, `orphan_credentials`, `missing_settings`, `expired_token`.
  - Dormancy walks profile dirs (sessions/, projects/, history.jsonl, state_*.sqlite, logs_*.sqlite) bounded to depth 4. Only file mtimes count; directory mtimes are ignored.
  - Cross-bleed via key-prefix heuristics (`sk-ant-`, `sk-`, `ms-`, `mse_`, `gsk_`, `AIzaSy`, `nvapi-`) + best-effort JWT issuer claim decode.
  - `--prune` is interactive y/N per-profile; `--prune --yes` is bulk, gated by one TTY confirmation, refused entirely in non-TTY.
  - Writes `profile_removed` audit-log entries on every successful prune (interactive + bulk).
  - 80 tests in `tests/profileAudit.test.ts`.

- **T-LU-009** — Project-aware routing via `.sweech.json` (`6ffb111` + pin-forwarding fix in `52b12fc`)
  - `src/projectConfig.ts` walks upward from cwd to `$HOME`, never above. `findProjectPin()` returns `{pin, source, projectRoot}`. Malformed JSON → null + one-line stderr warning.
  - Pin schema: `{profile, cliType, maxTier, model, budget}`. Unknown keys tolerated (logged once).
  - `recommendRoute` and `suggestBestAccount` accept optional 3rd `projectPin` arg. Pin's `cliType`/`profile` merge into the request; `maxTier` tags candidates with `pin-max-tier-exceeded:<tier>` rejection reason.
  - `routeWithinBudget` ALSO accepts `projectPin` (post-review fix). Without this, `sweech auto --budget` silently dropped the pin's maxTier.
  - `sweech pin show|set|unset|--json` command. Writes `./.sweech.json` (or `--dir`).
  - `sweech doctor` "Project pin" row.
  - `route_pin_applied` audit-log entry only when pin actually shaped outcome (directed selection, narrowed cliType, or capped tier — comment now matches behavior).
  - 68 tests across `tests/projectConfig.test.ts`, `tests/pinCommand.test.ts`, `tests/accountSelector.test.ts` (pin integration), `tests/budgetRouter.test.ts` (pin forwarding).

### Review round 1 — 3 parallel Claude sub-agents (`52b12fc`)

- **code-reviewer**: 3 HIGH (budget+pin maxTier bypass, unvalidated `--cli` cast, `--force` budget bypass on unpriced model) + 4 MEDIUM. All fixed.
- **security-reviewer**: 2 LOW (commandName path-traversal in `--prune --yes`, missing audit log on prune). Both fixed — `getProfileDir` now validates `[A-Za-z0-9_-]+`, prune writes `profile_removed` entries.
- **integration-audit**: 2 HIGH (`auto --budget` discards 3/4 pin fields, prune missing audit log) + 4 MEDIUM (`filterCandidatesByBudget` dead API docstring, top-level help banner stale, SWEECH_GUIDE.md missing wave docs, failover scope-narrowness undocumented) + 6 LOW. All HIGH/MEDIUM fixed except `filterCandidatesByBudget` (kept as routing-aware utility for external callers; docstring rewritten to be honest).

### Review round 2 — codex adversarial via `codex review --base fb54763` (`a1a5952`)

Codex (gpt-5.4 via codex-pole profile) caught 2 P2 findings that all three Claude reviewers missed:

1. **`parseFloat('nope')` silently bypassed `--budget` guard.** NaN failed the `Number.isFinite` check in the action handler, which then skipped the budget block entirely → launch proceeded with no enforcement. `parseFloat('0abc')` also returned 0 (literal). Fixed: replaced `parseFloat` with `parseBudgetUsd` (uses strict `Number()`, exits 1 on NaN / negative).
2. **`sweech cost` 7d column always reported $0.** No caller emits `token_usage` audit events; normal launches go to `~/.sweech/launches.log` via `logLaunch`. Fixed: `computeSpend7d` now reads BOTH sources, dedups by minute to avoid double-counting, requires `defaultModel` in the profile descriptor to project.

## Test state

- **78 suites / 2097 tests, all green** (up from 71/1775 at session start: +7 suites, +322 tests)
- `npx tsc --noEmit` returns 0 errors
- Full suite runs in ~10 seconds

## Current state

- Branch: `main`
- Latest commit: `a1a5952 fix(wave-T-LU): address codex adversarial review — budget validation + real 7d spend`
- Origin: up to date — every commit pushed
- Uncommitted changes: **none** (working tree clean except pre-existing `packages/engine/bun.lock` + screenshot dirs)
- Worktrees: only the canonical main worktree (4 agent worktrees cleaned up after merge)
- Keel: 0 active, 0 blocked, 62 done, 0 todo

## E2E proof

Smoke output + screenshot at `~/Desktop/screenshots/sweech/`:
- `smoke-20260517-153908.txt` — initial wave smoke (every new command help + JSON shape + table)
- `smoke-post-review-20260517-161516.txt` — post-review smoke (budget validation rejects, 7d spend shows real data, --cli bogus rejected, launchd still working)
- `wave-T-LU-005-007-008-009-20260517-154028.png` — full-screen visual proof
- `wave-T-LU-final-20260517-161532.png` — post-review final state

Live measurements (from the smoke run):
- `sweech auto --budget 0.05 --json` → picks `claude-pole` ($0.0375/call < budget)
- `sweech auto --budget nope` → "Invalid --budget" + exit 1
- `sweech auto --cli bogus` → "Invalid --cli for auto: must be claude, codex, kimi" + exit 1
- `sweech cost` → real 7d spend visible: `claude-pole: $0.6750`, `codex-pole: $1.09` (from this very session's codex review!)
- `sweech serve --status` → "ai.sweech.serve: running (pid 81054)" + exit 0
- `sweech pin set/show/unset` cycle reversible, JSON shape stable

## Decisions made (do not re-litigate)

- **Failover is intentionally pin/budget unaware.** The pinned profile is the one that just hit limits; honoring pin would re-select it. Caller composes pin+budget via `sweech auto`, not `sweech failover`. Documented in `src/failover.ts:pickFailoverTarget` JSDoc.
- **`--force` only bypasses reachability, never budget.** Documented: a silent budget skip when pricing data is missing defeats the whole point of `--budget`. Refuses with exit 1 + hint to fix pricing.json or drop `--budget`.
- **Pin is forwarded into `routeWithinBudget` but NOT into `failover.pickFailoverTarget` or `fedServer /fed/route-recommendation`.** First is correct (pin shapes budget routing); second is correct (failover is escape-hatch); third is correct (server has no client cwd context). Each has a comment explaining the choice.
- **`profile audit --prune` requires explicit `--yes` in non-TTY contexts.** Refuses with exit 1 otherwise. Prevents shell-pipe destruction.
- **`route_pin_applied` audit log only fires when pin actually shaped the outcome.** Three signals checked: pin directed selected profile, pin narrowed cliType, pin capped tier (≥1 candidate hit pin-max-tier-exceeded). Previous "logs when changed outcome" comment was a lie; now matches.
- **Spend dedup by minute bucket.** When both `token_usage` and `launches.log` emit for the same call, the launch entry is skipped if a `token_usage` entry exists in the same minute. Prefers exact source over estimate.
- **Default token budget for spend estimation is 5000 in / 1500 out** — matches `routeWithinBudget` defaults and the `sweech cost --est-input/--est-output` flag defaults. Single source of truth.
- **`getProfileDir` validates `commandName` as `[A-Za-z0-9_-]+`.** Defense-in-depth against poisoned `config.json` entries that could let `--prune --yes` wipe sibling dirs via `..` escape.

## Still on the keel queue

**Empty.** All 4 MEDIUM tasks from the prior handoff (T-LU-005/007/008/009) are done. No active, no blocked, no todo.

## Open follow-ups (not blocking ship)

- **Emit `token_usage` audit events from launch paths** so `sweech cost` 7d spend becomes exact instead of estimated. Currently estimated-from-launches.log is shipping but exact would beat estimate. Could be tackled as T-LU-010 if/when token telemetry is available from the launched CLI.
- **CLI integration smoke tests (`spawnSync('node', ['dist/cli.js', ...])`)**: every new command (auto, cost, pin, profile audit, serve --status) has unit tests for its builder functions but no test that exercises the action handler via the built CLI. Integration audit flagged as LOW; consider a thin smoke test file if surface keeps growing.
- **`sweech list --budget`**: integration audit suggested filtering the workspace list by budget. Out of scope for this wave; could be added.
- **MODEL_PRICING / formatUsd / formatUsdCompact in src/costs.ts**: tested but not used in production. Kept as utility exports. Delete if confirmed unused in 90 days.

## Key files (new this session)

- `src/costs.ts` — pricing table + estimateCostUsd + ~/.sweech/pricing.json override. 30+ models.
- `src/budgetRouter.ts` — routeWithinBudget API + filterCandidatesByBudget helper.
- `src/costCommand.ts` — sweech cost builders. Reads token_usage + launches.log for 7d spend.
- `src/profileAudit.ts` — dormancy + cross-bleed + orphan-cred analysis engine.
- `src/projectConfig.ts` — .sweech.json upward walker + writer + validator.
- `tests/launchd.test.ts` — 27 tests, was zero.
- `tests/profileAudit.test.ts` — 80 tests covering all finding kinds.
- `tests/projectConfig.test.ts` + `tests/pinCommand.test.ts` — 64 tests for pin lifecycle.

## Watch out for

- **`parseCliType()` returns `undefined` / `null` / CLIType** — three states, not two. `undefined` = no flag, `null` = invalid, otherwise = narrowed. `requireValidCli()` is the friendly wrapper that exits on `null`.
- **`computeSpend7d` needs `defaultModel` in the profile descriptor** to estimate launches.log entries. Callers that only pass `commandName` get $0 for launches that have no `token_usage` event. `buildCostTable` and `buildProfileDetail` already fill it in via ConfigManager+getProvider; new callers must too.
- **`accountSelector.recommendRoute` and `suggestBestAccount` are 3-arg now** — but the 3rd is optional. Existing 2-arg callers compile unchanged.
- **`routeWithinBudget` second arg WAS `profiles`** in budgetRouter's call to recommendRoute; it's now `undefined` because we pass `projectPin` as the 3rd. If you ever need to scope to a profile subset in the budget path, pass it as the 2nd arg.
- **Cost --json schema is `sweech.cost-table.v1` / `sweech.cost-detail.v1`** — bump if you change the shape. Downstream parsers (codeuctor, sweech-bar) will rely on this.
- **Pin write path validates commandName via `getProfileDir` first** — invalid commandName in `.sweech.json.profile` falls through to default ranking with a stderr warning rather than crashing.

## Adversarial review pattern, codified

The "two pairs of eyes, different brains" approach this session validates the wave's quality. Use it for future waves:

1. Build features in parallel via 4 isolated agent worktrees.
2. Merge in deliberate order (no signature-changing branch last).
3. Run 3 reviewers in parallel from the SAME message: code-reviewer + security-reviewer + integration-audit (general-purpose with a focused brief).
4. Fix HIGH + MEDIUM in one batch commit.
5. Run codex adversarial: `CODEX_HOME="$HOME/.codex-pole" codex review --base <pre-wave-commit>`. This is the load-bearing step — same-family reviewers shared blind spots; gpt-5.4 caught the budget-NaN bypass and the launches.log gap.
6. Fix codex findings, push.

This session: 4 HIGH + 2 P2 + 6 MEDIUM + 8 LOW caught and fixed across 5 commits. No "ship it broken and fix later" tradeoffs taken.

## Next steps

Backlog is clear. Suggested directions if more work is wanted:
- Add `token_usage` audit emission from the launch paths to make 7d spend exact (T-LU-010 candidate).
- Wire `--budget` into `sweech list` for completeness.
- Surface `sweech cost` + `sweech pin` data in SweechBar (currently CLI-only).
- The `filterCandidatesByBudget` helper has 4 tests + no caller — either build a caller for it or delete.
