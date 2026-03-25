/**
 * Cross-platform detection helpers.
 *
 * Provides `isMacOS()`, `isLinux()`, `isWindows()` and platform-specific
 * path constants so the rest of the codebase can gate macOS-only features
 * (Keychain, launchd) behind runtime checks.
 */

import * as path from 'path'
import * as os from 'os'

// ── Platform detection ───────────────────────────────────────────────────────

export function isMacOS(): boolean {
  return process.platform === 'darwin'
}

export function isLinux(): boolean {
  return process.platform === 'linux'
}

export function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * Human-readable platform name for display purposes.
 */
export function platformName(): string {
  if (isMacOS()) return 'macOS'
  if (isLinux()) return 'Linux'
  if (isWindows()) return 'Windows'
  return process.platform
}

// ── Platform-specific paths ──────────────────────────────────────────────────

/**
 * Base sweech config directory.
 *
 * All platforms: ~/.sweech
 *   - macOS:   /Users/<user>/.sweech
 *   - Linux:   /home/<user>/.sweech
 *   - Windows: C:\Users\<user>\.sweech
 */
export function sweechConfigDir(): string {
  return path.join(os.homedir(), '.sweech')
}

/**
 * Directory for file-based credential fallback.
 *
 * All platforms: ~/.sweech/credentials/
 */
export function credentialsDir(): string {
  return path.join(sweechConfigDir(), 'credentials')
}

/**
 * The LaunchAgents plist directory (macOS only).
 * Returns undefined on non-macOS platforms.
 */
export function launchAgentsDir(): string | undefined {
  if (!isMacOS()) return undefined
  return path.join(os.homedir(), 'Library', 'LaunchAgents')
}

// ── Feature availability ─────────────────────────────────────────────────────

/**
 * Whether the native macOS Keychain is available.
 */
export function hasKeychain(): boolean {
  return isMacOS()
}

/**
 * Whether libsecret (secret-tool) may be available.
 */
export function hasSecretTool(): boolean {
  return isLinux()
}

/**
 * Whether launchd is available for background services.
 */
export function hasLaunchd(): boolean {
  return isMacOS()
}
