/**
 * Tests for src/anthropicAuth.ts — Anthropic OAuth client ID resolver.
 *
 * Verifies the precedence chain:
 *   config.json oauth.anthropic.clientId > SWEECH_ANTHROPIC_CLIENT_ID >
 *   ANTHROPIC_CLIENT_ID > built-in default.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  DEFAULT_ANTHROPIC_CLIENT_ID,
  _resetAnthropicClientIdCache,
  getAnthropicClientId,
} from '../src/anthropicAuth'

const CONFIG_PATH = path.join(os.homedir(), '.sweech', 'config.json')
const BACKUP_PATH = path.join(os.homedir(), '.sweech', 'config.json.t043-backup')

let originalEnvSweech: string | undefined
let originalEnvLegacy: string | undefined

beforeAll(() => {
  // Stash the user's real config.json so the tests don't clobber it.
  if (fs.existsSync(CONFIG_PATH)) {
    fs.copyFileSync(CONFIG_PATH, BACKUP_PATH)
    fs.unlinkSync(CONFIG_PATH)
  } else {
    // Ensure parent dir exists for tests that write a fixture config.
    const parent = path.dirname(CONFIG_PATH)
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  }
})

afterAll(() => {
  if (fs.existsSync(BACKUP_PATH)) {
    fs.copyFileSync(BACKUP_PATH, CONFIG_PATH)
    fs.unlinkSync(BACKUP_PATH)
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH)
  }
})

beforeEach(() => {
  _resetAnthropicClientIdCache()
  originalEnvSweech = process.env.SWEECH_ANTHROPIC_CLIENT_ID
  originalEnvLegacy = process.env.ANTHROPIC_CLIENT_ID
  delete process.env.SWEECH_ANTHROPIC_CLIENT_ID
  delete process.env.ANTHROPIC_CLIENT_ID
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
})

afterEach(() => {
  _resetAnthropicClientIdCache()
  if (originalEnvSweech === undefined) delete process.env.SWEECH_ANTHROPIC_CLIENT_ID
  else process.env.SWEECH_ANTHROPIC_CLIENT_ID = originalEnvSweech
  if (originalEnvLegacy === undefined) delete process.env.ANTHROPIC_CLIENT_ID
  else process.env.ANTHROPIC_CLIENT_ID = originalEnvLegacy
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
})

describe('getAnthropicClientId', () => {
  it('returns the built-in default when nothing is set', () => {
    expect(getAnthropicClientId()).toBe(DEFAULT_ANTHROPIC_CLIENT_ID)
  })

  it('reads SWEECH_ANTHROPIC_CLIENT_ID when set', () => {
    process.env.SWEECH_ANTHROPIC_CLIENT_ID = 'sweech-env-id'
    expect(getAnthropicClientId()).toBe('sweech-env-id')
  })

  it('falls back to legacy ANTHROPIC_CLIENT_ID when SWEECH_ is unset', () => {
    process.env.ANTHROPIC_CLIENT_ID = 'legacy-env-id'
    expect(getAnthropicClientId()).toBe('legacy-env-id')
  })

  it('prefers SWEECH_ANTHROPIC_CLIENT_ID over legacy ANTHROPIC_CLIENT_ID', () => {
    process.env.SWEECH_ANTHROPIC_CLIENT_ID = 'sweech-env-id'
    process.env.ANTHROPIC_CLIENT_ID = 'legacy-env-id'
    expect(getAnthropicClientId()).toBe('sweech-env-id')
  })

  it('reads config.json oauth.anthropic.clientId when present', () => {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ profiles: [], oauth: { anthropic: { clientId: 'config-id' } } }),
    )
    expect(getAnthropicClientId()).toBe('config-id')
  })

  it('config.json overrides SWEECH_ANTHROPIC_CLIENT_ID', () => {
    process.env.SWEECH_ANTHROPIC_CLIENT_ID = 'sweech-env-id'
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ profiles: [], oauth: { anthropic: { clientId: 'config-id' } } }),
    )
    expect(getAnthropicClientId()).toBe('config-id')
  })

  it('config.json overrides legacy ANTHROPIC_CLIENT_ID', () => {
    process.env.ANTHROPIC_CLIENT_ID = 'legacy-env-id'
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ profiles: [], oauth: { anthropic: { clientId: 'config-id' } } }),
    )
    expect(getAnthropicClientId()).toBe('config-id')
  })

  it('ignores legacy bare-array config.json shape and falls through to env/default', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify([{ name: 'demo' }]))
    expect(getAnthropicClientId()).toBe(DEFAULT_ANTHROPIC_CLIENT_ID)
  })

  it('falls through to env/default when oauth block is empty', () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ profiles: [], oauth: {} }))
    process.env.SWEECH_ANTHROPIC_CLIENT_ID = 'sweech-env-id'
    expect(getAnthropicClientId()).toBe('sweech-env-id')
  })

  it('falls through when oauth.anthropic.clientId is empty string', () => {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ profiles: [], oauth: { anthropic: { clientId: '' } } }),
    )
    expect(getAnthropicClientId()).toBe(DEFAULT_ANTHROPIC_CLIENT_ID)
  })

  it('tolerates malformed config.json and falls back to default', () => {
    fs.writeFileSync(CONFIG_PATH, '{ not valid json')
    expect(getAnthropicClientId()).toBe(DEFAULT_ANTHROPIC_CLIENT_ID)
  })

  it('caches the resolved value within a process', () => {
    process.env.SWEECH_ANTHROPIC_CLIENT_ID = 'first-id'
    expect(getAnthropicClientId()).toBe('first-id')
    process.env.SWEECH_ANTHROPIC_CLIENT_ID = 'second-id'
    // Cache wins until reset.
    expect(getAnthropicClientId()).toBe('first-id')
    _resetAnthropicClientIdCache()
    expect(getAnthropicClientId()).toBe('second-id')
  })
})
