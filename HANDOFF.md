# Handoff — 2026-05-17 (wave T-LU-010 CRUD + polish)

## What was completed this session

The full **workspace + account CRUD wave (T-LU-010)** shipped across 4 layers
(CLI, daemon, SweechBar, tests) and survived a 4-reviewer pass (Claude code +
security + integration + codex adversarial). Then a follow-up polish pass
landed the deferred items.

### CRUD wave commits on `origin/main`

| commit  | what                                                              |
|---------|-------------------------------------------------------------------|
| `c19a97d` | workspace CRUD (disable/enable/hide/unhide/delete/edit + --keep-data) |
| `346bb78` | account CRUD (hide/unhide/logout/delete/edit) + skip-from-refresh |
| `cb81ee0` | SweechBar right-click context menus + hidden section + JSON wiring|
| `9ee2189` | review-round-1 fixes (codex P2.1/P2.2/P2.3 + security M2/M3)      |
| *(this commit)* | polish: accessibility, tests, **vault test-isolation incident fix** |

### Polish-pass detail (this commit)

1. **SweechBar accessibility** — inactive tiles now dim by reducing background
   opacity (0.85 → 0.45) + `.saturation(0.4)`, instead of `.opacity(0.55)` on
   the whole tile. The prior approach crushed 9pt badge text below the WCAG
   4.5:1 contrast floor in Light mode.

2. **New CRUD tests**:
   - `tests/workspaceCrud.test.ts`: 4 added (now 22 total) covering
     `--keep-data` settings.json credential scrub (security M1 regression),
     `--keep-data + --force-dependents` sibling-binding combination, and a
     stronger ambiguity-message assertion.
   - `tests/cli-accounts-crud-errors.test.ts`: NEW spawn-based E2E suite
     verifying the `--json` error envelope on hide/delete/logout when the
     target account doesn't exist + the `--email required` stderr path.

3. **CRITICAL test-isolation incident (caught + fixed)**:
   While adding tests this session I discovered the test suite had been
   silently writing to the developer's REAL `~/.sweech/accounts.json`. Two
   stacked bugs:

   - `vault.ts` imported `'node:os'` (prefixed) but the jest mock targeted
     `'os'` (unprefixed). They're DIFFERENT module specifiers to jest, so
     vault never saw the mocked homedir.
   - Even after mocking both forms, `vault.ts` captured `SWEECH_DIR` and
     `ACCOUNTS_FILE` as MODULE-LEVEL `const`s at import time (line 119-120).
     `jest.mock` hoists above imports but `__mockHome` is null until
     `beforeEach` runs — so the consts captured the real homedir
     irrecoverably.

   Fixes landed:
   - `vault.ts` now resolves `sweechDir()` / `accountsFile()` / `lockFile()`
     lazily as functions. Cost is one path.join per call; safety is real.
   - `tests/{accountCrud,workspaceCrud}.test.ts` mock BOTH `'os'` and
     `'node:os'` with a shared `var __mockHome` (jest.mock factories are
     hoisted above let/const).
   - Cleanup: stripped 5 polluted entries from the real `~/.sweech/accounts.json`
     (saved a `.pre-cleanup-*.bak` next to it just in case).

   This was the same class of bug we hit at the start of the CRUD wave; the
   first occurrence got a partial fix (mock `'os'` only) that masked the
   bigger problem (module-load capture in vault.ts). Both gaps now closed.

### CRUD surface — what the user got

CLI:
- `sweech workspace {disable,enable,hide,unhide,delete,edit} <name>`
  with `--keep-data` / `--force-dependents` / `--model` / `--base-url` / `--env KEY=VAL`
- `sweech accounts {hide,unhide,logout,delete,edit} --email <email-or-id>`
  with `--keep-workspace-markers` / `--display-name` / `--plan` / `--rate-limit-tier`

Daemon:
- Disabled+hidden workspaces drop out of `tokenRefresh`, `auto`, `failover`,
  and the live-usage poll. The `[sweech] token refresh failed for .claude-ted`
  noise on cancelled subscriptions is gone.
- `sweech usage --json` (the path SweechBar consumes) opts into
  `includeInactive: true` so the Hidden section gets data.

