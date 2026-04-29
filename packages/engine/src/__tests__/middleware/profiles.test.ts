import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFile = vi.fn()
const writeFile = vi.fn()
const mkdir = vi.fn()

vi.mock('node:fs/promises', () => ({
  readFile,
  writeFile,
  mkdir,
}))

describe('profiles migration boundary', () => {
  beforeEach(() => {
    vi.resetModules()
    readFile.mockReset()
    writeFile.mockReset()
    mkdir.mockReset()
  })

  it('migrates and rewrites legacy profiles config on load', async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({
      _config: {
        defaults: { 'claude-code': 'claude-rai' },
      },
      'claude-rai': {
        name: 'claude-rai',
        provider: 'claude',
      },
    }))

    const profiles = await import('../../middleware/profiles.js')
    profiles.clearProfileCache()

    const config = await profiles.loadProfilesConfig()
    expect(config).toMatchObject({
      _config: {
        defaults: { 'claude-code': 'claude-rai' },
      },
      'claude-rai': {
        name: 'claude-rai',
        provider: 'claude',
      },
    })
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(String(writeFile.mock.calls[0]?.[1])).toContain('"version": 2')
  })

  it('fails closed on unsupported profile schema versions', async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({
      schema: 'omnai.runtime',
      version: 99,
      profiles: {},
    }))

    const profiles = await import('../../middleware/profiles.js')
    profiles.clearProfileCache()

    await expect(profiles.loadProfilesConfig()).rejects.toThrow('Upgrade omnai')
  })
})
