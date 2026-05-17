/**
 * Add an API-key account to the v2 vault (T-072, wave-6).
 *
 * Before wave-6 an API key only existed inside a workspace — when a user
 * created a profile (`sweech add ...`), the key was stashed at
 * `sweech-api-key:<commandName>` and tied to that workspace's lifecycle.
 *
 * Wave-6 unifies credentials behind the Provider/Account/Workspace tree
 * (see `src/providerModel.ts`). API-key accounts now live in the same
 * `~/.sweech/accounts.json` vault as OAuth identities, and a workspace
 * mounts the account via the standard `.sweech-account` marker.
 *
 * This module is the **direct add** path:
 *   sweech accounts add --kind apikey --provider <name> --key <source>
 *
 * No workspace is required. The vault entry can be created first and
 * mounted into one or more workspaces later via `sweech assign`.
 *
 * Key sources (resolved in `resolveApiKeyValue` below):
 *   - `--key SOME_ENV_VAR` → read from `process.env.SOME_ENV_VAR`
 *   - `--key -`            → read once from stdin (no echo)
 *   - `--key` omitted      → interactive prompt (TTY only)
 *
 * Keychain layout:
 *   service = 'sweech-api-key'
 *   account = <new account-id>           (NOT the workspace commandName)
 *
 * The legacy per-workspace entries (`sweech-api-key:<commandName>`) are
 * preserved so workspaces created before T-072 continue to resolve their
 * keys via `resolveApiKey()` in `src/config.ts`. They become mirrors of
 * the new vault entry once a workspace is reassigned via `sweech assign`.
 */

import { randomUUID } from 'node:crypto'
import { getCredentialStore } from './credentialStore'
import {
  Account,
  ApiKeyAccount,
  PROVIDER_CATALOG,
  accountIdForApiKey,
  getProviderById,
} from './providerModel'
import { listAccountsV2, saveAccountsV2 } from './vault'

/** Keychain service name reused by every API-key entry in the v2 vault. */
const KEYCHAIN_SERVICE = 'sweech-api-key'

export type ApiKeySource =
  /** Read the secret from `process.env[envVar]`. */
  | { type: 'env'; envVar: string }
  /** Read one line from stdin. */
  | { type: 'stdin' }
  /** Provide the secret directly (used by interactive prompt + tests). */
  | { type: 'literal'; value: string }

export interface AddApiKeyOptions {
  /** Provider id from `PROVIDER_CATALOG` (e.g. 'kimi', 'dashscope', 'glm'). */
  provider: string
  /** Human label, optional. When absent a random UUID seed is used. */
  label?: string
  /** Where to read the API key from. */
  keySource: ApiKeySource
  /** Hook so callers (tests, interactive prompts) can supply a value. */
  promptForKey?: () => Promise<string>
}

export interface AddApiKeyResult {
  ok: true
  account: ApiKeyAccount
  /** True when the same (provider, label) tuple already had a row. */
  alreadyExisted: boolean
}

export interface AddApiKeyError {
  ok: false
  reason: string
}

/**
 * Resolve `keySource` into the raw secret string.
 *
 * Returns `null` when the source can't yield a value (missing env var,
 * empty stdin) — caller is expected to translate that to an error.
 */
export async function resolveApiKeyValue(
  source: ApiKeySource,
  opts: { stdinReader?: () => Promise<string> } = {},
): Promise<string | null> {
  if (source.type === 'literal') {
    const v = source.value.trim()
    return v ? v : null
  }
  if (source.type === 'env') {
    const v = process.env[source.envVar]
    return v && v.trim().length > 0 ? v.trim() : null
  }
  // stdin
  const reader = opts.stdinReader ?? readOnceFromStdin
  const raw = await reader()
  const v = raw.trim()
  return v.length > 0 ? v : null
}

/**
 * Read one line of input from stdin. Drains until EOF so multi-line
 * keys aren't truncated. Returns the raw bytes (caller trims).
 */
async function readOnceFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    // A TTY stdin without an explicit prompt would hang forever; bail
    // out and let the caller fall back to the interactive prompt path.
    return ''
  }
  return new Promise<string>((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk: string) => { buf += chunk })
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', err => reject(err))
  })
}

/**
 * Validate that a provider id is a known apikey-capable provider.
 *
 * Returns `null` on success, or a human-readable reason. Local-only
 * providers (`kind: 'local'`) reject — they have no key to store.
 */
export function validateApiKeyProvider(providerId: string): string | null {
  const p = getProviderById(providerId)
  if (!p) {
    const choices = PROVIDER_CATALOG
      .filter(x => x.kind === 'apikey')
      .map(x => x.id)
      .sort()
      .join(', ')
    return `unknown provider "${providerId}". apikey providers: ${choices}`
  }
  if (p.kind === 'local') {
    return `provider "${providerId}" is local — no api key required`
  }
  return null
}

/**
 * Create a new apikey vault entry and persist its secret to keychain.
 *
 * The id is derived deterministically from
 *   sha8(provider + ':' + (label || uuid()))
 * so a fresh label (or omitted label) always produces a new id, never
 * silently replacing an existing entry. Use `label` to make the entry
 * stable & re-creatable (e.g. CI scripts that rotate keys in place).
 */
export async function addApiKeyAccount(
  opts: AddApiKeyOptions,
): Promise<AddApiKeyResult | AddApiKeyError> {
  const validationError = validateApiKeyProvider(opts.provider)
  if (validationError) return { ok: false, reason: validationError }

  // Resolve the secret. Fall back to interactive prompt when stdin
  // can't supply a value (no env var, empty stdin, TTY but no prompt).
  let key = await resolveApiKeyValue(opts.keySource)
  if (!key && opts.promptForKey) {
    const prompted = await opts.promptForKey()
    key = prompted.trim().length > 0 ? prompted.trim() : null
  }
  if (!key) {
    let hint: string
    if (opts.keySource.type === 'env') {
      hint = `env var ${opts.keySource.envVar} is empty or unset`
    } else if (opts.keySource.type === 'stdin') {
      hint = 'no key on stdin (pipe one in or use --key <ENV_VAR>)'
    } else {
      hint = 'no key supplied'
    }
    return { ok: false, reason: `Failed to read api key: ${hint}` }
  }

  // Derive the stable id. Labelled accounts get sha8(provider:label);
  // un-labelled accounts get a fresh random seed so two un-labelled
  // adds for the same provider don't collide.
  const idSeed = opts.label?.trim() || randomUUID()
  const id = accountIdForApiKey(opts.provider, idSeed)

  // Persist the secret first — if keychain write fails we don't want
  // the vault row left dangling without a key.
  const store = getCredentialStore()
  try {
    await store.set(KEYCHAIN_SERVICE, id, key)
  } catch (err) {
    return {
      ok: false,
      reason: `Keychain write failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const existing = listAccountsV2().find(a => a.kind === 'apikey' && a.id === id)
  const account: ApiKeyAccount = {
    kind: 'apikey',
    provider: opts.provider,
    id,
    label: opts.label?.trim() || undefined,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    keyRef: {
      service: KEYCHAIN_SERVICE,
      account: id,
    },
  }

  // Merge into the v2 vault, replacing any pre-existing row with the
  // same id (key rotation in place when label is stable).
  const all = listAccountsV2()
  const others = all.filter(a => !(a.kind === 'apikey' && a.id === id))
  const next: Account[] = [...others, account]
  saveAccountsV2(next)

  return { ok: true, account, alreadyExisted: !!existing }
}
