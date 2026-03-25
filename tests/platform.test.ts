/**
 * Tests for platform detection helpers (src/platform.ts).
 */

import { isMacOS, isLinux, isWindows, platformName, sweechConfigDir, credentialsDir, launchAgentsDir, hasKeychain, hasSecretTool, hasLaunchd } from '../src/platform'
import * as path from 'path'
import * as os from 'os'

// ── Platform detection ───────────────────────────────────────────────────────

describe('platform detection', () => {
  test('exactly one of isMacOS/isLinux/isWindows is true (or none on exotic platforms)', () => {
    const checks = [isMacOS(), isLinux(), isWindows()]
    const trueCount = checks.filter(Boolean).length
    // On any standard platform exactly one is true; on exotic it may be zero
    expect(trueCount).toBeLessThanOrEqual(1)
  })

  test('isMacOS returns boolean', () => {
    expect(typeof isMacOS()).toBe('boolean')
  })

  test('isLinux returns boolean', () => {
    expect(typeof isLinux()).toBe('boolean')
  })

  test('isWindows returns boolean', () => {
    expect(typeof isWindows()).toBe('boolean')
  })

  test('platformName returns a non-empty string', () => {
    const name = platformName()
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
  })

  test('platformName matches current platform', () => {
    const name = platformName()
    if (process.platform === 'darwin') expect(name).toBe('macOS')
    if (process.platform === 'linux') expect(name).toBe('Linux')
    if (process.platform === 'win32') expect(name).toBe('Windows')
  })
})

// ── Platform-specific paths ──────────────────────────────────────────────────

describe('platform paths', () => {
  test('sweechConfigDir uses path.join', () => {
    const dir = sweechConfigDir()
    expect(dir).toBe(path.join(os.homedir(), '.sweech'))
  })

  test('credentialsDir is inside sweechConfigDir', () => {
    const dir = credentialsDir()
    expect(dir).toBe(path.join(sweechConfigDir(), 'credentials'))
  })

  test('launchAgentsDir is undefined on non-macOS', () => {
    if (process.platform !== 'darwin') {
      expect(launchAgentsDir()).toBeUndefined()
    }
  })

  test('launchAgentsDir returns a path on macOS', () => {
    if (process.platform === 'darwin') {
      const dir = launchAgentsDir()
      expect(dir).toBeDefined()
      expect(dir).toContain('LaunchAgents')
    }
  })
})

// ── Feature availability ─────────────────────────────────────────────────────

describe('feature availability', () => {
  test('hasKeychain matches isMacOS', () => {
    expect(hasKeychain()).toBe(isMacOS())
  })

  test('hasSecretTool matches isLinux', () => {
    expect(hasSecretTool()).toBe(isLinux())
  })

  test('hasLaunchd matches isMacOS', () => {
    expect(hasLaunchd()).toBe(isMacOS())
  })
})
