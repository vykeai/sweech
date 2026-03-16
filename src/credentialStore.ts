/**
 * Cross-platform credential store abstraction.
 *
 * - macOS: delegates to the system Keychain via `security` CLI
 * - Other platforms: falls back to a JSON file at ~/.sweech/tokens.json
 *
 * Also exports `computeKeychainServiceName` which centralises the
 * service-name derivation previously duplicated across liveUsage.ts
 * and subscriptions.ts.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'

// ── Interface ────────────────────────────────────────────────────────────────

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>
  set(service: string, account: string, password: string): Promise<void>
  delete(service: string, account: string): Promise<void>
}

// ── macOS Keychain ───────────────────────────────────────────────────────────

export class MacOSKeychainStore implements CredentialStore {
  async get(service: string, account: string): Promise<string | null> {
    try {
      const raw = execSync(
        `security find-generic-password -s ${escapeShellArg(service)} -a ${escapeShellArg(account)} -w`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      return raw || null
    } catch {
      return null
    }
  }

  async set(service: string, account: string, password: string): Promise<void> {
    try {
      execSync(
        `security add-generic-password -U -s ${escapeShellArg(service)} -a ${escapeShellArg(account)} -w ${escapeShellArg(password)}`,
        { stdio: 'ignore' },
      )
    } catch {
      // add-generic-password can fail if the keychain is locked; callers
      // should handle the rejected promise.
      throw new Error(`Failed to write credential for service="${service}" account="${account}" to macOS Keychain`)
    }
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      execSync(
        `security delete-generic-password -s ${escapeShellArg(service)} -a ${escapeShellArg(account)}`,
        { stdio: 'ignore' },
      )
    } catch {
      // Not found or already deleted — treat as success.
    }
  }
}

/** Escape a value for safe inclusion in a single-quoted shell argument. */
function escapeShellArg(val: string): string {
  return "'" + val.replace(/'/g, "'\\''") + "'"
}

// ── File-based fallback ──────────────────────────────────────────────────────

const TOKENS_DIR = path.join(os.homedir(), '.sweech')
const TOKENS_FILE = path.join(TOKENS_DIR, 'tokens.json')

export class FileTokenStore implements CredentialStore {
  async get(service: string, account: string): Promise<string | null> {
    const store = readTokenFile()
    return store[`${service}:${account}`] ?? null
  }

  async set(service: string, account: string, password: string): Promise<void> {
    const store = readTokenFile()
    store[`${service}:${account}`] = password
    writeTokenFile(store)
  }

  async delete(service: string, account: string): Promise<void> {
    const store = readTokenFile()
    delete store[`${service}:${account}`]
    writeTokenFile(store)
  }
}

function readTokenFile(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function writeTokenFile(store: Record<string, string>): void {
  fs.mkdirSync(TOKENS_DIR, { recursive: true })
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
  // Ensure permissions are correct even if the file already existed.
  fs.chmodSync(TOKENS_FILE, 0o600)
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Return the platform-appropriate credential store.
 *
 * - darwin  → MacOSKeychainStore (uses `security` CLI)
 * - others  → FileTokenStore     (uses ~/.sweech/tokens.json)
 */
export function getCredentialStore(): CredentialStore {
  if (process.platform === 'darwin') {
    return new MacOSKeychainStore()
  }
  return new FileTokenStore()
}

// ── Keychain service name helper ─────────────────────────────────────────────

/**
 * Compute the Keychain service name for a given Claude Code config directory.
 *
 * Matches the native binary's behaviour:
 *   - Default profile (~/.claude): "Claude Code-credentials"
 *   - Custom profile: "Claude Code-credentials-{sha256(configDir).slice(0,8)}"
 *
 * This consolidates the logic previously duplicated in liveUsage.ts and
 * subscriptions.ts.
 */
export function computeKeychainServiceName(configDir: string): string {
  const defaultDir = path.join(os.homedir(), '.claude')
  if (configDir === defaultDir) {
    return 'Claude Code-credentials'
  }
  const hash = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${hash}`
}