SweechBar:
- Right-click context menu on every workspace tile (Disable / Enable /
  Hide / Unhide / Delete (keep data) / Delete (remove data dir)).
- Right-click context menu on every OAuth account tile (Hide / Unhide /
  Logout / Delete account (keep workspace data)).
- Hidden / disabled tiles dim by background + saturation (legible text).
- Account CRUD calls pass the 12-char vault id, not the email — disambiguates
  duplicate-email accounts across orgs.

## Test state

- **82 suites / 2168 tests, all green** (+1 suite, +10 tests vs CRUD-wave-baseline)
- `npx tsc --noEmit` clean
- Real vault NOT polluted; cleanup verified empty
- SweechBar dev build clean (deprecation warnings on `onChange(of:perform:)`
  are pre-existing across the codebase and tracked separately)

## Decisions made (do not re-litigate)

- **`--keep-data` scrubs `env` and `oauth` blocks from settings.json before
  preserving the dir.** A user keeping the conversation history doesn't want
  to keep the bearer token in plaintext on disk. Hooks, model overrides, and
  other non-secret keys are preserved so the dir stays re-attachable.
- **`accountCrud.deleteAccount` removes account row + secret FIRST, then
  clears workspace markers.** Prior order left orphan markers on writeMeta
  failure. New order leaves a consistent retryable state.
- **`logoutAccount` keychain delete failures log to stderr rather than throw.**
  Marker clearing + status flip remain independently useful even when the
  user cancels a keychain prompt.
- **SweechBar inactive-tile dimming uses `.background(opacity(0.45)) +
  .saturation(0.4)` instead of `.opacity(0.55)` on the whole tile.** The
  former preserves WCAG contrast on 9pt badge text in Light mode.
- **Federation endpoints `/fed/*` continue to filter disabled+hidden
  workspaces.** They're for other dashboards (claudefin, vykey) — the user
  explicitly marking a workspace hidden means "don't surface in dashboards".
  SweechBar reads via `sweech usage --json` shell-out, which opts into
  inactive visibility; that's the only consumer that needs them.
- **Legacy `sweech accounts remove` retained** (deprecated, doesn't clean
  markers). The new canonical path is `sweech accounts delete`. CI scripts
  using the old verb keep working.
- **`vault.ts` paths now lazy** — module-level const-capture of homedir
  caused tests to silently write to the real vault. Functions cost a
  `path.join()` per call; the safety is worth it. ConfigManager already
  resolves homedir in its constructor (per-instance) so it's fine.

## Still on the keel queue

- **T-061** Sparkle auto-update for SweechBar (low priority, needs appcast
  hosting decision).
- **T-062** Multi-machine vault sync (low priority, needs transport decision —
  iCloud / S3 / git remote).
- **T-071, T-073, T-074** deferred from earlier (kept that way).

Both T-061 and T-062 require user input (infrastructure choices) before they
can be picked up safely.

## What to do next session

1. If user asks "is CRUD done?" → yes, fully shipped, see commits above.
2. If user wants to pick up T-061 (Sparkle): need a decision on where to
   host the appcast.xml (GitHub Pages from the sweech repo is the cheap
   default). Sparkle SPM dep + Info.plist key + a signing keychain.
3. If user wants to pick up T-062 (sync): need transport choice. iCloud
   Drive is zero-config but Mac-only; S3 is universal but needs creds;
   git remote works for power users.

## File map for spot-checks

- CRUD primitives: `src/workspaceCrud.ts`, `src/accountCrud.ts`
- CLI surface: `src/cli.ts` (search `'workspace [action]'` + `'accounts [action]'`)
- Refresh skip: `src/subscriptions.ts:getKnownAccounts`, `src/tokenRefresh.ts:222`
- Vault round-trip: `src/vault.ts:sweechDir/accountsFile/readMeta/writeMeta/listAccountsV2`
- SweechBar wiring: `macos-menubar/SweechBar/Sources/SweechAPI.swift:1021-1108`
- Context menus: `macos-menubar/SweechBar/Sources/VaultView.swift:573-595, 1141-1162`
- CRUD tests: `tests/workspaceCrud.test.ts`, `tests/accountCrud.test.ts`,
  `tests/cli-accounts-crud-errors.test.ts`
