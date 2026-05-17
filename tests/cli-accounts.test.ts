/**
 * Tests for the wave-6 `sweech accounts` surface (T-072):
 *   - `accounts list` filters (kind / provider / json shape)
 *   - `accounts add --kind apikey` end-to-end happy path
 *
 * The CLI command in src/cli.ts mixes I/O with logic. We test the pure
 * kernel directly:
 *   - `accountsList` (filterAccountsForList, sortAccountsForList, etc.)
 *   - `vaultAddApiKey.addApiKeyAccount`
 *
 * Vault + credential store are mocked with the same in-memory pattern
 * used by tests/vault.test.ts and tests/providerModel.test.ts, so the
 * full add → list flow can run end-to-end without touching the real
 * keychain or homedir.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-cli-accounts-test-'))

// In-memory credential store + the original env so we can restore it
// between tests.
let memoryStore: Map<string, string> = new Map()
const ORIGINAL_ENV = { ...process.env }

afterAll(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  // Fresh module graph so vault re-resolves under the mocked homedir,
  // and the in-memory credential store starts empty.
  jest.resetModules()
  memoryStore = new Map()
  process.env = { ...ORIGINAL_ENV }

  jest.doMock('os', () => {
    const real = jest.requireActual('os')
    return { ...real, homedir: () => TMP_HOME }
  })
  jest.doMock('node:os', () => {
    const real = jest.requireActual('node:os')
    return { ...real, homedir: () => TMP_HOME }
  })
  jest.doMock('../src/credentialStore', () => {
    const key = (service: string, account: string) => `${service}::${account}`
    const store = {
      async get(service: string, account: string): Promise<string | null> {
        return memoryStore.get(key(service, account)) ?? null
      },
      async set(service: string, account: string, value: string): Promise<void> {
        memoryStore.set(key(service, account), value)
      },
      async delete(service: string, account: string): Promise<void> {
        memoryStore.delete(key(service, account))
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

  // Each test gets a clean ~/.sweech.
  const sweechDir = path.join(TMP_HOME, '.sweech')
  try { fs.rmSync(sweechDir, { recursive: true, force: true }) } catch {}
})

// ── Fixtures ─────────────────────────────────────────────────────────────────

function writeAccountsFile(data: unknown): void {
  const sweechDir = path.join(TMP_HOME, '.sweech')
  fs.mkdirSync(sweechDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(sweechDir, 'accounts.json'), JSON.stringify(data, null, 2))
}

function loadAccountsList() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/accountsList') as typeof import('../src/accountsList')
}

function loadVault() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/vault') as typeof import('../src/vault')
}

function loadVaultAddApiKey() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/vaultAddApiKey') as typeof import('../src/vaultAddApiKey')
}

/**
 * A vault state covering every kind: OAuth (anthropic + openai),
 * API-key (kimi, dashscope, glm), and local (ollama). The on-disk
 * v2 shape mirrors what `saveAccountsV2()` emits.
 */
function seedMixedVault(): void {
  writeAccountsFile({
    schemaVersion: 2,
    accounts: [
      {
        kind: 'oauth',
        provider: 'anthropic',
        accountKind: 'anthropic',
        id: 'anth0001',
        email: 'alice@example.com',
        plan: 'Max 20x',
        addedAt: '2026-05-01T00:00:00.000Z',
        status: 'ok',
        refreshTokenRef: { service: 'sweech-vault-anthropic-anth0001', account: 'sweech-vault' },
      },
      {
        kind: 'oauth',
        provider: 'openai',
        accountKind: 'openai',
        id: 'oai00001',
        email: 'bob@example.com',
        plan: 'Pro',
        addedAt: '2026-05-02T00:00:00.000Z',
        status: 'ok',
        refreshTokenRef: { service: 'sweech-vault-openai-oai00001', account: 'sweech-vault' },
      },
      {
        kind: 'apikey',
        provider: 'kimi',
        id: 'kimi0001',
        label: 'kimi-personal',
        addedAt: '2026-05-03T00:00:00.000Z',
        keyRef: { service: 'sweech-api-key', account: 'kimi0001' },
      },
      {
        kind: 'apikey',
        provider: 'dashscope',
        id: 'ali00001',
        label: 'alibaba-prod',
        addedAt: '2026-05-04T00:00:00.000Z',
        keyRef: { service: 'sweech-api-key', account: 'ali00001' },
      },
      {
        kind: 'apikey',
        provider: 'glm',
        id: 'glm00001',
        label: 'glm-work',
        addedAt: '2026-05-05T00:00:00.000Z',
        keyRef: { service: 'sweech-api-key', account: 'glm00001' },
      },
      {
        kind: 'none',
        provider: 'local-ollama',
        id: 'oll00001',
        label: 'ollama-localhost',
        addedAt: '2026-05-06T00:00:00.000Z',
      },
    ],
  })
}

