/**
 * Account vault — central storage for OAuth identities, decoupled from
 * workspace (profile) directories.
 *
 * Model:
 *   Account  = identity (kind + email + optional orgId + tokens).
 *   Workspace = a profile directory (~/.claude*, ~/.codex*) with a CLI type.
 *   Assignment = which account is currently mounted into which workspace.
 *
 * Storage:
 *   ~/.sweech/accounts.json           — array of AccountMeta (no secrets)
 *   keychain `sweech-vault-<kind>-<id>` — JSON-encoded secret blob
 *   ~/.<workspace>/.sweech-account    — text file with the active account id
 *
 * Secrets are persisted via getCredentialStore() so the same code works on
 * macOS Keychain, Linux secret-tool, and Windows cmdkey + file fallback.
 *
 * Account ids are derived from kind + email and, when available, the
 * OAuth org id — see `idFor`. Older single-org vaults stored ids as
 * `sha256(kind:email)`; entries written before orgId support stay
 * stable and are upgraded in place the first time an OAuth import
 * surfaces their orgId.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { atomicWriteFileSync } from './atomicWrite'
import { getCredentialStore } from './credentialStore'

export type AccountKind = 'anthropic' | 'openai'
export type CliType = 'claude' | 'codex'

/**
 * Current accounts.json schema version. Bumped to 2 in wave-6 (T-070)
 * when the file gained discriminated entries for API-key and local
 * (no-auth) accounts alongside the original OAuth identities.
 */
export const CURRENT_SCHEMA_VERSION = 2

/** CLI types compatible with a given account kind. */
export function compatibleCliTypes(kind: AccountKind): CliType[] {
  return kind === 'anthropic' ? ['claude'] : ['codex']
}

/** Account kind compatible with a given CLI type. */
export function kindForCliType(cliType: string): AccountKind | null {
  if (cliType === 'claude') return 'anthropic'
  if (cliType === 'codex') return 'openai'
  return null
}

export interface AccountMeta {
  /** Stable id derived from kind + email (+ orgId when known) — used as the directory key. */
  id: string
  kind: AccountKind
  email: string
  displayName?: string
  /** Anthropic accountUuid (claude) or codex account_id. */
  externalId?: string
  /**
   * OAuth org/workspace identifier (Anthropic organization.uuid or
   * OpenAI account_id). When set, it disambiguates the same email
   * across multiple orgs so the vault doesn't silently overwrite
   * one with the other. Optional for legacy single-org entries.
   */
  orgId?: string
  /** Human-readable org name, surfaced in collision prompts. */
  orgName?: string
  /** "Max 20x", "Max 5x", "pro", "plus", etc. */
  plan?: string
  /** Anthropic only — rate-limit tier as stored in keychain. */
  rateLimitTier?: string
  addedAt: string             // ISO
  lastRefreshedAt?: string    // ISO
  /** When the access token expires (ms epoch). */
  expiresAt?: number
  /** Latest known status: 'ok' | 'expired' | 'org_disabled' | 'unauthorized'. */
  status?: 'ok' | 'expired' | 'org_disabled' | 'unauthorized' | 'unknown'
  /**
   * Lifecycle flag (T-LU-010 CRUD): when true the account sinks to a
   * "hidden" section at the bottom of `sweech accounts list`, is skipped
   * by `sweech auto` candidate enumeration, and the background refresh
   * daemon ignores it. The secret blob in the keychain is untouched —
   * use `sweech accounts logout` to drop credentials, or `delete` to
   * remove the row entirely.
   */
  hidden?: boolean
}

/** Anthropic OAuth blob — matches what Claude Code stores in its keychain entry. */
export interface AnthropicSecret {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
  rateLimitTier?: string
}

/** Codex auth.json shape (preserved verbatim so swap is byte-identical). */
export interface OpenAISecret {
  OPENAI_API_KEY?: string | null
  auth_mode?: string
  tokens?: {
    access_token: string
    refresh_token: string
    id_token: string
    account_id?: string
  }
  last_refresh?: string
  [key: string]: unknown
}

export type AccountSecret = AnthropicSecret | OpenAISecret

// ── Paths ────────────────────────────────────────────────────────────────────

