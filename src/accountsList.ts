/**
 * Pure helpers backing `sweech accounts list` (T-072, wave-6).
 *
 * The CLI command in `src/cli.ts` does I/O (workspace probing, terminal
 * rendering). This module exposes the testable kernel — filter logic
 * and JSON shape building — so unit tests can exercise the contract
 * without spinning up the whole CLI.
 */

import { Account } from './providerModel'

/** Filter dimension supported by `--kind`. */
export type AccountKindFilter = 'oauth' | 'apikey' | 'local' | 'all'

export interface AccountsListFilters {
  /** Default 'all' — show every kind. */
  kind?: AccountKindFilter
  /** Optional provider id filter (e.g. 'dashscope'). */
  provider?: string
}

/**
 * Apply --kind and --provider filters to an unsorted account list.
 *
 * Filter rules:
 *   --kind=oauth   → keep `kind: 'oauth'`
 *   --kind=apikey  → keep `kind: 'apikey'`
 *   --kind=local   → keep `kind: 'none'` (the on-disk discriminator
 *                    for local/no-auth accounts)
 *   --kind=all|undef → keep everything
 *   --provider=X   → exact match against `account.provider`
 *
 * The CLI's `local` filter maps to the on-disk `none` discriminator —
 * the disk shape preserved the legacy "no-auth" name, while the user
 * facing shape uses "local". Both names refer to the same row.
 */
export function filterAccountsForList(
  accounts: Account[],
  filters: AccountsListFilters = {},
): Account[] {
  const kind = filters.kind ?? 'all'
  const out: Account[] = []
  for (const a of accounts) {
    if (kind === 'oauth' && a.kind !== 'oauth') continue
    if (kind === 'apikey' && a.kind !== 'apikey') continue
    if (kind === 'local' && a.kind !== 'none') continue
    if (filters.provider && a.provider !== filters.provider) continue
    out.push(a)
  }
  return out
}

/**
 * Stable sort applied to display rows. Order:
 *   1. kind (oauth → apikey → none) so OAuth identities head the list
 *   2. provider asc — providers are grouped under their headers in the
 *      terminal renderer; sorting here keeps the JSON shape predictable
 *   3. for oauth, by email asc
 *   4. for apikey/none, by label || id asc
 */
export function sortAccountsForList(accounts: Account[]): Account[] {
  const kindRank = (k: Account['kind']): number => (
    k === 'oauth' ? 0 : k === 'apikey' ? 1 : 2
  )
  return [...accounts].sort((a, b) => {
    const kr = kindRank(a.kind) - kindRank(b.kind)
    if (kr !== 0) return kr
    const pr = a.provider.localeCompare(b.provider)
    if (pr !== 0) return pr
    const aKey = a.kind === 'oauth' ? a.email : (a.label ?? a.id)
    const bKey = b.kind === 'oauth' ? b.email : (b.label ?? b.id)
    return aKey.localeCompare(bKey)
  })
}

/**
 * Translate the user-facing 'local' filter token into the on-disk
 * discriminator so unrelated callers (filterAccountsForList) can stay
 * pure. Exposed for tests.
 */
export function normalizeKindFilter(input: string | undefined): AccountKindFilter {
  if (!input) return 'all'
  const v = input.toLowerCase()
  if (v === 'oauth' || v === 'apikey' || v === 'local' || v === 'all') return v
  return 'all'
}

/**
 * Parse a comma-separated provider id token. We only support the
 * single-provider shape today — kept here so future expansion (e.g.
 * `--provider kimi,glm`) lands in one place.
 */
export function normalizeProviderFilter(input: string | undefined): string | undefined {
  if (!input) return undefined
  const v = input.trim()
  return v.length > 0 ? v : undefined
}

/**
 * Build the JSON shape emitted by `sweech accounts list --json`.
 *
 * Wave-6 callers expect:
 *   {
 *     "schemaVersion": 1,
 *     "accounts": Account[]
 *   }
 *
 * The bumped `schemaVersion` is independent of the vault file version —
 * it tracks the CLI's JSON contract so downstream tooling can pin to it.
 */
export interface AccountsListJsonShape {
  schemaVersion: 1
  accounts: Account[]
}

export function buildAccountsListJson(accounts: Account[]): AccountsListJsonShape {
  return { schemaVersion: 1, accounts }
}
