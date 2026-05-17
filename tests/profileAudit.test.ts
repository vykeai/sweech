/**
 * Tests for src/profileAudit.ts (T-LU-008).
 *
 * Strategy: spin up a real temp directory, create fake profile dirs
 * inside it, and stub ConfigManager to return our crafted profile list +
 * point getProfileDir at the temp paths. This lets us exercise the real
 * fs probing (mtime walks, symlinks, missing files) end-to-end without
 * touching the user's homedir.
 *
 * Adjacent stubs (clis, providers) are not needed — auditProfiles only
 * reads from settings.json and the profile dir layout.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ConfigManager, ProfileConfig } from '../src/config'
import {
  auditProfiles,
  decideVendor,
  decodeBearerIssuer,
  inferVendorFromKey,
  inferVendorFromName,
  KEY_PREFIX_VENDOR,
  NAME_VENDOR_HINTS,
  normaliseProviderToVendor,
  probeProfileActivity,
  prunableProfiles,
  snapshotSettingsAuth,
  vendorFromIssuer,
} from '../src/profileAudit'

// ── Test infrastructure ─────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-audit-test-'))

afterAll(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch {}
})

/**
 * Build a fake ConfigManager that returns the given profile list and
 * resolves getProfileDir against a fresh tmp dir per test.
 */
function makeConfig(profiles: ProfileConfig[], rootDir: string): ConfigManager {
  return {
    getProfiles: () => profiles,
    getProfileDir: (name: string) => path.join(rootDir, `.${name}`),
  } as unknown as ConfigManager
}

/**
 * Touch a file with a specific mtime. Creates parent dirs as needed.
 */
function touchAt(filePath: string, mtimeMs: number, content = ''): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000)
}

/**
 * Build a profile dir with settings.json and (optionally) recent activity.
 */
