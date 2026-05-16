# Handoff — 2026-05-16 /vy-go batch 2

## Shipped this session (5 wave-5 tasks + Phase 2 fixes + codex adversarial fix)

| ID | Title | Worktree commit | Final-main commit |
|---|---|---|---|
| T-040 | Engine hot-reloads `~/.sweech/config.json` | `10e4f0d` | `7b8d388` (merge) |
| T-042 | Suppress update banner when `--json` | `531cf63` | `95df9e8` (merge) |
| T-046 | Predictive burn-rate ETA — CLI + menubar | `669094a` (main) | — |
| T-050 | Token expiry countdown via formatExpiry helper | `7dbf5ce` | `fbdccfe` (merge) |
| T-051 | `sweech assign` preflights `which <cli>` | `015e00b` | `8c9ec3a` (merge) |
| — | Phase 2 review fixes (3 MUST-FIX + 3 MEDIUM) | `b93ba52` | + `325e0c2` cleanup |
| — | Codex adversarial fix — hot-reload resurrection race | `b49feb7` | — |

All 11 commits pushed to `origin/main`. Range: `4539aa9..b49feb7`.

## Parallelism

Four worktree agents ran simultaneously for T-040 / T-042 / T-050 / T-051; T-046 was authored sequentially on `main` because it touched the same `src/cli.ts` and `src/launcher.ts` regions the others were sharing. All worktrees merged back via `git merge --no-ff` with post-merge gates re-run on the final state. Worktrees cleaned at the end — `git worktree list` shows only the pre-existing `.worktrees/d-lint-consumer-leak-guard`.

## Gate status at push

- **TypeScript** (`npx tsc --noEmit`): root clean, engine clean
- **Root jest**: 1303 passing / 2 failing (baseline 1222/2 + **81 new tests** across the 5 tasks + review fixes)
  - +28 `expiryFormat` boundary tests
  - +20 `quotaProjection` (12 logic + 6 review fixes + 2 boundary fixes)
  - +19 `updateChecker` shouldSkipUpdateCheck + 1 cache-atomic-write fix
  - +10 `vaultAssign` preflight (happy / refused / forced)
  - Pre-existing failures unchanged: `launcherIntegration grouped mode`, `systemCommands validateCommandName`, `liveUsageCache.test.ts` TS compile error
- **Engine vitest**: 375 passing / 8 failing / 1 skipped (baseline 368/8/1, +7 new — 6 watcher tests + 1 race regression test)
- **SwiftBar**: `swift build` clean, `.app` reassembled and installed to `~/Applications/`
- **Visual proof**: SweechBar popover screenshot at `~/Desktop/screenshots/sweech/t046-bar-eta-visible.png` after seeding rising-rate samples for `claude-pole` (u7d=0.85, ETA=15min — verified CLI `usage --json` projection7d emitted `rateUtilPerMinute=0.00999, etaToFullMinutes=15.0, sampleCount=5`). User data restored from backup post-screenshot.

## Phase 2 review results

**Code review** (`code-reviewer` agent, 3 MUST-FIX — all addressed in `b93ba52`):
1. `computeProjection` saturated branch was returning `etaToFullMinutes: 0` while non-positive-rate returned `null` — JSON consumers checking `!== null` got inconsistent semantics. Now BOTH return `null` (one canonical "no projection" shape; the rate field signals WHY).
2. `formatEta(59.6)` rendered "60m" because `Math.round(59.6) === 60` then fell into the `< 60` branch. Added the same clamp pattern `expiryFormat` uses for the 59-minute and 23-hour boundaries.
3. `shouldSkipUpdateCheck` matched `'update'` anywhere in argv — a workspace literally named `update` (`sweech launch update`) would silently suppress the banner. Now `argv[2] === 'update'` (subcommand position only).

**Security review** (`security-reviewer` agent, 0 HIGH — 3 MEDIUM addressed in `b93ba52`):
- M-1: `readSamplesFile` accepted NaN/Infinity/out-of-range utilization → propagated as `"NaN m"` in launcher rendering. Added per-sample schema-validate (`Number.isFinite` + 0..1 range) + `slice(-MAX)` so a 1M-entry poisoned file can't DoS the render loop.
- M-2: `quota-samples.json` was written at default umask. Now `chmod 0o600` post-write to match `vaultAssign.ts` pattern.
- M-3: `update-check.json` was non-atomic `fs.writeFileSync`. Now `atomicWriteFileSync` + `chmod 0o600`. Also added `mockFs.renameSync` + `mockFs.chmodSync` assertions in the existing test.

**Integration audit** (`general-purpose` agent): **BLOCKERS: none. MEDIUM: none. Ship-ready.** Every new export wired to a real call site, every `appendSnapshot` paired with `recordProjectionSamples`, SwiftBar QuotaProjection model present + rendered, no `toLocaleString`/`expiresAt - Date.now()` math remains outside `expiryFormat.ts` (verified by grep).

**Codex adversarial** (`codex exec` against the diff, fresh session — 1 HIGH addressed in `b49feb7`):
- HIGH: stale-in-flight-load resurrection race in `profiles.ts`. An async `loadProfilesConfig()` reading the OLD config could finish AFTER `reloadProfilesConfig` swapped `cached` to the NEW config, and its `try` block's `cached = result` would clobber the fresh value back to stale — resurrecting a rotated/removed credential snapshot. Phase-2 fix (clearing `loadPromise` before swap) didn't cover this. Fixed with monotonic `configGeneration` counter: every async cache write captures the generation at entry, only commits if still matching at write time. +1 regression test that fails without the guard.

