# omnai

`omnai` is the publishable core package for the workspace. It provides:

- `omnai run` for executing prompts through the selected engine
- `omnai which` and `omnai config` for routing and account inspection
- the daemon and HTTP APIs used by the higher-level tooling in this repo

## Install

```bash
npm install omnai
```

## What it depends on

The package is self-contained for normal OSS installs. If `@vykeai/fed` is
present at runtime, the daemon will emit Fed events and register itself.
Otherwise those integrations are skipped and the rest of the package continues
to work.

## Build

```bash
npm run build
npm test
```

## Notes

- The workspace root is not the published artifact.
- `packages/core` is the package you should document, test, and ship.