const SWEECH_DIR = path.join(os.homedir(), '.sweech')
const ACCOUNTS_FILE = path.join(SWEECH_DIR, 'accounts.json')

/** Marker file inside a workspace pointing at the active account id. */
export function workspaceMarkerPath(workspaceCommandName: string): string {
  return path.join(os.homedir(), `.${workspaceCommandName}`, '.sweech-account')
}

// ── Id derivation ────────────────────────────────────────────────────────────

/**
 * Derive a stable account id from kind + email and (optionally) orgId.
 *
 * When `orgId` is provided the hash includes it, so the same email
 * imported from two different OAuth orgs gets two distinct vault
 * entries. When omitted, the legacy `kind:email` shape is preserved
 * — existing single-org vaults keep their IDs across upgrades and
 * never need to be re-imported.
 */
export function idFor(kind: AccountKind, email: string, orgId?: string): string {
  const base = `${kind}:${email.toLowerCase().trim()}`
  const normalized = orgId ? `${base}:${orgId.toLowerCase().trim()}` : base
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)
}

function keychainService(kind: AccountKind, id: string): string {
  return `sweech-vault-${kind}-${id}`
}

const KEYCHAIN_ACCOUNT = 'sweech-vault'

// ── V2 schema (T-070) ───────────────────────────────────────────────────────
//
// Wave-6 introduces a discriminated `Account` union so the vault can
// store API-key and local (no-auth) accounts alongside OAuth identities.
// On disk the new shape is:
//
//   { "schemaVersion": 2,
//     "accounts": [
//       { "kind": "oauth", "provider": "anthropic", ... },
//       { "kind": "apikey", "provider": "kimi", "keyRef": {...}, ... },
//       { "kind": "none", "provider": "ollama", ... }
//     ]
//   }
//
// The legacy callers in this file (`listAccounts`, `getAccount`,
// `saveAccount`, ...) keep operating on the OAuth-only `AccountMeta`
// shape — they read/write only the `kind:'oauth'` rows and never see
// the API-key / local rows. New callers (T-071+) use the v2 surface
// via `loadAccountsV2()` / `saveAccountsV2()`.
//

interface V2KeychainRef {
  service: string
  account: string
}

interface V2OAuthEntry {
  kind: 'oauth'
  /** Upstream provider ('anthropic' or 'openai'). */
  provider: 'anthropic' | 'openai'
  /** Stable id derived from kind + email (+ optional orgId). */
  id: string
  email: string
  displayName?: string
  externalId?: string
  orgId?: string
  orgName?: string
  plan?: string
  rateLimitTier?: string
  addedAt: string
  lastRefreshedAt?: string
  expiresAt?: number
  status?: 'ok' | 'expired' | 'org_disabled' | 'unauthorized' | 'unknown'
  /**
   * Reference to the OAuth refresh-token secret in keychain. The
   * sweech-vault-<accountKind>-<id> entry is the source of truth for
   * the live secret; this ref makes lookup non-magical for new code.
   */
  refreshTokenRef: V2KeychainRef
  /**
   * Legacy `kind: 'anthropic' | 'openai'`. The new v2 shape uses
   * `kind: 'oauth'` + a separate `accountKind` to disambiguate from
   * apikey/none entries. Existing code that reads `AccountMeta.kind`
   * sees this field unchanged via the legacy projection in `readMeta()`.
   */
  accountKind: AccountKind
}

interface V2ApiKeyEntry {
  kind: 'apikey'
  provider: string
  /** Stable id derived from `sha8(provider + ':' + commandName)`. */
  id: string
  /** Human-friendly label, optional. */
  label?: string
  addedAt: string
  /** Reference to the API-key secret in keychain. */
  keyRef: V2KeychainRef
}

interface V2NoAuthEntry {
  kind: 'none'
  provider: string
  id: string
  label?: string
  addedAt: string
}

type V2Entry = V2OAuthEntry | V2ApiKeyEntry | V2NoAuthEntry

interface V2VaultFile {
  schemaVersion: 2
  accounts: V2Entry[]
}

// ── Metadata I/O ─────────────────────────────────────────────────────────────