function buildProfileDir(
  rootDir: string,
  commandName: string,
  settings: { env?: Record<string, string>; oauth?: unknown } = {},
  activity?: { paths?: string[]; mtimeMs?: number },
): string {
  const dir = path.join(rootDir, `.${commandName}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    env: settings.env ?? {},
    ...(settings.oauth ? { oauth: settings.oauth } : {}),
  }))
  if (activity) {
    const paths = activity.paths ?? ['sessions/recent.jsonl']
    for (const p of paths) {
      touchAt(path.join(dir, p), activity.mtimeMs ?? Date.now(), 'x')
    }
  }
  return dir
}

let testCounter = 0
function freshRoot(): string {
  testCounter++
  const r = path.join(TMP_ROOT, `t-${testCounter}`)
  fs.mkdirSync(r, { recursive: true })
  return r
}

const NOW = new Date('2026-05-17T12:00:00.000Z').getTime()
const nowFn = (): number => NOW
const DAYS = (n: number): number => n * 24 * 60 * 60 * 1000

// ── normaliseProviderToVendor ───────────────────────────────────────────────

describe('normaliseProviderToVendor', () => {
  test('kimi-coding collapses to kimi', () => {
    expect(normaliseProviderToVendor('kimi-coding')).toBe('kimi')
  })

  test('qwen and dashscope collapse to dashscope', () => {
    expect(normaliseProviderToVendor('qwen')).toBe('dashscope')
    expect(normaliseProviderToVendor('dashscope')).toBe('dashscope')
    expect(normaliseProviderToVendor('qwen-openai')).toBe('dashscope')
  })

  test('-openai twin collapses to canonical', () => {
    expect(normaliseProviderToVendor('deepseek-openai')).toBe('deepseek')
    expect(normaliseProviderToVendor('glm-openai')).toBe('glm')
    expect(normaliseProviderToVendor('minimax-openai')).toBe('minimax')
    expect(normaliseProviderToVendor('openrouter-openai')).toBe('openrouter')
  })

  test('unknown provider passes through lowercased', () => {
    expect(normaliseProviderToVendor('NewVendor')).toBe('newvendor')
  })
})

// ── inferVendorFromName ─────────────────────────────────────────────────────

describe('inferVendorFromName', () => {
  test('vendor-explicit anthropic name', () => {
    expect(inferVendorFromName('claude-anthropic')).toBe('anthropic')
    expect(inferVendorFromName('anthropic-work')).toBe('anthropic')
  })

  test('kimi-* maps to kimi', () => {
    expect(inferVendorFromName('kimi')).toBe('kimi')
    expect(inferVendorFromName('kimi-coding')).toBe('kimi')
    expect(inferVendorFromName('claude-kimi')).toBe('kimi')
  })

  test('vendor-explicit openai name', () => {
    expect(inferVendorFromName('claude-openai')).toBe('openai')
    expect(inferVendorFromName('codex-openai')).toBe('openai')
  })

  test('glm / minimax / deepseek / dashscope tokens', () => {
    expect(inferVendorFromName('claude-glm')).toBe('glm')
    expect(inferVendorFromName('claude-minimax')).toBe('minimax')
    expect(inferVendorFromName('claude-deepseek')).toBe('deepseek')
    expect(inferVendorFromName('claude-dashscope')).toBe('dashscope')
    expect(inferVendorFromName('claude-qwen')).toBe('dashscope')
  })

  test('bare CLI-family prefix does NOT imply a vendor', () => {
    // `claude-ali`, `codex-work` etc. are namespace markers, not vendor
    // statements. Audit must not generate false positives from them.
    expect(inferVendorFromName('claude')).toBeNull()
    expect(inferVendorFromName('claude-work')).toBeNull()
    expect(inferVendorFromName('claude-ali')).toBeNull()
    expect(inferVendorFromName('codex')).toBeNull()
    expect(inferVendorFromName('codex-work')).toBeNull()
  })

  test('returns null when no hint matches', () => {
    expect(inferVendorFromName('mystery-profile')).toBeNull()
    expect(inferVendorFromName('xyz123')).toBeNull()
  })

  test('NAME_VENDOR_HINTS are case-insensitive', () => {
    expect(inferVendorFromName('Kimi')).toBe('kimi')
    expect(inferVendorFromName('Claude-KIMI')).toBe('kimi')
  })
})

// ── inferVendorFromKey ──────────────────────────────────────────────────────

describe('inferVendorFromKey', () => {
  test('sk-ant- maps to anthropic', () => {
    expect(inferVendorFromKey('sk-ant-api03-abc123')).toBe('anthropic')
    expect(inferVendorFromKey('sk-ant-anything')).toBe('anthropic')
  })

  test('bearer_sk-ant maps to anthropic', () => {
    expect(inferVendorFromKey('bearer_sk-ant-api03-token-here')).toBe('anthropic')
  })

  test('sk-or- maps to openrouter', () => {
    expect(inferVendorFromKey('sk-or-v1-foo')).toBe('openrouter')
    expect(inferVendorFromKey('sk-or-anything')).toBe('openrouter')
  })

  test('sk-proj-/sk-oat-/sk-oauth- map to openai', () => {
    expect(inferVendorFromKey('sk-proj-abc')).toBe('openai')
    expect(inferVendorFromKey('sk-oat-abc')).toBe('openai')
    expect(inferVendorFromKey('sk-oauth-abc')).toBe('openai')
  })

  test('sk-sp- maps to dashscope', () => {
    expect(inferVendorFromKey('sk-sp-foo')).toBe('dashscope')
  })

  test('moonshot ms- and mse_ map to kimi', () => {
    expect(inferVendorFromKey('ms-abc123')).toBe('kimi')
    expect(inferVendorFromKey('mse_abc123')).toBe('kimi')
  })

  test('gsk_ maps to groq', () => {
    expect(inferVendorFromKey('gsk_xyz')).toBe('groq')
  })

  test('AIzaSy maps to gemini', () => {
    expect(inferVendorFromKey('AIzaSyXYZ')).toBe('gemini')
  })

  test('returns null for unknown shape (GLM keys, etc.)', () => {
    expect(inferVendorFromKey('5a8c2db8.deadbeef')).toBeNull()
    expect(inferVendorFromKey('opaque-token')).toBeNull()
  })

  test('handles empty input', () => {
    expect(inferVendorFromKey('')).toBeNull()
  })

  test('KEY_PREFIX_VENDOR is ordered (anthropic before openrouter sk- collision)', () => {
    // sk-ant- must precede any bare sk- entries.
    const skAntIdx = KEY_PREFIX_VENDOR.findIndex(e => e.prefix === 'sk-ant-')
    const skOrIdx = KEY_PREFIX_VENDOR.findIndex(e => e.prefix === 'sk-or-')
    expect(skAntIdx).toBeLessThan(KEY_PREFIX_VENDOR.length)
    expect(skOrIdx).toBeLessThan(KEY_PREFIX_VENDOR.length)
    // Both present, sk-ant- doesn't get shadowed by a bare sk- entry
    // (we don't add one, but assert anyway).
    expect(KEY_PREFIX_VENDOR.some(e => e.prefix === 'sk-')).toBe(false)
  })
})

// ── decodeBearerIssuer + vendorFromIssuer ───────────────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = 'fake-signature-not-verified'
  return `${header}.${body}.${sig}`
}

describe('decodeBearerIssuer', () => {
  test('extracts iss from a JWT-shaped token', () => {
    const jwt = makeJwt({ iss: 'https://claude.ai', sub: 'user' })
    expect(decodeBearerIssuer(jwt)).toBe('https://claude.ai')
  })

  test('handles bearer_ prefix', () => {
    const jwt = makeJwt({ iss: 'https://api.anthropic.com' })
    expect(decodeBearerIssuer(`bearer_${jwt}`)).toBe('https://api.anthropic.com')
  })

  test('handles sk-oauth- prefix', () => {
    const jwt = makeJwt({ iss: 'https://platform.openai.com' })
    expect(decodeBearerIssuer(`sk-oauth-${jwt}`)).toBe('https://platform.openai.com')
  })

  test('returns null for non-JWT shape', () => {
    expect(decodeBearerIssuer('not.a.jwt')).toBeNull()
    expect(decodeBearerIssuer('sk-ant-api03-plain-key')).toBeNull()
    expect(decodeBearerIssuer('')).toBeNull()
  })

  test('returns null when iss claim missing', () => {
    const jwt = makeJwt({ sub: 'user-only', exp: 99 })
    expect(decodeBearerIssuer(jwt)).toBeNull()
  })

  test('returns null when iss is not a string', () => {
    const jwt = makeJwt({ iss: 42 })
    expect(decodeBearerIssuer(jwt)).toBeNull()
  })
})

describe('vendorFromIssuer', () => {
  test('anthropic / claude domains map to anthropic', () => {
    expect(vendorFromIssuer('https://api.anthropic.com')).toBe('anthropic')
    expect(vendorFromIssuer('https://claude.ai/oauth')).toBe('anthropic')
  })

  test('openai / platform.openai map to openai', () => {
    expect(vendorFromIssuer('https://api.openai.com')).toBe('openai')
    expect(vendorFromIssuer('https://platform.openai.com')).toBe('openai')
  })

  test('moonshot / kimi domains map to kimi', () => {
    expect(vendorFromIssuer('https://api.moonshot.ai')).toBe('kimi')
    expect(vendorFromIssuer('https://kimi.com/oauth')).toBe('kimi')
  })

  test('z.ai maps to glm', () => {
    expect(vendorFromIssuer('https://api.z.ai')).toBe('glm')
  })

  test('unknown issuer returns null', () => {
    expect(vendorFromIssuer('https://example.invalid')).toBeNull()
  })
})

// ── snapshotSettingsAuth ────────────────────────────────────────────────────

describe('snapshotSettingsAuth', () => {
  test('extracts ANTHROPIC_AUTH_TOKEN as the primary auth', () => {
    const snap = snapshotSettingsAuth({ ANTHROPIC_AUTH_TOKEN: 'sk-ant-test' })
    expect(snap.authSource).toBe('ANTHROPIC_AUTH_TOKEN')
    expect(snap.authToken).toBe('sk-ant-test')
  })

  test('extracts OPENAI_API_KEY when no anthropic token', () => {
    const snap = snapshotSettingsAuth({ OPENAI_API_KEY: 'sk-proj-test' })
    expect(snap.authSource).toBe('OPENAI_API_KEY')
    expect(snap.authToken).toBe('sk-proj-test')
  })

  test('extracts KIMI_API_KEY as fallback', () => {
    const snap = snapshotSettingsAuth({ KIMI_API_KEY: 'ms-foo' })
    expect(snap.authSource).toBe('KIMI_API_KEY')
    expect(snap.authToken).toBe('ms-foo')
  })

  test('lists all provider envs present (extras)', () => {
    const snap = snapshotSettingsAuth({
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-x',
      OPENAI_API_KEY: 'sk-proj-y',
      KIMI_API_KEY: 'ms-z',
    })
    expect(snap.extraProviderEnvs).toEqual(expect.arrayContaining([
      'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'KIMI_API_KEY',
    ]))
  })

  test('returns empty snapshot for env without auth', () => {
    const snap = snapshotSettingsAuth({ FOO: 'bar' })
    expect(snap.authToken).toBe('')
    expect(snap.authSource).toBeNull()
    expect(snap.extraProviderEnvs).toEqual([])
  })

  test('ignores empty-string values', () => {
    const snap = snapshotSettingsAuth({ ANTHROPIC_AUTH_TOKEN: '', KIMI_API_KEY: 'ms-foo' })
    expect(snap.authSource).toBe('KIMI_API_KEY')
  })
})

// ── decideVendor ────────────────────────────────────────────────────────────

describe('decideVendor', () => {
  test('detects clean alignment (name + provider + key all agree)', () => {
    const profile: ProfileConfig = {
      name: 'claude-anthropic',
      commandName: 'claude-anthropic',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const decision = decideVendor(profile, { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-abc' })
    expect(decision.configuredVendor).toBe('anthropic')
    expect(decision.nameVendor).toBe('anthropic')
    expect(decision.authVendor).toBe('anthropic')
    expect(decision.orphanProviderEnvs).toEqual([])
  })

  test('bare claude-work has no nameVendor opinion', () => {
    const profile: ProfileConfig = {
      name: 'claude-work',
      commandName: 'claude-work',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const decision = decideVendor(profile, { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-abc' })
    expect(decision.nameVendor).toBeNull()
    // configured vendor + auth vendor still align — no cross-bleed
    expect(decision.configuredVendor).toBe('anthropic')
    expect(decision.authVendor).toBe('anthropic')
  })

  test('detects name vs auth cross-bleed', () => {
    const profile: ProfileConfig = {
      name: 'kimi-work',
      commandName: 'kimi-work',
      cliType: 'kimi',
      provider: 'kimi',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const decision = decideVendor(profile, { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-bad' })
    expect(decision.nameVendor).toBe('kimi')
    expect(decision.authVendor).toBe('anthropic')
  })

  test('flags orphan KIMI_API_KEY on an anthropic profile', () => {
    const profile: ProfileConfig = {
      name: 'claude-work',
      commandName: 'claude-work',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const decision = decideVendor(profile, {
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-good',
      KIMI_API_KEY: 'ms-leftover',
    })
    expect(decision.orphanProviderEnvs).toEqual(['KIMI_API_KEY'])
  })

  test('does NOT flag ANTHROPIC_AUTH_TOKEN as orphan on a non-anthropic claude profile', () => {
    // Sweech wraps every claude profile's auth in ANTHROPIC_AUTH_TOKEN
    // regardless of upstream provider — that env is the CLI's auth pipe,
    // not an orphan from another vendor.
    const profile: ProfileConfig = {
      name: 'claude-ali',
      commandName: 'claude-ali',
      cliType: 'claude',
      provider: 'dashscope',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const decision = decideVendor(profile, {
      ANTHROPIC_AUTH_TOKEN: 'sk-sp-alibaba-key',
    })
    expect(decision.orphanProviderEnvs).toEqual([])
  })

  test('does NOT flag OPENAI_API_KEY as orphan on a non-openai codex profile', () => {
    const profile: ProfileConfig = {
      name: 'codex-deep',
      commandName: 'codex-deep',
      cliType: 'codex',
      provider: 'deepseek-openai',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const decision = decideVendor(profile, {
      OPENAI_API_KEY: 'sk-deepseek-key',
    })
    expect(decision.orphanProviderEnvs).toEqual([])
  })

  test('null auth vendor for opaque keys (GLM-style)', () => {
    const profile: ProfileConfig = {
      name: 'claude-glm',
      commandName: 'claude-glm',
      cliType: 'claude',
      provider: 'glm',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const decision = decideVendor(profile, { ANTHROPIC_AUTH_TOKEN: '5a8c2db8.deadbeef' })
    expect(decision.authVendor).toBeNull()
    expect(decision.configuredVendor).toBe('glm')
  })

  test('JWT issuer is used when key prefix is unrecognised', () => {
    const profile: ProfileConfig = {
      name: 'kimi-work',
      commandName: 'kimi-work',
      cliType: 'kimi',
      provider: 'kimi',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const jwt = makeJwt({ iss: 'https://claude.ai' })
    const decision = decideVendor(profile, { ANTHROPIC_AUTH_TOKEN: `bearer_${jwt}` })
    expect(decision.authVendor).toBe('anthropic')
    expect(decision.nameVendor).toBe('kimi')
  })
})

// ── probeProfileActivity ────────────────────────────────────────────────────

describe('probeProfileActivity', () => {
  test('returns null when profile dir does not exist', () => {
    const probe = probeProfileActivity('/non/existent/path', 'claude')
    expect(probe.lastActivityMs).toBeNull()
  })

  test('returns null when profile dir is empty', () => {
    const r = freshRoot()
    const dir = path.join(r, 'empty')
    fs.mkdirSync(dir, { recursive: true })
    const probe = probeProfileActivity(dir, 'claude')
    expect(probe.lastActivityMs).toBeNull()
  })

  test('picks up recent sessions/ activity for a claude profile', () => {
    const r = freshRoot()
    const dir = buildProfileDir(r, 'claude-fresh', {}, {
      paths: ['sessions/recent.jsonl'],
      mtimeMs: NOW - DAYS(1),
    })
    const probe = probeProfileActivity(dir, 'claude')
    expect(probe.lastActivityMs).not.toBeNull()
    expect(probe.lastActivityMs!).toBeGreaterThan(NOW - DAYS(2))
  })

  test('picks up codex history.jsonl mtime', () => {
    const r = freshRoot()
    const dir = buildProfileDir(r, 'codex-fresh', {}, {
      paths: ['history.jsonl'],
      mtimeMs: NOW - DAYS(2),
    })
    const probe = probeProfileActivity(dir, 'codex')
    expect(probe.lastActivityMs).not.toBeNull()
    expect(probe.lastActivityMs!).toBeGreaterThan(NOW - DAYS(3))
  })

  test('finds state_*.sqlite rotating db', () => {
    const r = freshRoot()
    const dir = buildProfileDir(r, 'codex-sqlite', {})
    touchAt(path.join(dir, 'state_5.sqlite'), NOW - DAYS(3))
    touchAt(path.join(dir, 'logs_1.sqlite'), NOW - DAYS(2))
    const probe = probeProfileActivity(dir, 'codex')
    expect(probe.lastActivityMs).not.toBeNull()
    // newest wins
    expect(probe.lastActivityMs!).toBeGreaterThanOrEqual(NOW - DAYS(2) - 1000)
  })

  test('descends into projects/<repo>/sessions/* for claude', () => {
    const r = freshRoot()
    const dir = buildProfileDir(r, 'claude-projects', {}, {
      paths: ['projects/myrepo/sessions/abc.jsonl'],
      mtimeMs: NOW - DAYS(5),
    })
    const probe = probeProfileActivity(dir, 'claude')
    expect(probe.lastActivityMs).not.toBeNull()
  })

  test('kimi-style user-history/', () => {
    const r = freshRoot()
    const dir = buildProfileDir(r, 'kimi-fresh', {}, {
      paths: ['user-history/2026-05-01.json'],
      mtimeMs: NOW - DAYS(7),
    })
    const probe = probeProfileActivity(dir, 'kimi')
    expect(probe.lastActivityMs).not.toBeNull()
  })

  test('picks newest of multiple activity paths', () => {
    const r = freshRoot()
    const dir = buildProfileDir(r, 'multi-mtime', {})
    touchAt(path.join(dir, 'sessions/old.jsonl'), NOW - DAYS(45))
    touchAt(path.join(dir, 'history.jsonl'), NOW - DAYS(2))
    const probe = probeProfileActivity(dir, 'codex')
    expect(probe.lastActivityMs).not.toBeNull()
    // history.jsonl wins
    expect(probe.lastActivityMs!).toBeGreaterThan(NOW - DAYS(3))
  })

  test('probe.paths records what was inspected', () => {
    const r = freshRoot()
    const dir = buildProfileDir(r, 'inspected', {}, {
      paths: ['sessions/x.jsonl'],
      mtimeMs: NOW - DAYS(1),
    })
    const probe = probeProfileActivity(dir, 'claude')
    expect(probe.paths.length).toBeGreaterThan(0)
    expect(probe.paths.some(p => p.path === 'sessions')).toBe(true)
  })
})

// ── auditProfiles (full audit) ──────────────────────────────────────────────

describe('auditProfiles', () => {
  test('returns clean report for fresh profiles with matching auth', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-work',
      commandName: 'claude-work',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'claude-work', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-clean' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(2) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    expect(report.scanned).toBe(1)
    expect(report.findings).toHaveLength(0)
    expect(report.summary.total_issues).toBe(0)
    expect(report.summary.prunable).toBe(0)
  })

  test('flags dormant profile (mtime > 30 days)', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-stale',
      commandName: 'claude-stale',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'claude-stale', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-stale' },
    }, { paths: ['sessions/old.jsonl'], mtimeMs: NOW - DAYS(45) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const dormant = report.findings.filter(f => f.kind === 'dormant')
    expect(dormant).toHaveLength(1)
    expect(dormant[0].profile).toBe('claude-stale')
    expect(dormant[0].suggestion).toBe('prune')
    expect(dormant[0].severity).toBe('warn')
  })

  test('does NOT flag dormant when activity is recent', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-fresh',
      commandName: 'claude-fresh',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'claude-fresh', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-fresh' },
    }, { paths: ['sessions/new.jsonl'], mtimeMs: NOW - DAYS(2) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    expect(report.findings.filter(f => f.kind === 'dormant')).toHaveLength(0)
  })

  test('flags zero-thread profile (no activity at all) as dormant', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-empty',
      commandName: 'claude-empty',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-15T00:00:00.000Z',
    }
    buildProfileDir(r, 'claude-empty', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-zero' },
    })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const dormant = report.findings.filter(f => f.kind === 'dormant')
    expect(dormant).toHaveLength(1)
    expect(dormant[0].evidence.lastActivityMs).toBeNull()
  })

  test('--dormancy-days override changes the threshold', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-mild',
      commandName: 'claude-mild',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'claude-mild', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-mild' },
    }, { paths: ['sessions/x.jsonl'], mtimeMs: NOW - DAYS(10) })
    const config = makeConfig([profile], r)

    // With default 30 days → not dormant
    const r30 = await auditProfiles({ config, now: nowFn })
    expect(r30.findings.filter(f => f.kind === 'dormant')).toHaveLength(0)

    // With 7 days → dormant
    const r7 = await auditProfiles({ config, now: nowFn, dormancyDays: 7 })
    expect(r7.findings.filter(f => f.kind === 'dormant')).toHaveLength(1)
    expect(r7.dormancyDays).toBe(7)
  })

  test('flags cross-bleed when name=kimi but token=anthropic', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'kimi-rogue',
      commandName: 'kimi-rogue',
      cliType: 'kimi',
      provider: 'kimi',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'kimi-rogue', {
      env: { KIMI_API_KEY: 'sk-ant-api03-DEADBEEF' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(1) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const cb = report.findings.filter(f => f.kind === 'cross_bleed')
    expect(cb).toHaveLength(1)
    expect(cb[0].severity).toBe('critical')
    expect(cb[0].suggestion).toBe('prune')
    expect(cb[0].detail).toMatch(/kimi/i)
    expect(cb[0].detail).toMatch(/anthropic/i)
  })

  test('cross-bleed via JWT issuer (key prefix unknown)', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'kimi-jwt',
      commandName: 'kimi-jwt',
      cliType: 'kimi',
      provider: 'kimi',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    const jwt = makeJwt({ iss: 'https://claude.ai' })
    buildProfileDir(r, 'kimi-jwt', {
      env: { KIMI_API_KEY: `bearer_${jwt}` },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(1) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    expect(report.findings.some(f => f.kind === 'cross_bleed')).toBe(true)
  })

  test('configured-provider vs auth mismatch suggests rotate (not prune)', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'mystery-profile',
      commandName: 'mystery-profile',
      cliType: 'claude',
      provider: 'glm',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'mystery-profile', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-wrong' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(1) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const cb = report.findings.filter(f => f.kind === 'cross_bleed')
    expect(cb).toHaveLength(1)
    expect(cb[0].suggestion).toBe('rotate')
  })

  test('flags orphan_credentials when sibling provider env is set', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-work',
      commandName: 'claude-work',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'claude-work', {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-ok',
        OPENAI_API_KEY: 'sk-proj-leftover',
      },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(1) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const orphan = report.findings.filter(f => f.kind === 'orphan_credentials')
    expect(orphan).toHaveLength(1)
    expect(orphan[0].evidence.orphanProviderEnvs).toContain('OPENAI_API_KEY')
    expect(orphan[0].suggestion).toBe('rotate')
  })

  test('flags missing_settings when profile dir absent', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-ghost',
      commandName: 'claude-ghost',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    // do NOT create the profile dir
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const missing = report.findings.filter(f => f.kind === 'missing_settings')
    expect(missing).toHaveLength(1)
    expect(missing[0].severity).toBe('critical')
    expect(missing[0].suggestion).toBeNull()
  })

  test('flags missing_settings when dir exists but settings.json absent', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-no-settings',
      commandName: 'claude-no-settings',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    const dir = path.join(r, '.claude-no-settings')
    fs.mkdirSync(dir, { recursive: true })
    touchAt(path.join(dir, 'sessions/r.jsonl'), NOW - DAYS(1))
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const missing = report.findings.filter(f => f.kind === 'missing_settings')
    expect(missing).toHaveLength(1)
    expect(missing[0].detail).toMatch(/settings\.json/)
  })

  test('flags expired_token when OAuth.expiresAt is past', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-expired',
      commandName: 'claude-expired',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-01-01T00:00:00.000Z',
      oauth: {
        provider: 'anthropic',
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: NOW - DAYS(40),
        tokenType: 'Bearer',
      } as any,
    }
    buildProfileDir(r, 'claude-expired', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-x' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(1) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const expired = report.findings.filter(f => f.kind === 'expired_token')
    expect(expired).toHaveLength(1)
    expect(expired[0].severity).toBe('critical') // > 30 days expired
    expect(expired[0].suggestion).toBe('rotate')
  })

  test('expired_token is warn (not critical) when recently expired', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-justexpired',
      commandName: 'claude-justexpired',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-01-01T00:00:00.000Z',
      oauth: {
        provider: 'anthropic',
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: NOW - DAYS(2),
        tokenType: 'Bearer',
      } as any,
    }
    buildProfileDir(r, 'claude-justexpired', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-x' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(1) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const expired = report.findings.filter(f => f.kind === 'expired_token')
    expect(expired).toHaveLength(1)
    expect(expired[0].severity).toBe('warn')
  })

  test('does not flag valid (future) OAuth token', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-good-oauth',
      commandName: 'claude-good-oauth',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-04-01T00:00:00.000Z',
      oauth: {
        provider: 'anthropic',
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: NOW + DAYS(30),
        tokenType: 'Bearer',
      } as any,
    }
    buildProfileDir(r, 'claude-good-oauth', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-x' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(1) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    expect(report.findings.filter(f => f.kind === 'expired_token')).toHaveLength(0)
  })

  test('summary counts match findings', async () => {
    const r = freshRoot()
    const profiles: ProfileConfig[] = [
      {
        name: 'claude-stale',
        commandName: 'claude-stale',
        cliType: 'claude',
        provider: 'anthropic',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        name: 'kimi-rogue',
        commandName: 'kimi-rogue',
        cliType: 'kimi',
        provider: 'kimi',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]
    buildProfileDir(r, 'claude-stale', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-x' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(60) })
    buildProfileDir(r, 'kimi-rogue', {
      env: { KIMI_API_KEY: 'sk-ant-api03-WRONG' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(1) })
    const config = makeConfig(profiles, r)
    const report = await auditProfiles({ config, now: nowFn })
    expect(report.scanned).toBe(2)
    expect(report.summary.dormant).toBeGreaterThanOrEqual(1)
    expect(report.summary.cross_bleed).toBeGreaterThanOrEqual(1)
    expect(report.summary.total_issues).toBe(report.findings.length)
  })

  test('handles empty profile list', async () => {
    const r = freshRoot()
    const config = makeConfig([], r)
    const report = await auditProfiles({ config, now: nowFn })
    expect(report.scanned).toBe(0)
    expect(report.findings).toEqual([])
    expect(report.summary.total_issues).toBe(0)
  })

  test('JSON shape is stable (snapshot-able)', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-stale',
      commandName: 'claude-stale',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'claude-stale', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-x' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(60) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn, dormancyDays: 30 })
    // Round-trip through JSON.stringify cleanly
    const parsed = JSON.parse(JSON.stringify(report))
    expect(parsed.scanned).toBe(1)
    expect(parsed.dormancyDays).toBe(30)
    expect(parsed.generatedAt).toBe('2026-05-17T12:00:00.000Z')
    expect(Array.isArray(parsed.findings)).toBe(true)
    expect(parsed.summary).toHaveProperty('dormant')
    expect(parsed.summary).toHaveProperty('cross_bleed')
    expect(parsed.summary).toHaveProperty('total_issues')
    expect(parsed.summary).toHaveProperty('prunable')
  })

  test('Studio scenario: 7 dormant + 2 cross-bleed', async () => {
    const r = freshRoot()
    const profiles: ProfileConfig[] = []
    // 7 dormant Claude profiles
    for (let i = 0; i < 7; i++) {
      profiles.push({
        name: `claude-old-${i}`,
        commandName: `claude-old-${i}`,
        cliType: 'claude',
        provider: 'anthropic',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      buildProfileDir(r, `claude-old-${i}`, {
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-x' },
      }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(60 + i) })
    }
    // 2 dormant Codex profiles
    for (let i = 0; i < 2; i++) {
      profiles.push({
        name: `codex-old-${i}`,
        commandName: `codex-old-${i}`,
        cliType: 'codex',
        provider: 'openai',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      buildProfileDir(r, `codex-old-${i}`, {
        env: { OPENAI_API_KEY: 'sk-proj-x' },
      }, { paths: ['history.jsonl'], mtimeMs: NOW - DAYS(90 + i) })
    }
    const config = makeConfig(profiles, r)
    const report = await auditProfiles({ config, now: nowFn })
    expect(report.scanned).toBe(9)
    expect(report.summary.dormant).toBe(9)
    expect(report.summary.prunable).toBeGreaterThanOrEqual(9)
  })
})

// ── prunableProfiles ────────────────────────────────────────────────────────

describe('prunableProfiles', () => {
  test('groups findings by profile (one entry per name)', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'kimi-doubletrouble',
      commandName: 'kimi-doubletrouble',
      cliType: 'kimi',
      provider: 'kimi',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    // Build a profile that is BOTH dormant AND cross-bleed
    buildProfileDir(r, 'kimi-doubletrouble', {
      env: { KIMI_API_KEY: 'sk-ant-api03-WRONG' },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(60) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const prunable = prunableProfiles(report)
    expect(prunable).toHaveLength(1)
    expect(prunable[0].reasons.length).toBeGreaterThanOrEqual(2)
  })

  test('returns empty when nothing prunable', async () => {
    const r = freshRoot()
    const config = makeConfig([], r)
    const report = await auditProfiles({ config, now: nowFn })
    expect(prunableProfiles(report)).toEqual([])
  })

  test('does not include rotate/info suggestions', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-work',
      commandName: 'claude-work',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'claude-work', {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-good',
        OPENAI_API_KEY: 'sk-proj-leftover',
      },
    }, { paths: ['sessions/r.jsonl'], mtimeMs: NOW - DAYS(1) })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    // orphan_credentials suggests 'rotate' — should NOT be in prunable list
    expect(prunableProfiles(report)).toHaveLength(0)
  })

  test('preserves cliType + provider for each prunable entry', async () => {
    const r = freshRoot()
    const profile: ProfileConfig = {
      name: 'claude-empty-profile',
      commandName: 'claude-empty-profile',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-04-01T00:00:00.000Z',
    }
    buildProfileDir(r, 'claude-empty-profile', {
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-x' },
    })
    const config = makeConfig([profile], r)
    const report = await auditProfiles({ config, now: nowFn })
    const prunable = prunableProfiles(report)
    expect(prunable[0].cliType).toBe('claude')
    expect(prunable[0].provider).toBe('anthropic')
  })
})

// ── Constants sanity ────────────────────────────────────────────────────────

describe('module constants', () => {
  test('NAME_VENDOR_HINTS covers the canonical CLI families', () => {
    const vendors = NAME_VENDOR_HINTS.map(h => h.vendor)
    expect(vendors).toContain('anthropic')
    expect(vendors).toContain('openai')
    expect(vendors).toContain('kimi')
  })

  test('KEY_PREFIX_VENDOR has at least one entry for the official OAuth tokens', () => {
    expect(KEY_PREFIX_VENDOR.some(e => e.prefix === 'sk-ant-')).toBe(true)
    expect(KEY_PREFIX_VENDOR.some(e => e.prefix === 'sk-proj-')).toBe(true)
  })
})
