/**
 * Fresh-login flow for adding a brand new identity to the vault.
 *
 * Anthropic (claude):
 *   PKCE OAuth against claude.ai using the Claude Code client_id. After
 *   token exchange, probe Anthropic's profile endpoint to capture email
 *   and accountUuid, then store everything in the vault.
 *
 * OpenAI (codex):
 *   The Codex CLI uses the ChatGPT-desktop OAuth app, whose flow is
 *   tightly coupled to a registered redirect URI we can't reproduce
 *   from a third-party CLI. For codex accounts, this module raises a
 *   guided error telling the user to run `codex login` followed by
 *   `sweech accounts import` — which lands the same identity in the
 *   vault without reinventing OpenAI's broker.
 */

import * as crypto from 'node:crypto'
import * as url from 'node:url'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { scrubSecrets } from './scrubSecrets'
import {
  AccountKind,
  AccountMeta,
  AnthropicSecret,
  resolveAccountForImport,
  saveAccount,
} from './vault'

const ANTHROPIC_CLIENT_ID = process.env.ANTHROPIC_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const ANTHROPIC_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const ANTHROPIC_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

export interface AddAccountResult {
  ok: true
  account: AccountMeta
  alreadyExisted: boolean
}

export interface AddAccountError {
  ok: false
  reason: string
}

export async function addAnthropicAccount(): Promise<AddAccountResult | AddAccountError> {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = crypto.randomBytes(16).toString('hex')

  const authUrl = new url.URL(ANTHROPIC_AUTHORIZE_URL)
  authUrl.searchParams.set('client_id', ANTHROPIC_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', ANTHROPIC_REDIRECT_URI)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', 'org:create_api_key user:profile user:inference')
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)

  console.log(chalk.cyan('\n  Step 1:'), 'open this URL in your browser')
  console.log(chalk.dim('         use incognito to pick a different account\n'))
  console.log('  ' + authUrl.toString())
  console.log()

  const { authCode } = await inquirer.prompt([{
    type: 'input',
    name: 'authCode',
    message: 'Step 2: paste the code from the redirect page',
    validate: (s: string) => s.trim().length > 0 || 'Code required',
  }])

  // The code returned by claude.ai/oauth is structured as `<code>#<state>`.
  // Strip the trailing #state if present.
  const rawCode = authCode.trim().split('#')[0]

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ANTHROPIC_CLIENT_ID,
    code: rawCode,
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    code_verifier: codeVerifier,
    state,
  })
  const res = await fetch(ANTHROPIC_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, reason: `Token exchange failed: ${res.status} ${scrubSecrets(body).slice(0, 200)}` }
  }
  const data = (await res.json()) as Record<string, unknown>
  const accessToken = data.access_token as string
  const refreshToken = data.refresh_token as string
  const expiresIn = data.expires_in as number | undefined
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined
  if (!accessToken || !refreshToken) {
    return { ok: false, reason: 'Token exchange returned no tokens' }
  }

  // Probe the profile endpoint to capture email + accountUuid. Without
  // these we'd store the account under the synthetic placeholder.
  const profile = await fetchAnthropicProfile(accessToken).catch(() => null)
  const email = profile?.email ?? `anthropic-${Date.now()}@unknown.local`
  const accountUuid = profile?.accountUuid
  const orgId = profile?.organizationUuid
  const orgName = profile?.organizationName

  const kind: AccountKind = 'anthropic'
  const resolution = resolveAccountForImport(kind, email, orgId)

  if (resolution.action === 'collision') {
    const proceed = await confirmOrgCollision({
      email,
      existing: resolution.conflict,
      incomingOrgId: orgId!,
      incomingOrgName: orgName,
    })
    if (!proceed) {
      return {
        ok: false,
        reason: `Account ${email} already exists under a different org `
          + `(${resolution.conflict.orgName ?? resolution.conflict.orgId}); aborted to avoid overwrite`,
      }
    }
  }

  const existing = resolution.action === 'update' ? resolution.existing : null
  const meta: AccountMeta = {
    id: resolution.id,
    kind,
    email,
    displayName: profile?.displayName,
    externalId: accountUuid,
    orgId,
    orgName,
    plan: profile?.plan,
    rateLimitTier: profile?.rateLimitTier,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    lastRefreshedAt: new Date().toISOString(),
    expiresAt,
    status: 'ok',
  }
  const secret: AnthropicSecret = {
    accessToken,
    refreshToken,
    expiresAt: expiresAt ?? 0,
    subscriptionType: profile?.subscriptionType,
    rateLimitTier: profile?.rateLimitTier,
  }
  await saveAccount(meta, secret)
  return { ok: true, account: meta, alreadyExisted: !!existing }
}

