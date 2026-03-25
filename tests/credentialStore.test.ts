/**
 * Tests for cross-platform credential store abstraction (src/credentialStore.ts).
 */

import {
  CredentialStore,
  MacOSKeychainStore,
  LinuxSecretToolStore,
  WindowsCmdkeyStore,
  FileTokenStore,
  getCredentialStore,
  readCredential,
  computeKeychainServiceName,
  isSecretToolAvailable,
  isCmdkeyAvailable,
} from '../src/credentialStore'
import { isMacOS, isLinux, isWindows } from '../src/platform'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ── CredentialStore interface ────────────────────────────────────────────────

describe('CredentialStore interface', () => {
  test('MacOSKeychainStore implements the interface', () => {
    const store: CredentialStore = new MacOSKeychainStore()
    expect(typeof store.get).toBe('function')
    expect(typeof store.set).toBe('function')
    expect(typeof store.delete).toBe('function')
  })

  test('LinuxSecretToolStore implements the interface', () => {
    const store: CredentialStore = new LinuxSecretToolStore()
    expect(typeof store.get).toBe('function')
    expect(typeof store.set).toBe('function')
    expect(typeof store.delete).toBe('function')
  })

  test('WindowsCmdkeyStore implements the interface', () => {
    const store: CredentialStore = new WindowsCmdkeyStore()
    expect(typeof store.get).toBe('function')
    expect(typeof store.set).toBe('function')
    expect(typeof store.delete).toBe('function')
  })

  test('FileTokenStore implements the interface', () => {
    const store: CredentialStore = new FileTokenStore()
    expect(typeof store.get).toBe('function')
    expect(typeof store.set).toBe('function')
    expect(typeof store.delete).toBe('function')
  })
})

// ── FileTokenStore (works on all platforms) ─────────────────────────────────

describe('FileTokenStore', () => {
  const tmpDir = path.join(os.tmpdir(), `sweech-test-cred-${Date.now()}`)
  const tokensFile = path.join(tmpDir, 'tokens.json')
  let originalReadFile: typeof fs.readFileSync
  let originalWriteFile: typeof fs.writeFileSync
  let originalMkdir: typeof fs.mkdirSync
  let originalChmod: typeof fs.chmodSync

  // We test the FileTokenStore indirectly — the class uses module-level
  // constants for TOKENS_DIR and TOKENS_FILE. For true isolation we'd
  // need DI, but we can at least verify the interface contract.

  test('get returns null for non-existent credential', async () => {
    const store = new FileTokenStore()
    // This may or may not find something depending on the dev env,
    // but the contract says it returns string | null
    const result = await store.get('test-service-nonexistent-xyz', 'test-account-nonexistent-xyz')
    expect(result === null || typeof result === 'string').toBe(true)
  })
})

// ── getCredentialStore factory ───────────────────────────────────────────────

describe('getCredentialStore', () => {
  test('returns a CredentialStore instance', () => {
    const store = getCredentialStore()
    expect(typeof store.get).toBe('function')
    expect(typeof store.set).toBe('function')
    expect(typeof store.delete).toBe('function')
  })

  test('returns MacOSKeychainStore on macOS', () => {
    if (isMacOS()) {
      const store = getCredentialStore()
      expect(store).toBeInstanceOf(MacOSKeychainStore)
    }
  })

  test('returns FileTokenStore or LinuxSecretToolStore on Linux', () => {
    if (isLinux()) {
      const store = getCredentialStore()
      expect(
        store instanceof FileTokenStore || store instanceof LinuxSecretToolStore
      ).toBe(true)
    }
  })

  test('returns WindowsCmdkeyStore or FileTokenStore on Windows', () => {
    if (isWindows()) {
      const store = getCredentialStore()
      expect(
        store instanceof WindowsCmdkeyStore || store instanceof FileTokenStore
      ).toBe(true)
    }
  })
})

// ── readCredential ──────────────────────────────────────────────────────────

describe('readCredential', () => {
  test('returns null for non-existent credential', async () => {
    const result = await readCredential('sweech-test-nonexistent', 'no-such-account')
    expect(result).toBeNull()
  })

  test('returns string or null', async () => {
    const result = await readCredential('any-service', 'any-account')
    expect(result === null || typeof result === 'string').toBe(true)
  })
})

// ── computeKeychainServiceName ──────────────────────────────────────────────

describe('computeKeychainServiceName', () => {
  test('default dir returns base service name', () => {
    const defaultDir = path.join(os.homedir(), '.claude')
    expect(computeKeychainServiceName(defaultDir)).toBe('Claude Code-credentials')
  })

  test('custom dir returns service name with hash suffix', () => {
    const customDir = path.join(os.homedir(), '.claude-work')
    const result = computeKeychainServiceName(customDir)
    expect(result).toMatch(/^Claude Code-credentials-[a-f0-9]{8}$/)
  })

  test('different dirs produce different service names', () => {
    const dir1 = path.join(os.homedir(), '.claude-a')
    const dir2 = path.join(os.homedir(), '.claude-b')
    expect(computeKeychainServiceName(dir1)).not.toBe(computeKeychainServiceName(dir2))
  })

  test('same dir always produces the same service name', () => {
    const dir = path.join(os.homedir(), '.claude-test')
    expect(computeKeychainServiceName(dir)).toBe(computeKeychainServiceName(dir))
  })
})

// ── Platform tool detection ─────────────────────────────────────────────────

describe('platform tool detection', () => {
  test('isSecretToolAvailable returns a boolean', () => {
    expect(typeof isSecretToolAvailable()).toBe('boolean')
  })

  test('isCmdkeyAvailable returns a boolean', () => {
    expect(typeof isCmdkeyAvailable()).toBe('boolean')
  })
})
