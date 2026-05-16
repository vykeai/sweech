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

// ── Metadata I/O ─────────────────────────────────────────────────────────────

function readMeta(): AccountMeta[] {
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function writeMeta(accounts: AccountMeta[]): void {
  fs.mkdirSync(SWEECH_DIR, { recursive: true, mode: 0o700 })
  atomicWriteFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2))
  try { fs.chmodSync(ACCOUNTS_FILE, 0o600) } catch {}
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
  const normalizedEmail = email.toLowerCase().trim()
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
  const all = readMeta()
  const idx = all.findIndex(a => a.id === meta.id)
  if (idx >= 0) all[idx] = meta
  else all.push(meta)
  writeMeta(all)
  const store = getCredentialStore()
  await store.set(keychainService(meta.kind, meta.id), KEYCHAIN_ACCOUNT, JSON.stringify(secret))
}

/** Update only the metadata side of an account (no secret rewrite). */
export function updateAccountMeta(id: string, patch: Partial<AccountMeta>): AccountMeta | null {
  const all = readMeta()
  const idx = all.findIndex(a => a.id === id)
  if (idx < 0) return null
  all[idx] = { ...all[idx], ...patch, id: all[idx].id, kind: all[idx].kind }
  writeMeta(all)
  return all[idx]
}

export async function removeAccount(id: string): Promise<boolean> {
  const all = readMeta()
  const meta = all.find(a => a.id === id)
  if (!meta) return false
  writeMeta(all.filter(a => a.id !== id))
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
