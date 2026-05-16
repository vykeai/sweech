import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, rename, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadProfilesConfig,
  clearProfileCache,
  startConfigWatcher,
  stopConfigWatcher,
  _setProfilesPath,
} from '../../middleware/profiles.js'

// Wall-clock sleep used to wait for the watcher debounce (250ms) plus
// fs event propagation. Keep small but enough so darwin FSEvents fires.
const RELOAD_WAIT_MS = 600

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

// Wait until `predicate` returns true, polling every 25ms. Times out at
// `RELOAD_WAIT_MS` so a regression fails loud instead of hanging.
async function waitFor<T>(predicate: () => Promise<T> | T, timeoutMs = RELOAD_WAIT_MS): Promise<T> {
  const start = Date.now()
  let last: T | undefined
  while (Date.now() - start < timeoutMs) {
    last = await predicate()
    if (last) return last
    await sleep(25)
  }
  if (last !== undefined) return last
  throw new Error(`waitFor: predicate never returned truthy within ${timeoutMs}ms`)
}

function profileArray(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify([
    { name, commandName: name, cliType: 'claude', provider: 'claude', ...extra },
  ])
}

describe('profiles hot reload (T-040)', () => {
  let dir: string
  let configPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sweech-profiles-'))
    configPath = join(dir, 'config.json')
    _setProfilesPath(configPath)
    clearProfileCache()
  })

  afterEach(async () => {
    stopConfigWatcher()
    clearProfileCache()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('reloads cache after an in-place write', async () => {
    await writeFile(configPath, profileArray('alpha'), 'utf-8')
    const initial = await loadProfilesConfig()
    expect(initial['alpha']).toBeTruthy()
    expect(initial['beta']).toBeUndefined()

    startConfigWatcher()
    await writeFile(configPath, profileArray('beta'), 'utf-8')

    const refreshed = await waitFor(async () => {
      const next = await loadProfilesConfig()
      return next['beta'] ? next : null
    })
    expect(refreshed['beta']).toBeTruthy()
    expect(refreshed['alpha']).toBeUndefined()
  })

  it('reloads cache after an atomic rename (vim / mv tmp config.json)', async () => {
    await writeFile(configPath, profileArray('alpha'), 'utf-8')
    await loadProfilesConfig()

    startConfigWatcher()
    // Atomic-rename pattern: write a sibling tmp file, rename over the
    // target. `fs.watch` on the file alone would stop firing here — the
    // directory watch keeps working.
    const tmpPath = join(dir, 'config.json.tmp')
    await writeFile(tmpPath, profileArray('gamma'), 'utf-8')
    await rename(tmpPath, configPath)

    const refreshed = await waitFor(async () => {
      const next = await loadProfilesConfig()
      return next['gamma'] ? next : null
    })
    expect(refreshed['gamma']).toBeTruthy()
    expect(refreshed['alpha']).toBeUndefined()
  })

  it('keeps the old cache when a malformed write lands', async () => {
    await writeFile(configPath, profileArray('alpha'), 'utf-8')
    await loadProfilesConfig()

    startConfigWatcher()
    await writeFile(configPath, '{ not valid json', 'utf-8')

    // Wait long enough for the reload to fire and fail; cache should be
    // untouched.
    await sleep(RELOAD_WAIT_MS)
    const after = await loadProfilesConfig()
    expect(after['alpha']).toBeTruthy()

    // Now write valid JSON again — watcher should still be alive.
    await writeFile(configPath, profileArray('delta'), 'utf-8')
    const refreshed = await waitFor(async () => {
      const next = await loadProfilesConfig()
      return next['delta'] ? next : null
    })
    expect(refreshed['delta']).toBeTruthy()
  })

  it('handles delete + recreate cycles', async () => {
    await writeFile(configPath, profileArray('alpha'), 'utf-8')
    await loadProfilesConfig()
    startConfigWatcher()

    await unlink(configPath)
    // The post-delete reload swaps in an empty config — verify.
    const emptied = await waitFor(async () => {
      const next = await loadProfilesConfig()
      return next['alpha'] === undefined ? next : null
    })
    expect(emptied['alpha']).toBeUndefined()

    await writeFile(configPath, profileArray('epsilon'), 'utf-8')
    const refreshed = await waitFor(async () => {
      const next = await loadProfilesConfig()
      return next['epsilon'] ? next : null
    })
    expect(refreshed['epsilon']).toBeTruthy()
  })

  it('startConfigWatcher is idempotent', async () => {
    await writeFile(configPath, profileArray('alpha'), 'utf-8')
    await loadProfilesConfig()

    const a = startConfigWatcher()
    const b = startConfigWatcher()
    // Same underlying watcher — no doubling.
    expect(a).toBe(b)

    await writeFile(configPath, profileArray('beta'), 'utf-8')
    const refreshed = await waitFor(async () => {
      const next = await loadProfilesConfig()
      return next['beta'] ? next : null
    })
    expect(refreshed['beta']).toBeTruthy()
  })

  it('stale in-flight load does NOT resurrect old credentials after a hot-reload', async () => {
    // Reproduces the codex adversarial finding: an async loadProfilesConfig
    // capturing the OLD config could overwrite a freshly-reloaded `cached`.
    // The fix is a generation counter — when reloadProfilesConfig fires
    // mid-load, the old load's eventual `cached = result` must be skipped.

    // 1. Initial config has `legacy` (think: a credential we want to rotate out).
    await writeFile(configPath, profileArray('legacy'), 'utf-8')
    await loadProfilesConfig()  // primes cache
    clearProfileCache()         // force a fresh async load on next call

    startConfigWatcher()

    // 2. Kick off a "slow" load (it'll actually be fast, but it captures
    //    the legacy generation at function entry).
    const slowLoad = loadProfilesConfig()

    // 3. Atomic-rename the new config into place WHILE slowLoad is awaiting.
    //    The watcher will fire reloadProfilesConfig with `rotated`.
    const tmpFile = join(dir, 'config.json.next')
    await writeFile(tmpFile, profileArray('rotated'), 'utf-8')
    await rename(tmpFile, configPath)

    // 4. Wait for the reload to land (cache shows `rotated`).
    await waitFor(async () => {
      const cur = await loadProfilesConfig()
      return cur['rotated'] ? cur : null
    })

    // 5. Now resolve the slow load. WITHOUT the generation guard, this
    //    write would clobber `cached` back to `legacy`. WITH it, the
    //    write is skipped and the cache stays at `rotated`.
    await slowLoad

    const finalState = await loadProfilesConfig()
    expect(finalState['rotated']).toBeTruthy()
    expect(finalState['legacy']).toBeUndefined()
  })

  it('does not crash when started before the file or directory exists', async () => {
    // Use a path inside a directory that does NOT exist yet.
    const ghostDir = join(dir, 'ghost')
    const ghostPath = join(ghostDir, 'config.json')
    _setProfilesPath(ghostPath)

    expect(() => startConfigWatcher()).not.toThrow()
    // First load with no file → empty config.
    const empty = await loadProfilesConfig()
    expect(Object.keys(empty).filter((k) => k !== '_config')).toHaveLength(0)

    // Now create the directory + file. The watcher started against a
    // missing directory returns null; we re-start it once the dir
    // exists and verify it picks up the new file.
    await mkdir(ghostDir, { recursive: true })
    stopConfigWatcher()
    startConfigWatcher()
    await writeFile(ghostPath, profileArray('zeta'), 'utf-8')

    const refreshed = await waitFor(async () => {
      const next = await loadProfilesConfig()
      return next['zeta'] ? next : null
    })
    expect(refreshed['zeta']).toBeTruthy()
  })
})
