# Sweech in 60 Seconds

For humans **and** agents working in repos that route through `sweech`. The full reference is in `README.md` (~900 lines); this file is the load-bearing summary.

---

## Mental model

```
                   ┌──────────────────────────┐
   ┌── Anthropic ──┤  vault account  ─────────┤── mounted into ──▶  workspace ~/.claude-pole
   │               └──────────────────────────┘                     workspace ~/.claude-luke
   │  one identity,                                                 …more workspaces…
   │  many workspaces
   │
   ├── OpenAI ─────┤  vault account  ─────────┤── mounted into ──▶  workspace ~/.codex
   │
   └── API-key providers (Kimi, GLM, MiniMax, Groq, NVIDIA, OpenRouter, …)
       one API key, lives on a per-workspace basis only
```

**Account** = an OAuth identity (Anthropic, OpenAI) stored in the vault at `~/.sweech/accounts.json` with the secret in macOS Keychain.
**Workspace** = a `~/.<commandName>/` directory (e.g. `~/.claude-pole`, `~/.codex-ted`). Each workspace can have *one* account mounted at a time, but a single account can be mounted into *many* workspaces simultaneously — that's the whole point.
**Provider** = the upstream vendor. For OAuth-backed workspaces that's anthropic/openai. For API-key workspaces it's kimi-coding / glm / minimax / etc., declared in `~/.sweech/config.json`.

Files that matter:
| Path | What |
|---|---|
| `~/.sweech/config.json` | Array of every workspace profile (cli, provider, baseUrl, model). Single source of truth. |
| `~/.sweech/accounts.json` | Vault metadata (no secrets) — list of OAuth identities. |
| Keychain service `sweech-api-key` | Per-workspace API keys (third-party providers). |
| Keychain service `sweech-vault-<kind>-<id>` | OAuth secrets (anthropic / openai). |
| `~/.<workspace>/.sweech-account` | Text file holding the mounted account id. |
| `~/.<workspace>/auth.json` (codex) or keychain `Claude Code-credentials[-<hash>]` (claude) | Live credentials the CLI reads. |

---

## Commands every human runs

```bash
sweech                      # interactive launcher TUI (default action)
sweech list                  # every workspace, status, plan, mounted email
sweech use <workspace>       # spawn the CLI in that workspace's env
sweech resume <workspace>    # open the CLI's prior-session picker
sweech compare a b           # side-by-side usage / plan / smart-score for two profiles
```

## Commands every agent runs

```bash
sweech code-review                       # picks the best codex profile with quota and prints
                                          # the launch command. --exec to spawn codex directly.
sweech code-review --json                # machine-readable: { profile, account, utilization5h, … }
sweech check <workspace>                 # one-shot reachability probe (model, latency)
sweech check --all --json                # bulk reachability for every workspace
sweech usage --json                      # full payload — every workspace, bars, vault, provider quotas
sweech providers quota                    # third-party balance / rate-limit table
sweech providers quota --refresh --json   # force a fresh probe of every API-key vendor
```

For routing decisions in scripts: parse `sweech usage --json` for the `accounts[]` array. Each entry has:
- `commandName`, `cliType`, `provider`, `baseUrl`, `effectiveProvider`, `displayGroup`
- `live.buckets[0].session.utilization`, `live.buckets[0].weekly.utilization`, `live.status` (`allowed` | `warning` | `limit_reached` | `org_disabled`)
- `smartScore`, `tier` (`use_first` | `use_next` | `normal`), `tierUrgent`
- `activeAccount.{id,kind,email,plan}` — vault identity mounted in this workspace
- `tokenStatus` (`valid` | `refreshed` | `expired` | `no_token`)

`providerQuotas[providerKey]` contains `balanceUsd` / `rateLimit.{used,limit,units,resetsAt}` / `note` (dashboard hint) / `error` per third-party vendor.

---

## JSON contract — `live` shape (QuotaSnapshot)

Canonical shape of the `live` field on every account in `sweech usage --json` and `sweech list --json`. Single source of truth — SwiftBar, widgets, the engine, and external scripts all consume this.

```jsonc
{
  "live": {
    // Per-limit buckets. buckets[0] is always the "All models" / primary limit.
    // Additional buckets exist for per-model caps (e.g. "Sonnet only", "GPT-5.3-Codex-Spark").
    "buckets": [
      {
        "label": "All models",
        "session": { "utilization": 0.32, "resetsAt": 1714912800 },  // 5h rolling, Unix seconds
        "weekly":  { "utilization": 0.71, "resetsAt": 1715392200 }   // 7d rolling, Unix seconds
      }
    ],
    "status": "allowed",            // allowed | warning | limit_reached | org_disabled | forbidden | unauthorized
    "planType": "max",              // codex only — pro | max | business | enterprise | edu
    "representativeClaim": "...",   // optional, anthropic header for the dominant window
    "isStale": false,               // true when cache was returned because fresh fetch failed
    "tokenStatus": "valid",         // valid | refreshed | expired | no_token
    "tokenRefreshedAt": 1714912800000,   // ms epoch, present only when refreshed
    "tokenExpiresAt":  1714998000000,    // ms epoch, when known
    "capturedAt":      1714912800000     // ms epoch
  }
}
```

