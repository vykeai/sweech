/**
 * Workspace ← Account assignment.
 *
 * Writes a vault-stored account's credentials into a workspace directory so
 * the underlying CLI (claude or codex) picks them up on next launch.
 *
 * Compatibility:
 *   anthropic account → claude workspace only
 *   openai account    → codex workspace only
 *
 * Side effects per CLI:
 *   claude:
 *     - rewrite keychain entry `Claude Code-credentials[-<dirhash>]` with the
 *       vault's accessToken/refreshToken/expiresAt/subscriptionType/rateLimitTier
 *     - patch <dir>/.claude.json oauthAccount block so the running CLI banner
 *       displays the right identity
 *   codex:
 *     - overwrite <dir>/auth.json with the vault's stored auth contents
 *
 * Also writes the `.sweech-account` marker so later reads know which vault
 * entry is mounted.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { atomicWriteFileSync } from './atomicWrite'
import { getCLI } from './clis'
import { computeKeychainServiceName, getCredentialStore } from './credentialStore'
import { isMacOS } from './platform'
import {
  AccountKind,
  AnthropicSecret,
  CliType,
  OpenAISecret,
  getAccount,
  getAccountSecret,
  kindForCliType,
  setActiveAccountId,
} from './vault'

export interface AssignError {
  ok: false
  reason: string
}

export interface AssignSuccess {
  ok: true
  workspaceCommandName: string
  accountId: string
  email: string
  /** True when the preflight `which` check succeeded; false when bypassed via `force`. */
  binaryOnPath: boolean
  /** Resolved underlying CLI binary name (e.g. 'claude', 'codex'). */
  binary: string
}

export type AssignResult = AssignSuccess | AssignError

export interface Workspace {
  commandName: string  // 'claude', 'codex-pole', etc — directory suffix
  cliType: CliType
  configDir: string    // ~/.<commandName>
}

