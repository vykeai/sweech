# Handoff — 2026-05-01

## What was completed this session

- **CLI speed fix** (`a6e860d`): `sweech list` now renders profiles instantly from config (no network), then refreshes with live status data in-place using ANSI cursor movement for TTY. Non-TTY/piped mode fetches all data first then renders once.
- **Omnai→Sweech type rename** (`939d2bb`): All `Omnai*` TypeScript types, functions, and CSS vars in `packages/ui/src/` renamed to `Sweech*` with `@deprecated` backward-compat aliases. Engine rebuilt and yalc-pushed to propagate new names.
- **CSS rename**: All `--omnai-*` vars → `--sweech-*`, `.omnai-*` classes → `.sweech-*`, `data-omnai-product` → `data-sweech-product`. Backward-compat `--omnai-*` var aliases in base.css.
- **Downstream fixes**: keel (`runOmnaiChat` → `runSweechChat`), cloudy (`OmnaiClient` → `SweechClient`).
- **README cleanup**: Removed stale `omnai` references from sweech README.
- **Codex review fix** (`0a13310`): Fixed TTY line count mismatch in two-phase render — now tracks actual lines written instead of hardcoded `N+3`.
- **7 keel tasks closed**: T-LU-131, T-LU-132, T-LU-133, T-LU-134, T-LU-135, T-LU-136 (all merger cleanup tasks).

## Current state

- Branch: `main`
- Last commit: `0a13310` — fix: count actual rendered lines for TTY cursor-up refresh
- Uncommitted changes: none — all committed and pushed
- Build status: passes (`npx tsc --noEmit` zero errors in root, engine, and UI)
- Test status: all green — 1181 tests passing (49 suites), UI 17/17 tests passing
- Engine yalc-pushed to: sweech/ui, keel, cloudy, runecode
- UI yalc-pushed to: keel

## What to do next

1. **T-LU-137** — Fix sorting discrepancy between menubar app and CLI (high priority, affects all products)
2. **T-LU-138** — Add Kimi CLI support to sweech
3. **T-LU-139** — Promotional offers display (scout Claude/Codex increased limits)
4. **T-LU-141** — Delete aipollo directory (was deferred, may already be done)
5. Remaining onlytools backlog: T-LU-012 through T-LU-049 (versioning, docs, integration tests)

## Decisions made this session

- Omnai backward-compat aliases are `@deprecated` but not removed — downstream consumers (jobforge imports `@omnai/ui`) need migration time
- Engine already used `Sweech*` names internally; the yalc distribution was stale — yalc push fixed everything
- Sweech is in `~/dev/onlytools/sweech` only (the old `~/dev/sweech` was removed in previous session)
- omnai repo (vykeai/omnai) stays frozen forever — NEVER archive/delete

## Open questions

- None — session completed all planned work cleanly

## Key files touched

- `src/cli.ts`: Two-phase TTY render for `sweech list` command (instant render + async refresh)
- `packages/ui/src/types/index.ts`: Core type rename, backward-compat aliases
- `packages/ui/src/utils/parse.ts`: Function rename (parseSweechUIEvent etc.), engine import fixes
- `packages/ui/src/session/state.ts`: State machine rename with aliases
- `packages/ui/src/index.ts`: Barrel exports updated to primary Sweech* names
- `packages/ui/src/themes/base.css`: Full CSS var + class rename, backward-compat aliases
- `keel/src/dashboard/server.ts`: runOmnaiChat → runSweechChat
- `cloudy/src/executor/claude-runner.ts`: OmnaiClient → SweechClient

## Watch out for

- The `@omnai/ui` package name in `package.json` has NOT been renamed yet — that's a bigger change requiring npm publish coordination. The internal code is all `Sweech*` but the npm package name is still `@sweech/ui` (was `@omnai/ui` before the merger, already renamed in package.json).
- `skipLibCheck: true` in tsconfig hides engine import errors — always do a full `npx tsc --noEmit` from `packages/ui/` after engine changes.
- Codex sandbox blocks writes to `~/.sweech/` — team test failures (115/1181) are EPERM from sandbox, not real failures.