// ── accounts list — filter / sort kernel ─────────────────────────────────────

describe('filterAccountsForList', () => {
  test('default (no filters) returns every kind', () => {
    seedMixedVault()
    const vault = loadVault()
    const helpers = loadAccountsList()
    const accounts = vault.listAccountsV2()
    const out = helpers.filterAccountsForList(accounts)
    expect(out).toHaveLength(6)
    expect(new Set(out.map(a => a.kind))).toEqual(new Set(['oauth', 'apikey', 'none']))
  })

  test('--kind oauth filters to OAuth only', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    const out = helpers.filterAccountsForList(accounts, { kind: 'oauth' })
    expect(out).toHaveLength(2)
    expect(out.every(a => a.kind === 'oauth')).toBe(true)
  })

  test('--kind apikey filters to API-key only', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    const out = helpers.filterAccountsForList(accounts, { kind: 'apikey' })
    expect(out).toHaveLength(3)
    expect(out.every(a => a.kind === 'apikey')).toBe(true)
  })

  test('--kind local maps to the on-disk "none" discriminator', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    const out = helpers.filterAccountsForList(accounts, { kind: 'local' })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('none')
    expect(out[0].provider).toBe('local-ollama')
  })

  test('--kind all is identical to omitting the filter', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    expect(helpers.filterAccountsForList(accounts, { kind: 'all' }))
      .toEqual(helpers.filterAccountsForList(accounts))
  })

  test('--provider filter narrows by exact provider id', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    const out = helpers.filterAccountsForList(accounts, { provider: 'dashscope' })
    expect(out).toHaveLength(1)
    expect(out[0].provider).toBe('dashscope')
    if (out[0].kind === 'apikey') expect(out[0].label).toBe('alibaba-prod')
  })

  test('--provider with no matches returns empty', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    expect(helpers.filterAccountsForList(accounts, { provider: 'nonsense' })).toEqual([])
  })

  test('--kind apikey + --provider stack', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    const out = helpers.filterAccountsForList(accounts, { kind: 'apikey', provider: 'kimi' })
    expect(out).toHaveLength(1)
    expect(out[0].provider).toBe('kimi')
  })

  test('--kind oauth with apikey --provider returns empty (no overlap)', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    const out = helpers.filterAccountsForList(accounts, { kind: 'oauth', provider: 'kimi' })
    expect(out).toEqual([])
  })
})

describe('sortAccountsForList', () => {
  test('orders oauth → apikey → none, then provider, then email/label', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    const sorted = helpers.sortAccountsForList(accounts)
    expect(sorted.map(a => `${a.kind}/${a.provider}`)).toEqual([
      'oauth/anthropic',
      'oauth/openai',
      'apikey/dashscope',
      'apikey/glm',
      'apikey/kimi',
      'none/local-ollama',
    ])
  })
})

describe('normalizeKindFilter', () => {
  test('default → all', () => {
    const { normalizeKindFilter } = loadAccountsList()
    expect(normalizeKindFilter(undefined)).toBe('all')
    expect(normalizeKindFilter('')).toBe('all')
  })

  test('accepts canonical tokens', () => {
    const { normalizeKindFilter } = loadAccountsList()
    expect(normalizeKindFilter('oauth')).toBe('oauth')
    expect(normalizeKindFilter('apikey')).toBe('apikey')
    expect(normalizeKindFilter('local')).toBe('local')
    expect(normalizeKindFilter('all')).toBe('all')
  })

  test('unknown tokens fall back to all (graceful CLI degradation)', () => {
    const { normalizeKindFilter } = loadAccountsList()
    expect(normalizeKindFilter('subscription')).toBe('all')
    expect(normalizeKindFilter('bogus')).toBe('all')
  })
})

