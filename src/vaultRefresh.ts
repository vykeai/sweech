/**
 * Vault-backed token refresh.
 *
 * Iterates all accounts in the central vault and refreshes any whose
 * access tokens are within the refresh window. After refreshing the
 * vault secret, also rewrites the credentials inside any workspace
 * that currently mounts that account so the running CLI picks up the
 * fresh token immediately.
 */

import { scrubSecrets } from './scrubSecrets'
import {
  AccountMeta,
  AnthropicSecret,
  OpenAISecret,
  findWorkspacesUsingAccount,
  getAccountSecret,
  listAccounts,
  saveAccount,
  updateAccountMeta,
} from './vault'
import { discoverWorkspaces } from './vaultImport'
import { assignAccountToWorkspace } from './vaultAssign'
import { getAnthropicClientId } from './anthropicAuth'

const REFRESH_WINDOW_MS = 30 * 60 * 1000  // refresh within 30 min of expiry

export interface RefreshResult {
  email: string
  kind: 'anthropic' | 'openai'
  outcome: 'refreshed' | 'still-valid' | 'no-refresh-token' | 'failed' | 'remounted'
  error?: string
  expiresAt?: number
}

/**
 * Refresh tokens for any vault account whose access token expires within
 * REFRESH_WINDOW_MS. Returns per-account outcomes for telemetry.
 */
export async function refreshExpiringAccounts(opts: { force?: boolean } = {}): Promise<RefreshResult[]> {
  const accounts = listAccounts()
  const results: RefreshResult[] = []
  const workspaces = discoverWorkspaces()
  const now = Date.now()

  for (const meta of accounts) {
    const stillValid = meta.expiresAt && (meta.expiresAt - now > REFRESH_WINDOW_MS)
    if (stillValid && !opts.force) {
      results.push({ email: meta.email, kind: meta.kind, outcome: 'still-valid', expiresAt: meta.expiresAt })
      continue
    }
    const result = await refreshAccount(meta).catch(err => ({
      email: meta.email,
      kind: meta.kind,
      outcome: 'failed' as const,
      error: scrubSecrets(err instanceof Error ? err.message : String(err)),
    }))
    results.push(result)

    // If the account is mounted in any workspace, push the fresh credentials
    // into that workspace so the running/future CLI invocation uses them.
    if (result.outcome === 'refreshed') {
      const mounted = findWorkspacesUsingAccount(meta.id, workspaces.map(w => ({ commandName: w.commandName })))
      for (const cn of mounted) {
        const ws = workspaces.find(w => w.commandName === cn)
        if (!ws) continue
        try {
          // Force-bypass the binary-on-PATH preflight: refresh is a daemon
          // remount of an already-mounted account, not a user-initiated mount,
          // so a temporarily-missing CLI shouldn't block the fresh token from
          // landing on disk.
          const r = await assignAccountToWorkspace(ws, meta.id, { force: true })
          if (r.ok) {
            results.push({ email: meta.email, kind: meta.kind, outcome: 'remounted' })
          }
        } catch {}
      }
    }
  }
  return results
}

async function refreshAccount(meta: AccountMeta): Promise<RefreshResult> {
  const secret = await getAccountSecret(meta.id)
  if (!secret) {
    return { email: meta.email, kind: meta.kind, outcome: 'failed', error: 'No stored secret' }
  }
  if (meta.kind === 'anthropic') {
    return refreshAnthropic(meta, secret as AnthropicSecret)
  }
  return refreshOpenAI(meta, secret as OpenAISecret)
}

async function refreshAnthropic(meta: AccountMeta, secret: AnthropicSecret): Promise<RefreshResult> {
  if (!secret.refreshToken) {
    updateAccountMeta(meta.id, { status: 'expired', lastRefreshedAt: new Date().toISOString() })
    return { email: meta.email, kind: 'anthropic', outcome: 'no-refresh-token' }
  }

  const clientId = getAnthropicClientId()
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: secret.refreshToken,
  })

  const res = await fetch('https://platform.claude.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const status = res.status === 401 || res.status === 403 ? 'unauthorized' : 'expired'
    updateAccountMeta(meta.id, { status, lastRefreshedAt: new Date().toISOString() })
    return {
      email: meta.email,
      kind: 'anthropic',
      outcome: 'failed',
      error: `${res.status} ${scrubSecrets(body)}`.slice(0, 200),
    }
  }
  const data = (await res.json()) as Record<string, unknown>
  const accessToken = data.access_token as string
  const refreshToken = (data.refresh_token as string | undefined) ?? secret.refreshToken
  const expiresIn = data.expires_in as number | undefined
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : secret.expiresAt

  const next: AnthropicSecret = {
    ...secret,
    accessToken,
    refreshToken,
    expiresAt,
  }
  await saveAccount(
    { ...meta, expiresAt, status: 'ok', lastRefreshedAt: new Date().toISOString() },
    next,
  )
  return { email: meta.email, kind: 'anthropic', outcome: 'refreshed', expiresAt }
}

async function refreshOpenAI(meta: AccountMeta, secret: OpenAISecret): Promise<RefreshResult> {
  const tokens = secret.tokens
  if (!tokens?.refresh_token) {
    updateAccountMeta(meta.id, { status: 'expired', lastRefreshedAt: new Date().toISOString() })
    return { email: meta.email, kind: 'openai', outcome: 'no-refresh-token' }
  }

  // Codex CLI uses the same OpenAI OAuth client as ChatGPT desktop — the
  // refresh endpoint is auth.openai.com/oauth/token. We send the stored
  // refresh_token and request id_token + refresh_token rotation.
  const clientId = process.env.OPENAI_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann'
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: tokens.refresh_token,
    scope: 'openid profile email offline_access',
  })

  const res = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const status = res.status === 401 || res.status === 403 ? 'unauthorized' : 'expired'
    updateAccountMeta(meta.id, { status, lastRefreshedAt: new Date().toISOString() })
    return {
      email: meta.email,
      kind: 'openai',
      outcome: 'failed',
      error: `${res.status} ${scrubSecrets(body)}`.slice(0, 200),
    }
  }
  const data = (await res.json()) as Record<string, unknown>
  const accessToken = data.access_token as string
  const refreshToken = (data.refresh_token as string | undefined) ?? tokens.refresh_token
  const idToken = (data.id_token as string | undefined) ?? tokens.id_token
  const expiresIn = data.expires_in as number | undefined
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : meta.expiresAt

  const next: OpenAISecret = {
    ...secret,
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      account_id: tokens.account_id,
    },
  }
  await saveAccount(
    { ...meta, expiresAt, status: 'ok', lastRefreshedAt: new Date().toISOString() },
    next,
  )
  return { email: meta.email, kind: 'openai', outcome: 'refreshed', expiresAt }
}
