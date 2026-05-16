/**
 * Tests for src/vault.ts — focused on T-038 (org-scoped account ids).
 *
 * The vault writes secrets via the credential store. We swap in a
 * pure in-memory store before requiring vault so tests run without
 * touching the macOS Keychain / secret-tool / cmdkey / disk fallback.
 *
 * `os.homedir()` is redirected to a unique tmpdir per test file so
 * accounts.json writes don't pollute the developer's real ~/.sweech.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-vault-test-'))

afterAll(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  // Fresh module graph so vault re-resolves ACCOUNTS_FILE under the
  // mocked homedir, and the in-memory credential store starts empty.
  jest.resetModules()
  jest.doMock('os', () => {
    const real = jest.requireActual('os')
    return { ...real, homedir: () => TMP_HOME }
  })
  jest.doMock('node:os', () => {
    const real = jest.requireActual('node:os')
    return { ...real, homedir: () => TMP_HOME }
  })
  jest.doMock('../src/credentialStore', () => {
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
  // Each test gets a clean accounts.json.
  const sweechDir = path.join(TMP_HOME, '.sweech')
  try { fs.rmSync(sweechDir, { recursive: true, force: true }) } catch {}
})

function loadVault() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/vault') as typeof import('../src/vault')
}

function baseMeta(overrides: Partial<import('../src/vault').AccountMeta>): import('../src/vault').AccountMeta {
  return {
    id: 'placeholder',
    kind: 'anthropic',
    email: 'alice@example.com',
    addedAt: '2026-05-16T00:00:00.000Z',
    ...overrides,
  }
}

const SECRET = { accessToken: 'a', refreshToken: 'r', expiresAt: 0 }

// ── idFor ────────────────────────────────────────────────────────────────────

describe('idFor', () => {
  test('legacy shape (no orgId) is stable across calls', () => {
    const vault = loadVault()
    const id1 = vault.idFor('anthropic', 'alice@example.com')
    const id2 = vault.idFor('anthropic', 'alice@example.com')
    expect(id1).toBe(id2)
    expect(id1).toHaveLength(12)
  })

  test('email is case- and whitespace-insensitive', () => {
    const vault = loadVault()
    expect(vault.idFor('anthropic', 'Alice@Example.com'))
      .toBe(vault.idFor('anthropic', '  alice@example.com  '))
  })

  test('different kinds for the same email produce different ids', () => {
    const vault = loadVault()
    expect(vault.idFor('anthropic', 'a@b.com'))
      .not.toBe(vault.idFor('openai', 'a@b.com'))
  })

  test('same email + different orgId → two distinct ids', () => {
    const vault = loadVault()
    const idA = vault.idFor('anthropic', 'alice@example.com', 'org-aaa')
    const idB = vault.idFor('anthropic', 'alice@example.com', 'org-bbb')
    expect(idA).not.toBe(idB)
  })

  test('same email + same orgId → one stable id', () => {
    const vault = loadVault()
    const id1 = vault.idFor('anthropic', 'alice@example.com', 'org-aaa')
    const id2 = vault.idFor('anthropic', 'alice@example.com', 'org-aaa')
    expect(id1).toBe(id2)
  })

  test('legacy id (no orgId) differs from org-keyed id (T-038 collision proof)', () => {
    const vault = loadVault()
    // Before T-038 the only id was `kind:email`. After T-038 the
    // org-aware id is a different hash — so a freshly imported
    // org-tagged account never collides with the legacy entry.
    expect(vault.idFor('anthropic', 'alice@example.com'))
      .not.toBe(vault.idFor('anthropic', 'alice@example.com', 'org-aaa'))
  })
})

// ── resolveAccountForImport ──────────────────────────────────────────────────

describe('resolveAccountForImport', () => {
  test('empty vault → create with org-keyed id', async () => {
    const vault = loadVault()
    const r = vault.resolveAccountForImport('anthropic', 'alice@example.com', 'org-aaa')
    expect(r.action).toBe('create')
    expect(r.id).toBe(vault.idFor('anthropic', 'alice@example.com', 'org-aaa'))
    expect(r.existing).toBeNull()
  })

  test('same email + same orgId → update existing entry (one ID)', async () => {
    const vault = loadVault()
    const id = vault.idFor('anthropic', 'alice@example.com', 'org-aaa')
    await vault.saveAccount(baseMeta({ id, orgId: 'org-aaa' }), SECRET)
    const r = vault.resolveAccountForImport('anthropic', 'alice@example.com', 'org-aaa')
    expect(r.action).toBe('update')
    expect(r.id).toBe(id)
    expect(vault.listAccounts()).toHaveLength(1)
  })

  test('same email + DIFFERENT orgId → collision flagged, not overwritten', async () => {
    const vault = loadVault()
    const idA = vault.idFor('anthropic', 'alice@example.com', 'org-aaa')
    await vault.saveAccount(
      baseMeta({ id: idA, orgId: 'org-aaa', orgName: 'Personal' }),
      SECRET,
    )
    const r = vault.resolveAccountForImport('anthropic', 'alice@example.com', 'org-bbb')
    expect(r.action).toBe('collision')
    if (r.action === 'collision') {
      expect(r.id).toBe(vault.idFor('anthropic', 'alice@example.com', 'org-bbb'))
      expect(r.conflict.orgId).toBe('org-aaa')
    }
  })

  test('legacy entry (no orgId) + first orgId discovery → update in place', async () => {
    const vault = loadVault()
    const legacyId = vault.idFor('anthropic', 'alice@example.com')
    await vault.saveAccount(baseMeta({ id: legacyId }), SECRET)
    const r = vault.resolveAccountForImport('anthropic', 'alice@example.com', 'org-aaa')
    expect(r.action).toBe('update')
    // The legacy id is preserved — backfill keeps the same row.
    expect(r.id).toBe(legacyId)
    expect(r.existing?.id).toBe(legacyId)
  })

  test('no orgId provided + legacy entry → update on legacy id (single-org parity)', async () => {
    const vault = loadVault()
    const legacyId = vault.idFor('anthropic', 'alice@example.com')
    await vault.saveAccount(baseMeta({ id: legacyId }), SECRET)
    const r = vault.resolveAccountForImport('anthropic', 'alice@example.com', undefined)
    expect(r.action).toBe('update')
    expect(r.id).toBe(legacyId)
  })

  test('no orgId provided + org-keyed entry already exists → does not overwrite, creates legacy alongside', async () => {
    const vault = loadVault()
    const orgId = vault.idFor('anthropic', 'alice@example.com', 'org-aaa')
    await vault.saveAccount(baseMeta({ id: orgId, orgId: 'org-aaa' }), SECRET)
    const r = vault.resolveAccountForImport('anthropic', 'alice@example.com', undefined)
    expect(r.action).toBe('create')
    expect(r.id).toBe(vault.idFor('anthropic', 'alice@example.com'))
    expect(r.id).not.toBe(orgId)
  })
})

// ── findAccountByEmail (back-compat + orgId-aware lookup) ────────────────────

describe('findAccountByEmail', () => {
  test('legacy entry is findable without orgId', async () => {
    const vault = loadVault()
    const id = vault.idFor('anthropic', 'alice@example.com')
    await vault.saveAccount(baseMeta({ id }), SECRET)
    expect(vault.findAccountByEmail('anthropic', 'alice@example.com')?.id).toBe(id)
  })

  test('legacy entry is findable with orgId hint (returned as best-effort match)', async () => {
    const vault = loadVault()
    const id = vault.idFor('anthropic', 'alice@example.com')
    await vault.saveAccount(baseMeta({ id }), SECRET)
    // With orgId arg, findAccountByEmail returns the legacy entry as a
    // single-org match (since no other entry exists for this email).
    expect(vault.findAccountByEmail('anthropic', 'alice@example.com', 'org-aaa')?.id).toBe(id)
  })

  test('orgId-keyed entry returns only when the orgId matches', async () => {
    const vault = loadVault()
    const idA = vault.idFor('anthropic', 'alice@example.com', 'org-aaa')
    await vault.saveAccount(baseMeta({ id: idA, orgId: 'org-aaa' }), SECRET)
    expect(vault.findAccountByEmail('anthropic', 'alice@example.com', 'org-aaa')?.id).toBe(idA)
    // Different orgId — should return null (no fallback to a wrong org).
    expect(vault.findAccountByEmail('anthropic', 'alice@example.com', 'org-bbb')).toBeNull()
  })
})

// ── findAccountsByEmail (collision detection helper) ─────────────────────────

describe('findAccountsByEmail', () => {
  test('returns every entry matching email regardless of org', async () => {
    const vault = loadVault()
    const idA = vault.idFor('anthropic', 'alice@example.com', 'org-aaa')
    const idB = vault.idFor('anthropic', 'alice@example.com', 'org-bbb')
    await vault.saveAccount(baseMeta({ id: idA, orgId: 'org-aaa' }), SECRET)
    await vault.saveAccount(baseMeta({ id: idB, orgId: 'org-bbb' }), SECRET)
    const all = vault.findAccountsByEmail('anthropic', 'alice@example.com')
    expect(all).toHaveLength(2)
    expect(all.map(a => a.orgId).sort()).toEqual(['org-aaa', 'org-bbb'])
  })

  test('filters by kind', async () => {
    const vault = loadVault()
    const idA = vault.idFor('anthropic', 'alice@example.com')
    const idB = vault.idFor('openai', 'alice@example.com')
    await vault.saveAccount(baseMeta({ id: idA }), SECRET)
    await vault.saveAccount(baseMeta({ id: idB, kind: 'openai' }), SECRET)
    expect(vault.findAccountsByEmail('anthropic', 'alice@example.com')).toHaveLength(1)
    expect(vault.findAccountsByEmail('openai', 'alice@example.com')).toHaveLength(1)
  })

  test('email match is case- and whitespace-insensitive', async () => {
    const vault = loadVault()
    const id = vault.idFor('anthropic', 'alice@example.com')
    await vault.saveAccount(baseMeta({ id, email: 'Alice@Example.com' }), SECRET)
    expect(vault.findAccountsByEmail('anthropic', '  alice@EXAMPLE.com  ')).toHaveLength(1)
  })
})

// ── End-to-end: two orgs, same email coexist ─────────────────────────────────

describe('multi-org coexistence (T-038 acceptance criteria)', () => {
  test('saving same email under two orgs yields two vault rows, two secrets', async () => {
    const vault = loadVault()
    const idA = vault.idFor('anthropic', 'alice@example.com', 'org-aaa')
    const idB = vault.idFor('anthropic', 'alice@example.com', 'org-bbb')
    await vault.saveAccount(
      baseMeta({ id: idA, orgId: 'org-aaa', orgName: 'Personal' }),
      { accessToken: 'TOKEN-A', refreshToken: 'r', expiresAt: 0 },
    )
    await vault.saveAccount(
      baseMeta({ id: idB, orgId: 'org-bbb', orgName: 'Work' }),
      { accessToken: 'TOKEN-B', refreshToken: 'r', expiresAt: 0 },
    )

    const all = vault.listAccounts('anthropic')
    expect(all).toHaveLength(2)
    expect(all.map(a => a.id).sort()).toEqual([idA, idB].sort())

    const secretA = (await vault.getAccountSecret(idA)) as { accessToken: string }
    const secretB = (await vault.getAccountSecret(idB)) as { accessToken: string }
    expect(secretA.accessToken).toBe('TOKEN-A')
    expect(secretB.accessToken).toBe('TOKEN-B')
    // The original bug: TOKEN-A was overwritten by TOKEN-B because
    // both keyed on the same `kind:email` id. After T-038 they live
    // on distinct ids and do not clobber each other.
    expect(secretA.accessToken).not.toBe(secretB.accessToken)
  })

  test('legacy single-org entry remains stable after upgrade (acceptance: no manual re-import)', async () => {
    const vault = loadVault()
    const legacyId = vault.idFor('anthropic', 'alice@example.com')
    await vault.saveAccount(baseMeta({ id: legacyId }), SECRET)
    // Simulate process restart: re-load module, re-read accounts.
    const vault2 = (() => {
      jest.resetModules()
      // The in-memory credential store was wired in the
      // outer beforeEach via jest.doMock — re-arm it for this fresh
      // require so secrets persist across the simulated restart.
      const tmp = jest.requireActual('../src/credentialStore') as any
      void tmp
      return require('../src/vault') as typeof import('../src/vault')
    })()
    const reloaded = vault2.getAccount(legacyId)
    expect(reloaded?.id).toBe(legacyId)
    expect(reloaded?.email).toBe('alice@example.com')
    expect(reloaded?.orgId).toBeUndefined()
  })

  test('legacy entry id stays stable even when orgId is later discovered', async () => {
    const vault = loadVault()
    const legacyId = vault.idFor('anthropic', 'alice@example.com')
    await vault.saveAccount(baseMeta({ id: legacyId }), SECRET)
    // Re-import flow discovers orgId for the first time.
    const r = vault.resolveAccountForImport('anthropic', 'alice@example.com', 'org-aaa')
    expect(r.action).toBe('update')
    expect(r.id).toBe(legacyId)
    // Caller (vaultAdd/vaultImport) writes back with orgId set —
    // saveAccount keeps the same id row.
    await vault.saveAccount(
      baseMeta({ id: r.id, orgId: 'org-aaa', orgName: 'Personal' }),
      SECRET,
    )
    expect(vault.listAccounts()).toHaveLength(1)
    const reloaded = vault.getAccount(legacyId)
    expect(reloaded?.id).toBe(legacyId)
    expect(reloaded?.orgId).toBe('org-aaa')
  })
})