describe('buildAccountsListJson', () => {
  test('emits the wave-6 JSON shape', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    const json = helpers.buildAccountsListJson(helpers.sortAccountsForList(accounts))
    expect(json.schemaVersion).toBe(1)
    expect(json.accounts).toHaveLength(6)
    // Round-trips through JSON.stringify cleanly.
    const parsed = JSON.parse(JSON.stringify(json)) as typeof json
    expect(parsed).toEqual(json)
  })

  test('preserves discriminator + keyRef for apikey rows', () => {
    seedMixedVault()
    const helpers = loadAccountsList()
    const accounts = loadVault().listAccountsV2()
    const filtered = helpers.filterAccountsForList(accounts, { kind: 'apikey' })
    const json = helpers.buildAccountsListJson(filtered)
    for (const a of json.accounts) {
      expect(a.kind).toBe('apikey')
      if (a.kind === 'apikey') {
        expect(a.keyRef.service).toBe('sweech-api-key')
        expect(a.keyRef.account).toBe(a.id)
      }
    }
  })
})

// ── accounts add --kind apikey ──────────────────────────────────────────────

describe('addApiKeyAccount', () => {
  test('happy path: env var → vault row + keychain entry', async () => {
    const { addApiKeyAccount } = loadVaultAddApiKey()
    process.env.KIMI_API_KEY = 'sk-kimi-secret-value'

    const result = await addApiKeyAccount({
      provider: 'kimi',
      label: 'kimi-personal',
      keySource: { type: 'env', envVar: 'KIMI_API_KEY' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.account.kind).toBe('apikey')
    expect(result.account.provider).toBe('kimi')
    expect(result.account.label).toBe('kimi-personal')
    expect(result.account.keyRef.service).toBe('sweech-api-key')
    expect(result.account.keyRef.account).toBe(result.account.id)
    expect(result.alreadyExisted).toBe(false)

    // Vault file holds the new row.
    const vault = loadVault()
    const all = vault.listAccountsV2()
    expect(all.some(a => a.kind === 'apikey' && a.id === result.account.id)).toBe(true)

    // Keychain has the secret under the new (id-based) account name.
    expect(memoryStore.get(`sweech-api-key::${result.account.id}`)).toBe('sk-kimi-secret-value')
  })

  test('literal key source — used by tests + the interactive prompt fallback', async () => {
    const { addApiKeyAccount } = loadVaultAddApiKey()
    const result = await addApiKeyAccount({
      provider: 'glm',
      label: 'glm-prod',
      keySource: { type: 'literal', value: 'glm-real-key-12345' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(memoryStore.get(`sweech-api-key::${result.account.id}`)).toBe('glm-real-key-12345')
  })

  test('rejects unknown provider', async () => {
    const { addApiKeyAccount } = loadVaultAddApiKey()
    const result = await addApiKeyAccount({
      provider: 'not-a-real-provider',
      keySource: { type: 'literal', value: 'whatever' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/unknown provider/)
  })

  test('rejects local-kind providers (no api key required)', async () => {
    const { addApiKeyAccount } = loadVaultAddApiKey()
    const result = await addApiKeyAccount({
      provider: 'local-ollama',
      keySource: { type: 'literal', value: 'irrelevant' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/local/i)
  })

  test('missing env var produces an actionable error', async () => {
    const { addApiKeyAccount } = loadVaultAddApiKey()
    delete process.env.SOME_MISSING_ENV
    const result = await addApiKeyAccount({
      provider: 'kimi',
      keySource: { type: 'env', envVar: 'SOME_MISSING_ENV' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/SOME_MISSING_ENV/)
  })

  test('empty env var triggers promptForKey fallback when provided', async () => {
    const { addApiKeyAccount } = loadVaultAddApiKey()
    process.env.EMPTY_VAR = ''
    const result = await addApiKeyAccount({
      provider: 'dashscope',
      keySource: { type: 'env', envVar: 'EMPTY_VAR' },
      promptForKey: async () => 'fallback-prompted-key',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(memoryStore.get(`sweech-api-key::${result.account.id}`)).toBe('fallback-prompted-key')
  })

  test('stable id when label is re-used (rotation in place)', async () => {
    const { addApiKeyAccount } = loadVaultAddApiKey()
    const first = await addApiKeyAccount({
      provider: 'kimi',
      label: 'kimi-rotate',
      keySource: { type: 'literal', value: 'key-v1' },
    })
    const second = await addApiKeyAccount({
      provider: 'kimi',
      label: 'kimi-rotate',
      keySource: { type: 'literal', value: 'key-v2' },
    })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.account.id).toBe(second.account.id)
    expect(second.alreadyExisted).toBe(true)
    // Keychain holds the rotated secret.
    expect(memoryStore.get(`sweech-api-key::${second.account.id}`)).toBe('key-v2')

    // Only one vault row exists for the stable id.
    const vault = loadVault()
    const matchingRows = vault.listAccountsV2().filter(
      a => a.kind === 'apikey' && a.id === first.account.id,
    )
    expect(matchingRows).toHaveLength(1)
  })

  test('no label → random uuid seed → distinct ids for each call', async () => {
    const { addApiKeyAccount } = loadVaultAddApiKey()
    const a = await addApiKeyAccount({
      provider: 'glm',
      keySource: { type: 'literal', value: 'k1' },
    })
    const b = await addApiKeyAccount({
      provider: 'glm',
      keySource: { type: 'literal', value: 'k2' },
    })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.account.id).not.toBe(b.account.id)
  })

  test('preserves existing vault rows when adding a new account', async () => {
    seedMixedVault()
    const { addApiKeyAccount } = loadVaultAddApiKey()
    const before = loadVault().listAccountsV2()
    expect(before).toHaveLength(6)

    const result = await addApiKeyAccount({
      provider: 'openrouter',
      label: 'openrouter-test',
      keySource: { type: 'literal', value: 'sk-or-test' },
    })
    expect(result.ok).toBe(true)

    const after = loadVault().listAccountsV2()
    expect(after).toHaveLength(7)
    // None of the original rows lost.
    for (const original of before) {
      expect(after.some(a => a.id === original.id && a.kind === original.kind)).toBe(true)
    }
  })

  test('end-to-end: add then list shows the new account in the unified shape', async () => {
    const { addApiKeyAccount } = loadVaultAddApiKey()
    const helpers = loadAccountsList()
    const vault = loadVault()

    const added = await addApiKeyAccount({
      provider: 'kimi',
      label: 'integration-test',
      keySource: { type: 'literal', value: 'integration-key' },
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const json = helpers.buildAccountsListJson(
      helpers.sortAccountsForList(
        helpers.filterAccountsForList(vault.listAccountsV2(), { kind: 'apikey' }),
      ),
    )
    expect(json.schemaVersion).toBe(1)
    expect(json.accounts).toHaveLength(1)
    expect(json.accounts[0].kind).toBe('apikey')
    if (json.accounts[0].kind === 'apikey') {
      expect(json.accounts[0].label).toBe('integration-test')
      expect(json.accounts[0].provider).toBe('kimi')
      expect(json.accounts[0].id).toBe(added.account.id)
    }
  })
})

describe('resolveApiKeyValue', () => {
  test('env source picks up value from process.env', async () => {
    const { resolveApiKeyValue } = loadVaultAddApiKey()
    process.env.TEST_RESOLVE_KEY = 'value-from-env'
    expect(await resolveApiKeyValue({ type: 'env', envVar: 'TEST_RESOLVE_KEY' }))
      .toBe('value-from-env')
  })

  test('env source returns null when var is unset', async () => {
    const { resolveApiKeyValue } = loadVaultAddApiKey()
    delete process.env.NOT_SET
    expect(await resolveApiKeyValue({ type: 'env', envVar: 'NOT_SET' })).toBeNull()
  })

  test('stdin source uses provided reader hook', async () => {
    const { resolveApiKeyValue } = loadVaultAddApiKey()
    const value = await resolveApiKeyValue(
      { type: 'stdin' },
      { stdinReader: async () => 'piped-secret\n' },
    )
    expect(value).toBe('piped-secret')
  })

  test('literal source trims and returns', async () => {
    const { resolveApiKeyValue } = loadVaultAddApiKey()
    expect(await resolveApiKeyValue({ type: 'literal', value: '  spaced  ' })).toBe('spaced')
  })

  test('whitespace-only env value resolves to null', async () => {
    const { resolveApiKeyValue } = loadVaultAddApiKey()
    process.env.WHITESPACE_KEY = '   '
    expect(await resolveApiKeyValue({ type: 'env', envVar: 'WHITESPACE_KEY' })).toBeNull()
  })
})