/** Internal: parse the on-disk file into the v2 shape, migrating if needed.
 *
 * Code-review + Security-review (HIGH): the previous implementation called
 * persistV2File from outside any lock when migration was needed. Two
 * concurrent sweech processes could both detect v1, both migrate, and race
 * to write — the second rename overwriting the first's entries.
 * Fix: pure v2 reads stay lock-free (hot path, no overhead); only the v1
 * migration write acquires the lock, then re-reads under the lock to
 * confirm we're still v1 (double-checked locking — another process may
 * have migrated in the gap). */
function readV2File(): V2VaultFile {
  const parsed = parseAccountsFile()
  if (parsed.kind === 'v2') return parsed.file
  if (parsed.kind === 'empty') return { schemaVersion: 2, accounts: [] }
  return withVaultLock(() => {
    const after = parseAccountsFile()
    if (after.kind === 'v2') return after.file
    if (after.kind === 'empty') return { schemaVersion: 2, accounts: [] }
    const migrated = migrateV1ToV2(after.v1Rows)
    persistV2File(migrated)
    return migrated
  })
}

type ParsedAccounts =
  | { kind: 'v2'; file: V2VaultFile }
  | { kind: 'v1'; v1Rows: AccountMeta[] }
  | { kind: 'empty' }

function parseAccountsFile(): ParsedAccounts {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'))
  } catch {
    return { kind: 'empty' }
  }
  if (Array.isArray(raw)) return { kind: 'v1', v1Rows: raw as AccountMeta[] }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 1
    if (version >= 2 && Array.isArray(obj.accounts)) {
      return { kind: 'v2', file: { schemaVersion: 2, accounts: obj.accounts as V2Entry[] } }
    }
    if (version === 1 && Array.isArray(obj.accounts)) {
      return { kind: 'v1', v1Rows: obj.accounts as AccountMeta[] }
    }
  }
  return { kind: 'empty' }
}