export interface AssignOptions {
  /**
   * Skip the preflight `which <binary>` check. The mount still writes
   * credentials, but the caller is responsible for warning the user that
   * launches will fail until the binary is installed.
   */
  force?: boolean
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function assignAccountToWorkspace(
  ws: Workspace,
  accountId: string,
  opts: AssignOptions = {},
): Promise<AssignResult> {
  const meta = getAccount(accountId)
  if (!meta) return { ok: false, reason: `Account ${accountId} not found in vault` }

  const expectedKind = kindForCliType(ws.cliType)
  if (!expectedKind) {
    return { ok: false, reason: `Workspace ${ws.commandName} has unsupported cliType=${ws.cliType}` }
  }
  if (meta.kind !== expectedKind) {
    return {
      ok: false,
      reason: `Incompatible: account ${meta.email} is ${meta.kind} but workspace ${ws.commandName} expects ${expectedKind}`,
    }
  }

  // Pre-flight: does the underlying CLI binary resolve on PATH? Skip on
  // --force so power users can mount-then-install without re-running. The
  // caller (cli.ts) prints the warning when force is used.
  const binary = binaryForCliType(ws.cliType)
  const binaryFound = isBinaryOnPath(binary)
  if (!binaryFound && !opts.force) {
    return {
      ok: false,
      reason: `CLI binary "${binary}" not found on PATH. Install: ${installHint(ws.cliType)}`,
    }
  }

  const secret = await getAccountSecret(accountId)
  if (!secret) return { ok: false, reason: `No credentials stored for ${meta.email}` }

  try {
    if (ws.cliType === 'claude') {
      await writeClaudeCredentials(ws.configDir, secret as AnthropicSecret, meta)
    } else {
      writeCodexCredentials(ws.configDir, secret as OpenAISecret)
    }
  } catch (err) {
    return { ok: false, reason: `Failed to write credentials: ${(err as Error).message}` }
  }

  setActiveAccountId(ws.commandName, accountId)
  return {
    ok: true,
    workspaceCommandName: ws.commandName,
    accountId,
    email: meta.email,
    binaryOnPath: binaryFound,
    binary,
  }
}

// ── Pre-flight helpers ───────────────────────────────────────────────────────

/**
 * Resolve the on-PATH binary name for a workspace cliType.
 *
 * Falls back to the cliType string when the CLI registry has no entry — the
 * preflight will fail safely if such a binary isn't installed.
 */
function binaryForCliType(cliType: CliType): string {
  return getCLI(cliType)?.command ?? cliType
}

/**
 * Synchronous PATH check using `which` (or `where` on Windows).
 *
 * On darwin/linux: `/usr/bin/which <binary>` exits non-zero when the binary
 * is missing — `execFileSync` throws and we return false.
 * On win32: `where.exe` is the Windows equivalent and shipped with the OS;
 * untested in this codebase but follows the same exit-code contract.
 */
function isBinaryOnPath(binary: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  try {
    execFileSync(lookup, [binary], { stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

/**
 * Human-friendly install hint per cliType.
 *
 * Grounded in sweech's existing docs (README "Requirements" section) and the
 * `installUrl` field of `clis.ts`. We deliberately quote the README's
 * recommended commands rather than inventing brew taps that may not exist.
 */
function installHint(cliType: CliType): string {
  switch (cliType) {
    case 'claude':
      return 'npm install -g @anthropic/claude-code  (or visit https://code.claude.com/)'
    case 'codex':
      return 'See https://github.com/openai/codex for installation instructions'
    default:
      return `install ${cliType} and ensure it is on PATH`
  }
}

// ── Claude: keychain + .claude.json ─────────────────────────────────────────

async function writeClaudeCredentials(
  configDir: string,
  secret: AnthropicSecret,
  meta: { email: string; externalId?: string; rateLimitTier?: string },
): Promise<void> {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const service = computeKeychainServiceName(configDir)
  const payload = JSON.stringify({
    claudeAiOauth: {
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken,
      expiresAt: secret.expiresAt,
      subscriptionType: secret.subscriptionType,
      rateLimitTier: secret.rateLimitTier ?? meta.rateLimitTier,
      scopes: ['user:inference', 'user:profile'],
    },
  })
  const user = username()
  if (isMacOS()) {
    // macOS: execFile against `security` — no shell, args passed as argv.
    execFileSync(
      'security',
      ['add-generic-password', '-U', '-a', user, '-s', service, '-w', payload],
      { stdio: 'ignore' },
    )
  } else {
    // Other platforms: cross-platform store; claude reads .credentials.json.
    await getCredentialStore().set(service, user, payload)
  }

  // Mirror to .credentials.json (claude on non-macOS reads this; also useful
  // as a backup on macOS so refresh tooling can see the active token).
  const credPath = path.join(configDir, '.credentials.json')
  try {
    atomicWriteFileSync(credPath, JSON.stringify(JSON.parse(payload), null, 2))
    fs.chmodSync(credPath, 0o600)
  } catch {}

  // Patch oauthAccount in .claude.json so claude's banner shows the right
  // identity (and so sweech's TUI picks it up without a live refresh).
  patchClaudeJson(configDir, {
    emailAddress: meta.email,
    accountUuid: meta.externalId,
    rateLimitTier: secret.rateLimitTier ?? meta.rateLimitTier,
    billingType: secret.subscriptionType,
  })
}

function username(): string {
  return process.env.USER || os.userInfo().username
}

interface ClaudeJsonPatch {
  emailAddress?: string
  accountUuid?: string
  rateLimitTier?: string
  billingType?: string
}

function patchClaudeJson(configDir: string, patch: ClaudeJsonPatch): void {
  const file = path.join(configDir, '.claude.json')
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    // missing or unreadable — create fresh
  }
  const existing = (data.oauthAccount as Record<string, unknown> | undefined) ?? {}
  data.oauthAccount = {
    ...existing,
    ...(patch.emailAddress !== undefined ? { emailAddress: patch.emailAddress } : {}),
    ...(patch.accountUuid !== undefined ? { accountUuid: patch.accountUuid } : {}),
    ...(patch.rateLimitTier !== undefined ? { rateLimitTier: patch.rateLimitTier } : {}),
    ...(patch.billingType !== undefined ? { billingType: patch.billingType } : {}),
  }
  try {
    atomicWriteFileSync(file, JSON.stringify(data, null, 2))
    fs.chmodSync(file, 0o600)
  } catch {}
}

// ── Codex: auth.json ─────────────────────────────────────────────────────────

function writeCodexCredentials(configDir: string, secret: OpenAISecret): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const file = path.join(configDir, 'auth.json')
  atomicWriteFileSync(file, JSON.stringify(secret, null, 2))
  try { fs.chmodSync(file, 0o600) } catch {}
}

// ── Helper: kind/cliType compatibility ──────────────────────────────────────

export function canAssign(accountKind: AccountKind, cliType: CliType): boolean {
  return kindForCliType(cliType) === accountKind
}