Notes for consumers:
- `buckets[0].session` and `buckets[0].weekly` are each optional; missing means that window has no data (e.g. some Codex tiers return only a weekly window).
- `resetsAt` is Unix **seconds** (Anthropic API native unit). `capturedAt`, `tokenRefreshedAt`, and `tokenExpiresAt` are **milliseconds** (JS Date.now units).
- `utilization` is a fraction `0.0–1.0`, not a percent.
- The pre-T-057 mirror fields (`utilization5h`, `utilization7d`, `utilizationSonnet7d`, `reset5hAt`, `reset7dAt`) have been removed. Read from `buckets[0]` instead.

---

## Vault (account) operations

```bash
sweech accounts list                            # everything in the vault
sweech accounts import                           # discover OAuth tokens in existing workspaces and populate the vault
sweech accounts add --kind anthropic             # fresh PKCE login → new vault entry
sweech accounts remove --email <e>               # delete from vault + keychain
sweech accounts refresh                          # renew any OAuth token within 30 min of expiry; auto-remounts
sweech assign <workspace> [email]                # mount a vault account into a workspace.
                                                 # No email → interactive picker.
                                                 # Refuses cross-kind (anthropic→codex / openai→claude).
```

Compatibility: an **anthropic** account can only mount into a **claude** workspace; an **openai** account can only mount into a **codex** workspace. The CLI enforces this; no need to test.

---

## SweechBar (menubar app)

Lives in `macos-menubar/SweechBar/`. Two tabs:

**Accounts** — vault identities (grouped Anthropic / OpenAI) plus a Providers section with one tile per third-party API-key vendor. Each tile shows plan / expiry / mounted workspaces. Tap "Assign to workspace…" / "Add to workspace…" to mount.

**Workspaces** — every workspace as a tile with cli + plan + bars + active-account picker. Inline dropdown switches the mounted account without leaving the popover.

Background timer probes every third-party vendor + refreshes OAuth tokens every 10 minutes. Dashboard URLs are clickable (NSWorkspace.shared.open).

To rebuild after a TypeScript change to the CLI that affects JSON output: `cd macos-menubar && ./build-app.sh && cp -r SweechBar.app ~/Applications/`.

---

## Daemon (engine)

`sweech daemon start | stop | status`. HTTP API on `127.0.0.1:7801` (override with `SWEECH_PORT`):
- `GET /check?profile=<name>` — one-shot reachability probe
- `GET /check/all` — every profile
- `GET /healthz` — liveness

Source: `packages/engine/src/`. Reads the same `~/.sweech/config.json` as the CLI — single store, no syncing required.

---

## Troubleshooting checklist

| Symptom | Likely cause |
|---|---|
| `sweech check` says `no_profile` for every workspace | Old engine talking to a stale `profiles.json`. Update sweech (`12f4b7e` or later) and `sweech daemon stop && start`. |
| Workspace shows `OAuth disabled` plan | The mounted account got its OAuth revoked by the org (e.g. enterprise SSO change). Re-auth or assign a different account. |
| `sweech accounts list` shows `<name>@unknown.local` | Default `~/.claude` profile with no `.claude.json` oauthAccount block. Run `sweech accounts import` again — it probes Anthropic's profile endpoint to backfill the email. |
| Provider tile shows `no quota probed yet` | Run `sweech providers quota --refresh` once; cached for 5 min thereafter. |
| Background quota refresh not happening | SweechBar must be running; it ticks every 10 min. |
| Wrapper script in `~/.config/sweech/bin/` missing | Run `sweech update-wrappers`. |

---

## Adding a new third-party provider

1. Add the profile via `sweech profile` (or hand-edit `~/.sweech/config.json` — array of objects). Required keys: `name`, `commandName`, `cliType`, `provider`, `baseUrl`, `model`, and `keyInKeychain: true`.
2. Drop the API key into Keychain with service `sweech-api-key`, account `<commandName>`.
3. If the vendor exposes a usage endpoint, teach `src/providerQuotas.ts` how to probe it — otherwise add the dashboard URL to the `DASHBOARD_ONLY` map.
4. If the engine should be able to `check` the workspace, add the hostname to `packages/engine/src/check.ts::ALLOWED_PROVIDER_HOSTS`.
