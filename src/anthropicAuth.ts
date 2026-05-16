/**
 * Resolves the Anthropic OAuth client ID used for PKCE login and refresh.
 *
 * Lookup order (first hit wins):
 *   1. `oauth.anthropic.clientId` in `~/.sweech/config.json`
 *   2. `SWEECH_ANTHROPIC_CLIENT_ID` env var
 *   3. legacy `ANTHROPIC_CLIENT_ID` env var (retained for compatibility)
 *   4. built-in default (the public Claude Code client ID)
 *
 * Config schema bump: `~/.sweech/config.json` historically held a bare
 * array of profile objects. To accommodate top-level keys like `oauth`,
 * the file may now also be an object of the shape
 * `{ profiles: ProfileConfig[], oauth?: { anthropic?: { clientId?: string } } }`.
 * Both shapes are accepted on read; existing arrays continue to work
 * untouched.
 *
 * The resolved value is cached for the lifetime of the process. Call
 * `_resetAnthropicClientIdCache()` from tests to force a fresh read.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const DEFAULT_ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

let cached: string | undefined

function readConfigClientId(): string | undefined {
  try {
    const configFile = path.join(os.homedir(), '.sweech', 'config.json')
    if (!fs.existsSync(configFile)) return undefined
    const raw = fs.readFileSync(configFile, 'utf-8').trim()
    if (!raw) return undefined
    const parsed = JSON.parse(raw)
    // Legacy: bare profiles array has no top-level keys to pull from.
    if (Array.isArray(parsed)) return undefined
    if (parsed && typeof parsed === 'object') {
      const oauth = (parsed as { oauth?: { anthropic?: { clientId?: unknown } } }).oauth
      const id = oauth?.anthropic?.clientId
      if (typeof id === 'string' && id.trim().length > 0) return id.trim()
    }
    return undefined
  } catch {
    // Unreadable / malformed config — fall through to env/default rather
    // than crashing the OAuth path.
    return undefined
  }
}

/**
 * Resolve the Anthropic OAuth client ID. Cached after first call.
 */
export function getAnthropicClientId(): string {
  if (cached !== undefined) return cached
  const fromConfig = readConfigClientId()
  if (fromConfig) {
    cached = fromConfig
    return cached
  }
  const fromSweechEnv = process.env.SWEECH_ANTHROPIC_CLIENT_ID
  if (fromSweechEnv && fromSweechEnv.trim().length > 0) {
    cached = fromSweechEnv.trim()
    return cached
  }
  const fromLegacyEnv = process.env.ANTHROPIC_CLIENT_ID
  if (fromLegacyEnv && fromLegacyEnv.trim().length > 0) {
    cached = fromLegacyEnv.trim()
    return cached
  }
  cached = DEFAULT_ANTHROPIC_CLIENT_ID
  return cached
}

/**
 * Reset the module-level cache. Test-only — production code should call
 * `getAnthropicClientId()` and rely on the cache.
 */
export function _resetAnthropicClientIdCache(): void {
  cached = undefined
}
