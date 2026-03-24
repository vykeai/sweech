# Autonomous Execution — sweech
<!-- hash: ae-sweech-v1-20260324 -->

## Execution Loop

```
1. Read ONE_OFF.md (if exists) → execute one-off tasks first
2. keel tasks --status ready → pick highest priority in active wave
3. keel task update <id> --status active --assignee claude
4. Read task spec, identify files, acceptance criteria
5. Implement end-to-end
6. Run quality gates (see below)
7. Commit with conventional message
8. keel task update <id> --status done
9. keel note add <id> with summary
10. Repeat from step 2
```

## Quality Gates

Every task MUST pass ALL gates before marking done:

| # | Gate | Command / Action |
|---|------|-----------------|
| 1 | Build | `npm run build` — zero errors |
| 2 | Tests | `npm test` — all pass, new tests for new code |
| 3 | Type Check | `npx tsc --noEmit` — zero errors |
| 4 | SweechBar Build | `cd macos-menubar/SweechBar && swift build` |
| 5 | Self-Review | `/review-self` — no obvious issues in diff |
| 6 | Security | No hardcoded secrets, no injection vectors |
| 7 | Parity | CLI, launcher, and SweechBar must stay in sync |
| 8 | Keel Writeback | Update task status + add note with summary |

## Commit Convention

```
feat: description     — new feature
fix: description      — bug fix
refactor: description — restructure without behavior change
test: description     — test only
docs: description     — documentation
chore: description    — maintenance
```

## Architecture Rules

- CLI is infrastructure — avoid coupling to one product/workflow
- Command names, flags, and output formats are public contracts
- Changes to public contracts need coordinated downstream updates
- Exit codes: 0 = success, non-zero = failure
- Errors to stderr, output to stdout
- `--help` and `--version` must work without side effects

## Scope Discipline

- Only implement what the task specifies
- Don't refactor surrounding code unless the task says to
- Don't add features beyond acceptance criteria
- If blocked, set task to blocked + add note, move to next

## Error Recovery

- Build fails → fix the build error, don't skip
- Test fails → fix the test or the code, don't delete the test
- If stuck for more than 10 minutes → mark blocked, document why, move on

## File Ownership

| Space | Files |
|-------|-------|
| space-cli | src/*.ts, dist/*.js |
| space-menubar | macos-menubar/** |
| space-api | src/fedServer.ts, src/fedClient.ts |
| space-infra | tests/**, .github/**, package.json |

## Parity Contract

These three surfaces MUST have feature parity (per memory/feedback_cli_menubar_parity.md):
- `sweech usage` (CLI)
- `sweech` launcher (TUI)
- SweechBar (macOS menu bar)

When adding a feature to one, add it to all three in the same task.