## Outstanding wave-5 backlog (12 tasks for next /vy-go)

### Critical (1)
- **T-041** — eliminate silent `catch {}` blocks across CLI (23 instances)

### High (4)
- **T-045** — `sweech proxy` fallback-routing reverse proxy *(depends on T-039 ✓)*
- **T-047** — usage history log `~/.sweech/usage-log.jsonl` + `sweech history` command
- **T-048** — auto vault backup on every mutation
- **T-049** — SweechBar reads from daemon HTTP (kill the subprocess fan-out) *(depends on T-039 ✓)*

### Medium (5)
- **T-052** — `sweech compare` gains `--json` + `--per-model`
- **T-053** — `sweech doctor` per-check timeouts + daemon health probe
- **T-054** — daemon log rotation
- **T-056** — centralise `DEFAULT_DAEMON_PORT` constant
- **T-057** — drop deprecated fields in `liveUsage.ts:57-65`

### Low (2)
- **T-061** — Sparkle auto-update for SweechBar *(depends on T-060 ✓)*
- **T-062** — multi-machine vault sync *(depends on T-048)*

### Deferred from review notes (carried from batch 1 + new)
- README docs for `~/.sweech/daemon.secret` (mode 0o600 lifecycle) + `SWEECH_ANTHROPIC_CLIENT_ID`
- CLI→engine integration test that boots `serve()` and signs through `buildAuthedHeaders` round-trip
- Memory-DoS protection: size cap before body-hash on signed routes
- CORS deny policy on daemon (defensive)
- `idFor()` separator collision hardening (length-prefixed or `\x1f`-separated)
- Stderr warning when `SWEECH_ANTHROPIC_CLIENT_ID` env override is in effect
- README docs for `~/.sweech/quota-samples.json` (purpose, retention, opt-out) — new
- README docs for `--force` semantics on `sweech assign` — new

## Suggested next /vy-go batch (4 parallel, file-disjoint)

| ID | Files (target) |
|---|---|
| T-052 `compare --json` | `src/cli.ts` (compare command region) |
| T-053 `doctor` timeouts | `src/doctor.ts`, `src/cli.ts` (doctor command region) |
| T-054 daemon log rotation | `packages/engine/src/daemon/log.ts` (likely new) |
| T-056 + T-057 constant + drop deprecated | `src/constants.ts` (new), `src/liveUsage.ts` |

Note: T-041 (silent catches) again touches many files — keep sequential or as a solo batch.

## Outstanding diagnostics

- 2 jest failures (baseline, untouched): `launcherIntegration grouped mode`, `systemCommands validateCommandName`. Pre-existing — not blocking but worth a triage task next batch.
- `liveUsageCache.test.ts` TS compile error: pre-existing, would clear with T-057.
- 8 engine vitest failures (baseline, untouched): not introduced by this session.
- `package-lock.json 0.2.0↔0.3.0` drift continues to be rewritten by a hook; deliberately not staged in any commit this batch.
- The pre-existing `chore/d-lint-consumer-leak-guard` worktree at `.worktrees/d-lint-consumer-leak-guard` is unchanged. A `chore/` commit accidentally staged it as a submodule (mode 160000) plus `packages/engine/bun.lock`; the immediate follow-up `325e0c2` removed both from the index. Worth a one-time cleanup if the lint branch is no longer needed.

## Files added / modified

**New modules** (3 in `src/`, watcher + helpers in `packages/engine/`):
- `src/quotaProjection.ts` (270 lines)
- `src/expiryFormat.ts` (88 lines)
- `src/updateChecker.ts:shouldSkipUpdateCheck` (added pure helper)
- `packages/engine/src/middleware/profiles.ts` (+216 / -31 — watcher + generation counter)

**New tests** (4 in `tests/`, 1 in `packages/engine/`):
- `tests/quotaProjection.test.ts` (303 lines, 23 tests)
- `tests/expiryFormat.test.ts` (170 lines, 28 tests)
- `tests/vaultAssign.test.ts` (323 lines, 10 tests)
- `tests/updateChecker.test.ts` (extended, +123 lines including 19 shouldSkipUpdateCheck tests)
- `packages/engine/src/__tests__/middleware/profiles-hot-reload.test.ts` (240 lines, 7 tests)

**Touched existing**:
- `src/cli.ts` (+70 / -10 — projection wiring, `--force` flag, expiry helper calls, update-banner suppression)
- `src/launcher.ts` (+42 / -8 — projection ETA pill, expiry helper calls, sample recording)
- `src/vaultAssign.ts` (+84 — preflight + `AssignOptions`)
- `src/vaultRefresh.ts` (+6 — pass `{ force: true }` from daemon remount)
- `macos-menubar/SweechBar/Sources/SweechAPI.swift` (+33 — `QuotaProjection` Codable + `bestProjectionEtaMinutes` / `projectionLabel`)
- `macos-menubar/SweechBar/Sources/AccountsView.swift` (+20 — ETA pill row in `AccountCard`)
- `packages/engine/src/daemon/index.ts` (+12 — watcher lifecycle on boot + shutdown)
- `packages/engine/src/middleware/index.ts` (+1 — export hot-reload symbols)
- `packages/engine/src/index.ts` (+2 — same)

Total: **~1900 LOC added, 19 files**.
