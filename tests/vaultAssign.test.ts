/**
 * Tests for src/vaultAssign.ts — focused on T-051 (CLI binary preflight).
 *
 * The preflight refuses to mount credentials when `which <binary>` fails to
 * resolve the underlying CLI command. `--force` (an opts.force flag at the
 * function level, plumbed through cli.ts) bypasses the check.
 *
 * We mock:
 *   - `node:child_process` so `which` resolution is controllable per test
 *     without touching the host PATH
 *   - `./platform` so the Linux code path runs regardless of host OS (avoids
 *     the macOS `security` keychain call)
 *   - `./credentialStore` with an in-memory store (mirrors tests/vault.test.ts)
 *   - `os.homedir()` → a fresh tmpdir so accounts.json / .credentials.json
 *     writes don't pollute the developer's real ~/.sweech
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-vaultassign-test-'))

afterAll(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch {}
})

// Controllable per-test: which binaries are "on PATH". The mock checks
// against this set; missing → throws (matches real subprocess behaviour
// on a non-zero exit from `which`).
const onPath = new Set<string>()

beforeEach(() => {
  jest.resetModules()
  onPath.clear()

  jest.doMock('os', () => {
    const real = jest.requireActual('os')
    return { ...real, homedir: () => TMP_HOME }
  })
  jest.doMock('node:os', () => {
    const real = jest.requireActual('node:os')
    return { ...real, homedir: () => TMP_HOME }
  })

  jest.doMock('node:child_process', () => {
    const real = jest.requireActual('node:child_process')
    return {
      ...real,
      execFileSync: (cmd: string, args: readonly string[] | undefined) => {
        if ((cmd === 'which' || cmd === 'where') && args && args.length > 0) {
          if (!onPath.has(args[0])) {
            throw new Error(`mock-which: ${args[0]} not found`)
          }
          return Buffer.from(`/usr/local/bin/${args[0]}\n`)
        }
        // Anything else (e.g. macOS `security`) shouldn't be reached because
        // we mock isMacOS()→false below — but be safe.
        return Buffer.from('')
      },
    }
  })

  // Force the non-macOS credential-store branch so the test is portable
  // (CI runs darwin and linux; we don't want `security` calls).
  jest.doMock('./../src/platform', () => {
    const real = jest.requireActual('../src/platform')
    return { ...real, isMacOS: () => false }
  })

  jest.doMock('./../src/credentialStore', () => {
    const memory = new Map<string, string>()
    const key = (service: string, account: string) => `${service}::${account}`
    const store = {
      async get(service: string, account: string): Promise<string | null> {
        return memory.get(key(service, account)) ?? null
      },
      async set(service: string, account: string, value: string): Promise<void> {
        memory.set(key(service, account), value)
      },
      async delete(service: string, account: string): Promise<void> {
        memory.delete(key(service, account))
      },
    }
    return {
      getCredentialStore: () => store,
      readCredential: async (s: string, a: string) => store.get(s, a),
      computeKeychainServiceName: (dir: string) => `service-${path.basename(dir)}`,
      MacOSKeychainStore: class {},
      LinuxSecretToolStore: class {},
      WindowsCmdkeyStore: class {},
      FileTokenStore: class {},
      isSecretToolAvailable: () => false,
      isCmdkeyAvailable: () => false,
    }
  })

  // Wipe last run's accounts.json + workspace dirs.
  try { fs.rmSync(path.join(TMP_HOME, '.sweech'), { recursive: true, force: true }) } catch {}
  try { fs.rmSync(path.join(TMP_HOME, '.claude'), { recursive: true, force: true }) } catch {}
  try { fs.rmSync(path.join(TMP_HOME, '.codex'), { recursive: true, force: true }) } catch {}
})

function loadVault(): typeof import('../src/vault') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/vault')
}
function loadVaultAssign(): typeof import('../src/vaultAssign') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/vaultAssign')
}

const ANTHROPIC_SECRET = {
  accessToken: 'access-tok',
  refreshToken: 'refresh-tok',
  expiresAt: Date.now() + 60_000,
  subscriptionType: 'pro',
}
const OPENAI_SECRET = {
  accessToken: 'oa-access',
  refreshToken: 'oa-refresh',
  expiresAt: Date.now() + 60_000,
  scopes: ['profile'],
}

async function seedAnthropic(): Promise<{ id: string; email: string }> {
  const vault = loadVault()
  const email = 'alice@example.com'
  const id = vault.idFor('anthropic', email)
  await vault.saveAccount(
    {
      id,
      kind: 'anthropic',
      email,
      addedAt: '2026-05-16T00:00:00.000Z',
    },
    ANTHROPIC_SECRET,
  )
  return { id, email }
}

async function seedOpenAI(): Promise<{ id: string; email: string }> {
  const vault = loadVault()
  const email = 'carol@example.com'
  const id = vault.idFor('openai', email)
  await vault.saveAccount(
    {
      id,
      kind: 'openai',
      email,
      addedAt: '2026-05-16T00:00:00.000Z',
    },
    OPENAI_SECRET,
  )
  return { id, email }
}

function claudeWs() {
  return {
    commandName: 'claude',
    cliType: 'claude' as const,
    configDir: path.join(TMP_HOME, '.claude'),
  }
}
function codexWs() {
  return {
    commandName: 'codex',
    cliType: 'codex' as const,
    configDir: path.join(TMP_HOME, '.codex'),
  }
}

// ── happy path ───────────────────────────────────────────────────────────────

describe('assignAccountToWorkspace — preflight pass', () => {
  test('claude workspace + claude binary on PATH → mount succeeds', async () => {
    onPath.add('claude')
    const { id, email } = await seedAnthropic()
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(claudeWs(), id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.email).toBe(email)
      expect(result.binary).toBe('claude')
      expect(result.binaryOnPath).toBe(true)
    }
    // Side effect: credentials file actually written.
    expect(fs.existsSync(path.join(TMP_HOME, '.claude', '.credentials.json'))).toBe(true)
  })

  test('codex workspace + codex binary on PATH → mount succeeds', async () => {
    onPath.add('codex')
    const { id } = await seedOpenAI()
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(codexWs(), id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.binary).toBe('codex')
      expect(result.binaryOnPath).toBe(true)
    }
    expect(fs.existsSync(path.join(TMP_HOME, '.codex', 'auth.json'))).toBe(true)
  })
})

// ── preflight fail ───────────────────────────────────────────────────────────

describe('assignAccountToWorkspace — preflight fail', () => {
  test('claude binary missing → refuses, returns install hint with binary name', async () => {
    // onPath intentionally empty
    const { id } = await seedAnthropic()
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(claudeWs(), id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/claude/)
      expect(result.reason).toMatch(/not found on PATH/i)
      expect(result.reason).toMatch(/Install:/)
      // Grounded install hint — README's canonical npm command for claude.
      expect(result.reason).toMatch(/npm install -g @anthropic\/claude-code/)
    }
    // Side effect: no credentials file written.
    expect(fs.existsSync(path.join(TMP_HOME, '.claude', '.credentials.json'))).toBe(false)
  })

  test('codex binary missing → refuses with codex-specific install hint', async () => {
    const { id } = await seedOpenAI()
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(codexWs(), id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/codex/)
      expect(result.reason).toMatch(/not found on PATH/i)
      // Grounded — github.com/openai/codex is the install URL in src/clis.ts.
      expect(result.reason).toMatch(/github\.com\/openai\/codex/)
    }
    expect(fs.existsSync(path.join(TMP_HOME, '.codex', 'auth.json'))).toBe(false)
  })

  test('refusal happens BEFORE keychain/credentials.json writes (no partial state)', async () => {
    const { id } = await seedAnthropic()
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(claudeWs(), id)
    expect(result.ok).toBe(false)
    // The config dir should not even exist — preflight bails before mkdir.
    expect(fs.existsSync(path.join(TMP_HOME, '.claude'))).toBe(false)
  })
})

// ── force bypass ─────────────────────────────────────────────────────────────

describe('assignAccountToWorkspace — force bypass', () => {
  test('binary missing + force=true → mount proceeds, binaryOnPath=false', async () => {
    const { id, email } = await seedAnthropic()
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(
      claudeWs(),
      id,
      { force: true },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.email).toBe(email)
      expect(result.binary).toBe('claude')
      // Critical: surfaced as false so the CLI layer can print the WARN.
      expect(result.binaryOnPath).toBe(false)
    }
    expect(fs.existsSync(path.join(TMP_HOME, '.claude', '.credentials.json'))).toBe(true)
  })

  test('binary present + force=true → still proceeds, binaryOnPath=true', async () => {
    onPath.add('claude')
    const { id } = await seedAnthropic()
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(
      claudeWs(),
      id,
      { force: true },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.binaryOnPath).toBe(true)
  })

  test('force=false (explicit) behaves like default — refuse when missing', async () => {
    const { id } = await seedAnthropic()
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(
      claudeWs(),
      id,
      { force: false },
    )
    expect(result.ok).toBe(false)
  })
})

// ── pre-existing failure paths still fire (preflight doesn't mask them) ──────

describe('assignAccountToWorkspace — pre-existing error paths intact', () => {
  test('missing account → returns account-not-found (preflight not consulted)', async () => {
    // No seeding. Binary not on PATH either — but the existing
    // account-not-found check must fire FIRST so the failure mode is
    // informative.
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(
      claudeWs(),
      'nonexistent-id',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/not found in vault/)
    }
  })

  test('incompatible kind → returns kind-mismatch (preflight not consulted)', async () => {
    onPath.add('claude') // even with binary present, kind mismatch wins
    const { id } = await seedOpenAI()
    const vaultAssign = loadVaultAssign()
    const result = await vaultAssign.assignAccountToWorkspace(claudeWs(), id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/Incompatible/)
    }
  })
})