/**
 * Interactive y/N prompt when the OAuth flow lands an email that
 * already lives in the vault under a different org. Refuses
 * (returns false) when stdin is not a TTY — non-interactive
 * contexts can't make this safety call.
 */
async function confirmOrgCollision(args: {
  email: string
  existing: AccountMeta
  incomingOrgId: string
  incomingOrgName?: string
}): Promise<boolean> {
  const existingOrg = args.existing.orgName ?? args.existing.orgId ?? '(unknown org)'
  const incomingOrg = args.incomingOrgName ?? args.incomingOrgId
  process.stderr.write(
    chalk.yellow(
      `\n  ⚠ Account ${chalk.bold(args.email)} already exists in vault for org `
      + `${chalk.bold(existingOrg)}.\n`
      + `    Adding another entry for org ${chalk.bold(incomingOrg)} will create a `
      + `separate vault entry.\n`,
    ),
  )
  if (!process.stdin.isTTY) {
    process.stderr.write(
      chalk.red(`    Refusing in non-interactive mode. Re-run from a TTY to confirm.\n\n`),
    )
    return false
  }
  const { proceed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'proceed',
    message: 'Add the second org-scoped account?',
    default: false,
  }])
  return !!proceed
}

export interface AnthropicProfile {
  email?: string
  displayName?: string
  accountUuid?: string
  /** Anthropic organization.uuid — used as orgId for vault disambiguation. */
  organizationUuid?: string
  /** Human-readable organization name (e.g. "Personal", "Acme Inc."). */
  organizationName?: string
  plan?: string
  rateLimitTier?: string
  subscriptionType?: string
}

export async function fetchAnthropicProfile(accessToken: string): Promise<AnthropicProfile | null> {
  const res = await fetch(ANTHROPIC_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  })
  if (!res.ok) return null
  const data = (await res.json()) as Record<string, any>
  const account = data.account ?? data
  const organization = data.organization ?? {}
  return {
    email: account.email_address ?? account.email,
    displayName: account.display_name ?? account.name,
    accountUuid: account.uuid ?? account.account_uuid,
    organizationUuid: organization.uuid ?? organization.organization_uuid ?? organization.id,
    organizationName: organization.name ?? organization.organization_name,
    plan: organization.plan_type ?? account.plan,
    rateLimitTier: account.rate_limit_tier ?? account.rateLimitTier,
    subscriptionType: account.subscription_type ?? account.billing_type,
  }
}

export function codexAddInstructions(): string {
  return [
    chalk.yellow('  Adding OpenAI/codex accounts directly via sweech isn\'t supported yet:'),
    chalk.dim('  the codex CLI uses the ChatGPT-desktop OAuth app whose redirect URI'),
    chalk.dim('  is locked to that app. The supported flow is:'),
    '',
    chalk.cyan('    1.') + ' codex login                      ' + chalk.dim('# or codex --login'),
    chalk.cyan('    2.') + ' sweech accounts import           ' + chalk.dim('# pulls into vault'),
    chalk.cyan('    3.') + ' sweech assign codex <email>      ' + chalk.dim('# (re-)mount it'),
  ].join('\n')
}

// ── PKCE helpers ────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}