function persistV2File(file: V2VaultFile): void {
  fs.mkdirSync(SWEECH_DIR, { recursive: true, mode: 0o700 })
  atomicWriteFileSync(ACCOUNTS_FILE, JSON.stringify(file, null, 2))
  // Code-review (SHOULD-FIX): previously this swallowed the chmod error
  // silently — on weird filesystems (network home dirs, RO mounts post-write)
  // the vault could end up world-readable without any signal. Now we log
  // to stderr so a user / CI can see it happened.
  try {
    fs.chmodSync(ACCOUNTS_FILE, 0o600)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[sweech] WARN: chmod 0600 on ${ACCOUNTS_FILE} failed: ${msg}\n`)
  }
}

/**
 * Migrate a v1 bare-array `AccountMeta[]` to the v2 shape.
 *
 * Steps:
 *   - Wrap each OAuth row with `kind: 'oauth'`, copy `kind` into
 *     `accountKind`, derive a `refreshTokenRef` pointing at the
 *     existing `sweech-vault-<kind>-<id>` keychain entry.
 *   - Walk ConfigManager workspaces for non-OAuth providers (apikey
 *     or local) and emit one V2 entry per workspace, referencing the
 *     existing `sweech-api-key:<commandName>` entry.
 *   - Sort by `(provider, addedAt)` for stable diffs.
 *   - Append a one-line audit entry to `~/.sweech/audit.jsonl`.
 *
 * Idempotent: running on an already-v2 file produces the same output.
 */
export function migrateV1ToV2(legacy: AccountMeta[]): V2VaultFile {
  const accounts: V2Entry[] = []

  // ── 1. OAuth rows ──────────────────────────────────────────────────────────
  //
  // Codex (HIGH): the original migration trusted every v1 row, so a
  // corrupted/partial entry (missing `id`, wrong `kind` like 'unknown',
  // empty `email`) would produce invalid v2 rows with refs like
  // `sweech-vault-undefined-undefined`, then crash later callers that
  // assume non-null. Validate strictly here: require id + valid kind
  // (anthropic|openai) + non-empty email. Skip bad rows + audit.
  let oauthRetained = 0
  const oauthSkipped: { reason: string; row: Partial<AccountMeta> }[] = []
  for (const m of legacy) {
    const rawKind = (m as Partial<AccountMeta>).kind
    if (rawKind !== 'anthropic' && rawKind !== 'openai') {
      oauthSkipped.push({ reason: `unknown kind: ${JSON.stringify(rawKind)}`, row: m })
      continue
    }
    if (typeof m.id !== 'string' || m.id.length === 0) {
      oauthSkipped.push({ reason: 'missing or empty id', row: m })
      continue
    }
    if (typeof m.email !== 'string' || m.email.length === 0) {
      oauthSkipped.push({ reason: 'missing or empty email', row: m })
      continue
    }
    const accountKind = rawKind
    const provider: 'anthropic' | 'openai' = accountKind === 'anthropic' ? 'anthropic' : 'openai'
    accounts.push({
      kind: 'oauth',
      provider,
      id: m.id,
      email: m.email,
      displayName: m.displayName,
      externalId: m.externalId,
      orgId: m.orgId,
      orgName: m.orgName,
      plan: m.plan,
      rateLimitTier: m.rateLimitTier,
      addedAt: m.addedAt ?? new Date().toISOString(),
      lastRefreshedAt: m.lastRefreshedAt,
      expiresAt: m.expiresAt,
      status: m.status,
      accountKind,
      refreshTokenRef: {
        service: `sweech-vault-${accountKind}-${m.id}`,
        account: KEYCHAIN_ACCOUNT,
      },
    })
    oauthRetained++
  }

  // ── 2. API-key / local workspaces ──────────────────────────────────────────
  //
  // Lazy-required so vault.ts has no static dependency on config.ts
  // (avoids a load-order cycle when tests mock vault).
  let apikeyAdded = 0
  let noneAdded = 0
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ConfigManager } = require('./config') as typeof import('./config')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { effectiveProvider, PROVIDERS } = require('./providers') as typeof import('./providers')

    const cfg = new ConfigManager()
    const profiles = cfg.getProfiles()
    const seen = new Set<string>()
    for (const p of profiles) {
      const eff = effectiveProvider(p.provider, p.baseUrl) || p.provider
      // OAuth-backed providers are represented by their OAuth account
      // rows already; skip so we don't double-count.
      if (eff === 'anthropic' || eff === 'openai') continue
      const id = idForApiKey(eff, p.commandName)
      if (seen.has(id)) continue
      seen.add(id)

      // `authOptional` providers (Ollama local, etc.) are recorded
      // as `kind: 'none'`; everything else is `kind: 'apikey'`.
      const legacyProv = PROVIDERS[p.provider]
      const isLocal = !!legacyProv?.authOptional
        || eff === 'local-ollama'
        || eff === 'local-proxy'
        || eff === 'xortron'

      if (isLocal) {
        accounts.push({
          kind: 'none',
          provider: eff,
          id,
          label: p.commandName,
          addedAt: p.createdAt ?? new Date().toISOString(),
        })
        noneAdded++
      } else {
        accounts.push({
          kind: 'apikey',
          provider: eff,
          id,
          label: p.commandName,
          addedAt: p.createdAt ?? new Date().toISOString(),
          keyRef: {
            service: 'sweech-api-key',
            account: p.commandName,
          },
        })
        apikeyAdded++
      }
    }
  } catch {
    // ConfigManager unavailable (mocked-out tests, fresh install with
    // no config.json) — that's fine, we just emit zero apikey rows.
  }

  // ── 3. Deterministic sort: provider asc, then addedAt asc, then id asc.
  accounts.sort((a, b) => {
    const provCmp = a.provider.localeCompare(b.provider)
    if (provCmp !== 0) return provCmp
    const aAdded = a.addedAt ?? ''
    const bAdded = b.addedAt ?? ''
    if (aAdded !== bAdded) return aAdded.localeCompare(bAdded)
    return a.id.localeCompare(b.id)
  })

  // ── 4. Audit log line. Best-effort; never blocks the migration. ────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { logAudit } = require('./auditLog') as typeof import('./auditLog')
    logAudit({
      timestamp: new Date().toISOString(),
      action: 'vault_schema_migration',
      details: {
        fromVersion: 1,
        toVersion: 2,
        oauthRetained,
        oauthSkipped: oauthSkipped.length,
        oauthSkippedReasons: oauthSkipped.map(s => s.reason),
        apikeyAdded,
        noneAdded,
        note: 'wave-6 T-070 — Provider/Account/Workspace unification',
      },
    })
  } catch { /* audit log unavailable */ }

  return { schemaVersion: 2, accounts }
}

/** sha8(provider:commandName) — kept in sync with providerModel.accountIdForApiKey. */
function idForApiKey(provider: string, commandName: string): string {
  return crypto
    .createHash('sha256')
    .update(`${provider}:${commandName}`)
    .digest('hex')
    .slice(0, 12)
}

/**
 * Read all OAuth (legacy) rows. Backwards-compatible with every caller
 * that existed before T-070 — non-OAuth rows are filtered out and the
 * `kind:'oauth'` wrapper is unwrapped so the returned shape matches
 * the pre-wave-6 `AccountMeta[]`.
 */
function readMeta(): AccountMeta[] {
  const file = readV2File()
  const out: AccountMeta[] = []
  for (const entry of file.accounts) {
    if (entry.kind !== 'oauth') continue
    out.push({
      id: entry.id,
      kind: entry.accountKind,
      email: entry.email,
      displayName: entry.displayName,
      externalId: entry.externalId,
      orgId: entry.orgId,
      orgName: entry.orgName,
      plan: entry.plan,
      rateLimitTier: entry.rateLimitTier,
      addedAt: entry.addedAt,
      lastRefreshedAt: entry.lastRefreshedAt,
      expiresAt: entry.expiresAt,
      status: entry.status,
    })
  }
  return out
}

/**
 * Write the OAuth rows back to disk, preserving any non-OAuth (apikey /
 * none) entries already present. Callers continue to operate on the
 * `AccountMeta[]` shape; this function reconstructs the v2 wrappers.
 */
function writeMeta(accounts: AccountMeta[]): void {
  const existing = readV2File()
  const preserved = existing.accounts.filter(e => e.kind !== 'oauth')
  const oauthEntries: V2Entry[] = accounts.map(m => {
    const provider: 'anthropic' | 'openai' = m.kind === 'anthropic' ? 'anthropic' : 'openai'
    return {
      kind: 'oauth',
      provider,
      id: m.id,
      email: m.email,
      displayName: m.displayName,
      externalId: m.externalId,
      orgId: m.orgId,
      orgName: m.orgName,
      plan: m.plan,
      rateLimitTier: m.rateLimitTier,
      addedAt: m.addedAt,
      lastRefreshedAt: m.lastRefreshedAt,
      expiresAt: m.expiresAt,
      status: m.status,
      accountKind: m.kind,
      refreshTokenRef: {
        service: `sweech-vault-${m.kind}-${m.id}`,
        account: KEYCHAIN_ACCOUNT,
      },
    }
  })
  const merged = [...oauthEntries, ...preserved]
  merged.sort((a, b) => {
    const provCmp = a.provider.localeCompare(b.provider)
    if (provCmp !== 0) return provCmp
    const aAdded = a.addedAt ?? ''
    const bAdded = b.addedAt ?? ''
    if (aAdded !== bAdded) return aAdded.localeCompare(bAdded)
    return a.id.localeCompare(b.id)
  })
  persistV2File({ schemaVersion: 2, accounts: merged })
}

/**
 * Full v2 account list (oauth + apikey + none). Exposed for the
 * unified provider tree in `providerModel.ts` and any downstream
 * caller that needs the full discriminated view.
 *
 * Returns a structural copy — mutating the returned array does not
 * persist back to disk.
 */
export function listAccountsV2(): import('./providerModel').Account[] {
  const file = readV2File()
  return file.accounts.map((entry): import('./providerModel').Account => {
    if (entry.kind === 'oauth') {
      return {
        kind: 'oauth',
        provider: entry.provider,
        id: entry.id,
        email: entry.email,
        displayName: entry.displayName,
        externalId: entry.externalId,
        orgId: entry.orgId,
        orgName: entry.orgName,
        plan: entry.plan,
        rateLimitTier: entry.rateLimitTier,
        addedAt: entry.addedAt,
        lastRefreshedAt: entry.lastRefreshedAt,
        expiresAt: entry.expiresAt,
        status: entry.status,
        refreshTokenRef: entry.refreshTokenRef,
      }
    }
    if (entry.kind === 'apikey') {
      return {
        kind: 'apikey',
        provider: entry.provider,
        id: entry.id,
        label: entry.label,
        addedAt: entry.addedAt,
        keyRef: entry.keyRef,
      }
    }
    return {
      kind: 'none',
      provider: entry.provider,
      id: entry.id,
      label: entry.label,
      addedAt: entry.addedAt,
    }
  })
}

/**
 * Persist a full v2 account list (oauth + apikey + none).
 *
 * Used by future writers (`vault add apikey ...`, T-072 onwards).
 * Today the OAuth path keeps using `saveAccount` so we don't break
 * the surface; this is the entry point that knows how to write
 * apikey/none rows.
 */
export function saveAccountsV2(accounts: import('./providerModel').Account[]): void {
  withVaultLock(() => {
    const entries: V2Entry[] = accounts.map((a): V2Entry => {
      if (a.kind === 'oauth') {
        const accountKind: AccountKind = a.provider === 'anthropic' ? 'anthropic' : 'openai'
        return {
          kind: 'oauth',
          provider: a.provider,
          id: a.id,
          email: a.email,
          displayName: a.displayName,
          externalId: a.externalId,
          orgId: a.orgId,
          orgName: a.orgName,
          plan: a.plan,
          rateLimitTier: a.rateLimitTier,
          addedAt: a.addedAt,
          lastRefreshedAt: a.lastRefreshedAt,
          expiresAt: a.expiresAt,
          status: a.status,
          accountKind,
          refreshTokenRef: a.refreshTokenRef ?? {
            service: `sweech-vault-${accountKind}-${a.id}`,
            account: KEYCHAIN_ACCOUNT,
          },
        }
      }
      if (a.kind === 'apikey') {
        return {
          kind: 'apikey',
          provider: a.provider,
          id: a.id,
          label: a.label,
          addedAt: a.addedAt,
          keyRef: a.keyRef,
        }
      }
      return {
        kind: 'none',
        provider: a.provider,
        id: a.id,
        label: a.label,
        addedAt: a.addedAt,
      }
    })
    entries.sort((a, b) => {
      const provCmp = a.provider.localeCompare(b.provider)
      if (provCmp !== 0) return provCmp
      const aAdded = a.addedAt ?? ''
      const bAdded = b.addedAt ?? ''
      if (aAdded !== bAdded) return aAdded.localeCompare(bAdded)
      return a.id.localeCompare(b.id)
    })
    persistV2File({ schemaVersion: 2, accounts: entries })
  })
}

/**
 * Acquire an advisory file lock on accounts.json so two concurrent
 * sweech invocations can't both read-modify-write the vault and lose
 * one of their rows. Uses an O_EXCL flag file in the same dir; spins
 * with backoff for up to ~2s, then throws.
 *
 * Codex adversarial review (HIGH x2):
 * - Previous lock-free read-modify-write was a data-loss race (now fixed).
 * - Previous timeout fall-through ran fn() without owning the lock AND
 *   unlinked the lock file on exit — silently stealing it from whoever
 *   actually held it. Now we throw on timeout; if we didn't acquire,
 *   we don't unlink.
 *
 * Reentrancy: the lock is process-wide via a module-level depth counter.
 * Nested withVaultLock calls from the same process bypass file I/O,
 * preventing the self-deadlock that codex flagged when callers like
 * vaultAddApiKey wrapped a saveAccountsV2 (which itself takes the lock).
 */
const LOCK_FILE = path.join(SWEECH_DIR, 'accounts.lock')
let __vaultLockDepth = 0
function withVaultLock<T>(fn: () => T): T {
  if (__vaultLockDepth > 0) {
    __vaultLockDepth++
    try { return fn() } finally { __vaultLockDepth-- }
  }
  fs.mkdirSync(SWEECH_DIR, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 2000
  let fd: number | null = null
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(LOCK_FILE, 'wx', 0o600)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          const st = fs.statSync(LOCK_FILE)
          if (Date.now() - st.mtimeMs > 10_000) {
            fs.unlinkSync(LOCK_FILE)
            continue
          }
        } catch {}
        const until = Date.now() + 25
        while (Date.now() < until) { /* spin */ }
        continue
      }
      throw err
    }
  }
  if (fd === null) {
    throw new Error(`vault lock timeout: could not acquire ${LOCK_FILE} within 2s`)
  }
  __vaultLockDepth = 1
  try {
    return fn()
  } finally {
    __vaultLockDepth = 0
    try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(LOCK_FILE) } catch {}
  }
}

/** Public lock helper for external callers that need to atomically
 * read-then-write across multiple v2 vault calls (e.g. vaultAddApiKey,
 * which would otherwise race on listAccountsV2 → ...mutate... → saveAccountsV2).
 * Internally piggybacks on the same file lock used by saveAccount/save*. */
export function withVaultLockExternal<T>(fn: () => T): T {
  return withVaultLock(fn)
}

// ── Public API ───────────────────────────────────────────────────────────────

export function listAccounts(kind?: AccountKind): AccountMeta[] {
  const all = readMeta()
  return kind ? all.filter(a => a.kind === kind) : all
}

export function getAccount(id: string): AccountMeta | null {
  return readMeta().find(a => a.id === id) ?? null
}

/**
 * Find a vault entry by kind + email (+ optional orgId).
 *
 * Resolution order (when orgId is provided):
 *   1. exact match on the orgId-aware id
 *   2. exact match on an existing entry whose `orgId` field equals orgId
 *   3. an existing legacy entry (no orgId stored) with that email —
 *      treated as a match so first-time orgId discovery doesn't
 *      mistake a single-org legacy entry for a new account
 *
 * Without orgId, falls back to the legacy `kind:email` id lookup.
 */
export function findAccountByEmail(
  kind: AccountKind,
  email: string,
  orgId?: string,
): AccountMeta | null {
  if (orgId) {
    const direct = getAccount(idFor(kind, email, orgId))
    if (direct) return direct
    const normalizedEmail = email.toLowerCase().trim()
    const all = readMeta()
    const sameOrg = all.find(
      a => a.kind === kind && a.email.toLowerCase().trim() === normalizedEmail && a.orgId === orgId,
    )
    if (sameOrg) return sameOrg
    const legacy = all.find(
      a => a.kind === kind && a.email.toLowerCase().trim() === normalizedEmail && !a.orgId,
    )
    if (legacy) return legacy
    return null
  }
  return getAccount(idFor(kind, email))
}

/**
 * Return ALL vault entries matching kind + email — used by the
 * OAuth import path to detect "same email, different orgs"
 * collisions before saving a new entry.
 */
export function findAccountsByEmail(kind: AccountKind, email: string): AccountMeta[] {
  const normalized = email.toLowerCase().trim()
  return readMeta().filter(
    a => a.kind === kind && a.email.toLowerCase().trim() === normalized,
  )
}

/**
 * Result of `resolveAccountForImport` — tells the OAuth caller which
 * action to take given the incoming (kind, email, orgId) tuple and
 * the current vault state.
 */
export type ImportResolution =
  /** No vault entry yet — caller can safely create a new entry. */
  | { action: 'create'; id: string; existing: null }
  /** Same identity already in vault — caller updates in place. */
  | { action: 'update'; id: string; existing: AccountMeta }
  /**
   * Same email exists under a DIFFERENT orgId. Caller must prompt
   * for confirmation (or refuse in non-TTY/forced contexts). If the
   * caller proceeds, it should pass the resulting `id` to saveAccount.
   */
  | { action: 'collision'; id: string; existing: AccountMeta; conflict: AccountMeta }

/**
 * Decide what an OAuth import should do given the discovered identity.
 *
 * Backfill is implicit: a legacy entry with no `orgId` matched on email
 * resolves to `update` so its id stays stable across the migration —
 * the caller is expected to write back the entry with `orgId` populated.
 *
 * A collision is raised only when there is an entry with the SAME email
 * but a DIFFERENT, non-empty orgId. That is the data-loss case the
 * original `idFor(kind, email)` masked.
 */
export function resolveAccountForImport(
  kind: AccountKind,
  email: string,
  orgId: string | undefined,
): ImportResolution {
  const candidates = findAccountsByEmail(kind, email)

  if (!orgId) {
    // No org discriminator from the OAuth provider — fall back to the
    // legacy single-org id so behaviour matches pre-orgId vaults.
    const legacyId = idFor(kind, email)
    const existing = candidates.find(a => a.id === legacyId)
      ?? candidates.find(a => !a.orgId)
      ?? null
    if (existing) return { action: 'update', id: existing.id, existing }
    // If a candidate exists with an orgId but we have none, don't
    // overwrite it — create a fresh legacy-shaped id alongside.
    return { action: 'create', id: legacyId, existing: null }
  }

  const newId = idFor(kind, email, orgId)
  const exactMatch = candidates.find(a => a.orgId === orgId || a.id === newId)
  if (exactMatch) {
    return { action: 'update', id: exactMatch.id, existing: exactMatch }
  }
  const differentOrg = candidates.find(a => a.orgId && a.orgId !== orgId)
  if (differentOrg) {
    return { action: 'collision', id: newId, existing: differentOrg, conflict: differentOrg }
  }
  // No conflicting org-keyed entry. A legacy entry with no orgId can
  // safely be claimed as this identity — backfill keeps its id stable.
  const legacy = candidates.find(a => !a.orgId)
  if (legacy) {
    return { action: 'update', id: legacy.id, existing: legacy }
  }
  return { action: 'create', id: newId, existing: null }
}

export async function getAccountSecret(id: string): Promise<AccountSecret | null> {
  const meta = getAccount(id)
  if (!meta) return null
  const store = getCredentialStore()
  const raw = await store.get(keychainService(meta.kind, meta.id), KEYCHAIN_ACCOUNT)
  if (!raw) return null
  try { return JSON.parse(raw) as AccountSecret } catch { return null }
}

export async function saveAccount(meta: AccountMeta, secret: AccountSecret): Promise<void> {
  withVaultLock(() => {
    const all = readMeta()
    const idx = all.findIndex(a => a.id === meta.id)
    if (idx >= 0) all[idx] = meta
    else all.push(meta)
    writeMeta(all)
  })
  const store = getCredentialStore()
  await store.set(keychainService(meta.kind, meta.id), KEYCHAIN_ACCOUNT, JSON.stringify(secret))
}

/** Update only the metadata side of an account (no secret rewrite). */
export function updateAccountMeta(id: string, patch: Partial<AccountMeta>): AccountMeta | null {
  return withVaultLock(() => {
    const all = readMeta()
    const idx = all.findIndex(a => a.id === id)
    if (idx < 0) return null
    all[idx] = { ...all[idx], ...patch, id: all[idx].id, kind: all[idx].kind }
    writeMeta(all)
    return all[idx]
  })
}

export async function removeAccount(id: string): Promise<boolean> {
  const meta = withVaultLock(() => {
    const all = readMeta()
    const m = all.find(a => a.id === id)
    if (!m) return null
    writeMeta(all.filter(a => a.id !== id))
    return m
  })
  if (!meta) return false
  try {
    await getCredentialStore().delete(keychainService(meta.kind, meta.id), KEYCHAIN_ACCOUNT)
  } catch {}
  return true
}

// ── Workspace assignment markers ─────────────────────────────────────────────

export function getActiveAccountId(workspaceCommandName: string): string | null {
  try {
    const raw = fs.readFileSync(workspaceMarkerPath(workspaceCommandName), 'utf-8').trim()
    return raw || null
  } catch {
    return null
  }
}

export function setActiveAccountId(workspaceCommandName: string, accountId: string | null): void {
  const file = workspaceMarkerPath(workspaceCommandName)
  if (accountId === null) {
    try { fs.unlinkSync(file) } catch {}
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  atomicWriteFileSync(file, accountId)
  try { fs.chmodSync(file, 0o600) } catch {}
}

/** Return all workspaces in which the given account is currently mounted. */
export function findWorkspacesUsingAccount(
  accountId: string,
  workspaces: Array<{ commandName: string }>,
): string[] {
  return workspaces
    .filter(w => getActiveAccountId(w.commandName) === accountId)
    .map(w => w.commandName)
}
