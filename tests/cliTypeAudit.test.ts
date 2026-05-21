/**
 * Tests for T-079 cliType_mismatch audit + --fix-cli-type path.
 *
 * The real-world incident this guards against: profiles named
 * `claude-or-pole` (openrouter) and `claude-mm-pro` (minimax) were
 * created with cliType='codex' by accident, so the wrapper ended up
 * exec'ing `codex` against a Claude-style settings.json.
 */

import * as fs from 'fs';
import * as path from 'path';

var __mockHome: string | null = null;
jest.mock('os', () => {
  const actual = jest.requireActual('node:os');
  return { ...actual, homedir: () => __mockHome ?? actual.homedir() };
});
jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  return { ...actual, homedir: () => __mockHome ?? actual.homedir() };
});
import * as os from 'os';
function setHomedir(p: string | null): void { __mockHome = p; }

import { ConfigManager } from '../src/config';
import {
  inferExpectedCliType,
  fixCliTypeOnProfile,
  auditProfiles,
  validateCliTypeConfig,
  probeCodexBackend,
  classifyCodexBackend,
  fixProviderOnProfile,
} from '../src/profileAudit';

function isolateHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-clitype-test-'));
  setHomedir(home);
  process.env.SWEECH_HOME = home;
  if (!os.homedir().startsWith(os.tmpdir()) || !os.homedir().includes('sweech-clitype-test-')) {
    throw new Error(`isolateHome safety check failed: ${os.homedir()}`);
  }
  return home;
}

afterEach(() => {
  setHomedir(null);
  delete process.env.SWEECH_HOME;
});

describe('inferExpectedCliType', () => {
  test('claude- prefix → claude', () => {
    expect(inferExpectedCliType('claude-or-pole', 'openrouter')).toBe('claude');
    expect(inferExpectedCliType('claude-mm-pro', 'minimax')).toBe('claude');
    expect(inferExpectedCliType('claude-ali', 'dashscope')).toBe('claude');
  });

  test('codex- prefix → codex', () => {
    expect(inferExpectedCliType('codex-pole', 'openai')).toBe('codex');
    expect(inferExpectedCliType('codex-ollama', 'ollama')).toBe('codex');
  });

  test('kimi- prefix → kimi', () => {
    expect(inferExpectedCliType('kimi-test', 'kimi')).toBe('kimi');
  });

  test('bare CLI name → matching cliType', () => {
    expect(inferExpectedCliType('claude', 'anthropic')).toBe('claude');
    expect(inferExpectedCliType('codex', 'openai')).toBe('codex');
  });

  test('no prefix, single-CLI provider → infer from provider', () => {
    // anthropic provider has compatibility=['claude'] only.
    expect(inferExpectedCliType('my-profile', 'anthropic')).toBe('claude');
  });

  test('no prefix, multi-CLI provider → null (no opinion)', () => {
    // ollama supports both claude and codex — no inference possible
    // from provider alone, and the name has no recognised prefix.
    expect(inferExpectedCliType('weird-name', 'ollama')).toBeNull();
  });
});

describe('auditProfiles cli_type_mismatch finding', () => {
  test('flags claude- prefixed profile with cliType=codex', async () => {
    isolateHome();
    const cfg = new ConfigManager();
    fs.mkdirSync(path.join(cfg.getConfigDir(), '..', '.claude-or-pole', 'projects'), { recursive: true });
    fs.writeFileSync(
      path.join(cfg.getConfigDir(), '..', '.claude-or-pole', 'settings.json'),
      JSON.stringify({ env: {} }),
    );
    cfg.writeProfiles([{
      name: 'claude-or-pole',
      commandName: 'claude-or-pole',
      cliType: 'codex',
      provider: 'openrouter',
      createdAt: '2026-05-17T00:00:00Z',
    } as any]);

    const report = await auditProfiles({ config: cfg, dormancyDays: 9999 });
    const mismatches = report.findings.filter(f => f.kind === 'cli_type_mismatch');
    expect(mismatches.length).toBe(1);
    expect(mismatches[0].profile).toBe('claude-or-pole');
    expect((mismatches[0].evidence as any).expectedCliType).toBe('claude');
    expect((mismatches[0].evidence as any).observedCliType).toBe('codex');
    expect((mismatches[0].evidence as any).configLine.line).toEqual(expect.any(Number));
    expect((mismatches[0].evidence as any).diskShape.detectedCliTypes).toEqual(['claude']);
    expect(mismatches[0].suggestion).toBe('fix_cli_type');
    expect(report.summary.cli_type_mismatch).toBe(1);
  });

  test('does NOT flag a correctly-typed profile', async () => {
    isolateHome();
    const cfg = new ConfigManager();
    fs.mkdirSync(path.join(cfg.getConfigDir(), '..', '.codex-pole'), { recursive: true });
    fs.writeFileSync(
      path.join(cfg.getConfigDir(), '..', '.codex-pole', 'settings.json'),
      JSON.stringify({ env: {} }),
    );
    cfg.writeProfiles([{
      name: 'codex-pole',
      commandName: 'codex-pole',
      cliType: 'codex',
      provider: 'openai',
      createdAt: '2026-05-17T00:00:00Z',
    } as any]);

    const report = await auditProfiles({ config: cfg, dormancyDays: 9999 });
    expect(report.findings.filter(f => f.kind === 'cli_type_mismatch')).toHaveLength(0);
  });
});

describe('validateCliTypeConfig', () => {
  test('reports cliType mismatch with config line number and Claude disk evidence', () => {
    isolateHome();
    const cfg = new ConfigManager();
    fs.mkdirSync(path.join(cfg.getConfigDir(), '..', '.claude-or-pole', 'projects'), { recursive: true });
    cfg.writeProfiles([{
      name: 'claude-or-pole',
      commandName: 'claude-or-pole',
      cliType: 'codex',
      provider: 'openrouter',
      createdAt: '2026-05-17T00:00:00Z',
    } as any]);

    const findings = validateCliTypeConfig(cfg);
    expect(findings).toHaveLength(1);
    expect(findings[0].profile).toBe('claude-or-pole');
    expect(findings[0].suggestion).toBe('fix_cli_type');
    expect(findings[0].evidence.configLine.configFile).toBe(cfg.getConfigFile());
    expect(findings[0].evidence.configLine.line).toEqual(expect.any(Number));
    expect(findings[0].evidence.diskShape.detectedCliTypes).toEqual(['claude']);

    const rawLines = fs.readFileSync(cfg.getConfigFile(), 'utf-8').split(/\r?\n/);
    expect(rawLines[(findings[0].evidence.configLine.line ?? 0) - 1]).toContain('"cliType"');
  });

  test('refuses auto-correction when disk shape disagrees with both prefix and config', () => {
    isolateHome();
    const cfg = new ConfigManager();
    fs.mkdirSync(path.join(cfg.getConfigDir(), '..', '.claude-weird', 'user-history'), { recursive: true });
    cfg.writeProfiles([{
      name: 'claude-weird',
      commandName: 'claude-weird',
      cliType: 'codex',
      provider: 'openrouter',
      createdAt: '2026-05-17T00:00:00Z',
    } as any]);

    const findings = validateCliTypeConfig(cfg);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].suggestion).toBeNull();
    expect(findings[0].detail).toContain('LOUD WARNING');
    expect(findings[0].evidence.diskShape.detectedCliTypes).toEqual(['kimi']);

    const result = fixCliTypeOnProfile(cfg, 'claude-weird');
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('disk-conflict');
    expect(cfg.getProfiles()[0].cliType).toBe('codex');
  });
});

describe('fixCliTypeOnProfile', () => {
  test('rewrites cliType, leaves other fields alone, writes a backup', () => {
    isolateHome();
    const cfg = new ConfigManager();
    fs.mkdirSync(path.join(cfg.getConfigDir(), '..', '.claude-or-pole', 'projects'), { recursive: true });
    cfg.writeProfiles([{
      name: 'claude-or-pole',
      commandName: 'claude-or-pole',
      cliType: 'codex',
      provider: 'openrouter',
      createdAt: '2026-05-17T00:00:00Z',
      model: 'anthropic/claude-sonnet-4-6',
    } as any]);

    const result = fixCliTypeOnProfile(cfg, 'claude-or-pole');
    expect(result.changed).toBe(true);
    expect(result.from).toBe('codex');
    expect(result.to).toBe('claude');

    const updated = cfg.getProfiles().find(p => p.commandName === 'claude-or-pole');
    expect(updated?.cliType).toBe('claude');
    expect(updated?.model).toBe('anthropic/claude-sonnet-4-6'); // untouched

    // Backup file exists.
    const backups = fs.readdirSync(cfg.getBackupsDir())
      .filter(f => f.startsWith('config.json.cli_type_fix.') && f.endsWith('.bak'));
    expect(backups.length).toBe(1);
  });

  test('no-op for already-correct profile', () => {
    isolateHome();
    const cfg = new ConfigManager();
    cfg.writeProfiles([{
      name: 'claude-good',
      commandName: 'claude-good',
      cliType: 'claude',
      provider: 'anthropic',
      createdAt: '2026-05-17T00:00:00Z',
    } as any]);
    const result = fixCliTypeOnProfile(cfg, 'claude-good');
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('already-correct');
  });

  test('reports profile-not-found cleanly', () => {
    isolateHome();
    const cfg = new ConfigManager();
    const result = fixCliTypeOnProfile(cfg, 'nonexistent');
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('profile-not-found');
  });
});

describe('probeCodexBackend + classifyCodexBackend', () => {
  test('detects a Kimi-via-litellm codex profile', () => {
    const home = isolateHome();
    const dir = path.join(home, '.codex-kimi');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.toml'), [
      'model_provider = "kimi"',
      'model = "gpt-5.4"',
      '',
      '[model_providers.kimi]',
      'name = "Kimi (Moonshot)"',
      'base_url = "http://litellm.local/v1"',
      'wire_api = "responses"',
      'env_key = "KIMI_API_KEY"',
      '',
    ].join('\n'));
    const probe = probeCodexBackend(dir);
    expect(probe?.modelProvider).toBe('kimi');
    expect(probe?.providerName).toBe('Kimi (Moonshot)');
    expect(probe?.baseUrl).toBe('http://litellm.local/v1');
    expect(classifyCodexBackend('codex-kimi', probe!)).toBe('kimi');
  });

  test('detects a custom local backend (heretic-style llodge)', () => {
    const home = isolateHome();
    const dir = path.join(home, '.codex-heretic');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.toml'), [
      'model = "qwen36_27b_heretic"',
      'model_provider = "llodge"',
      '',
      '[model_providers.llodge]',
      'name = "llodge"',
      'base_url = "http://127.0.0.1:9000/api/llm/openai/v1"',
      'wire_api = "responses"',
      '',
    ].join('\n'));
    const probe = probeCodexBackend(dir);
    expect(classifyCodexBackend('codex-heretic', probe!)).toBe('custom');
  });

  test('returns null for pure OpenAI', () => {
    const home = isolateHome();
    const dir = path.join(home, '.codex-real-openai');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.toml'), [
      'model = "gpt-5.5"',
      'model_provider = "openai"',
      '',
      '[model_providers.openai]',
      'name = "OpenAI"',
      'base_url = "https://api.openai.com/v1"',
      '',
    ].join('\n'));
    const probe = probeCodexBackend(dir);
    expect(classifyCodexBackend('codex', probe!)).toBeNull();
  });

  test('returns null when no config.toml exists', () => {
    const home = isolateHome();
    const dir = path.join(home, '.codex-bare');
    fs.mkdirSync(dir);
    expect(probeCodexBackend(dir)).toBeNull();
  });
});

describe('auditProfiles provider_misconfig finding', () => {
  test('flags a codex-kimi profile whose provider says openai', async () => {
    const home = isolateHome();
    const cfg = new ConfigManager();
    const dir = path.join(home, '.codex-kimi');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: {} }));
    fs.writeFileSync(path.join(dir, 'config.toml'), [
      'model_provider = "kimi"',
      'model = "kimi-k2.6"',
      '[model_providers.kimi]',
      'name = "Kimi (Moonshot)"',
      'base_url = "https://api.moonshot.ai/v1"',
    ].join('\n'));
    cfg.writeProfiles([{
      name: 'codex-kimi',
      commandName: 'codex-kimi',
      cliType: 'codex',
      provider: 'openai',
      createdAt: '2026-05-17T00:00:00Z',
    } as any]);

    const report = await auditProfiles({ config: cfg, dormancyDays: 9999 });
    const misconfigs = report.findings.filter(f => f.kind === 'provider_misconfig');
    expect(misconfigs.length).toBe(1);
    expect((misconfigs[0].evidence as any).expectedProvider).toBe('kimi');
    expect(report.summary.provider_misconfig).toBe(1);
  });
});

describe('fixProviderOnProfile', () => {
  test('rewrites provider, writes a backup', () => {
    isolateHome();
    const cfg = new ConfigManager();
    cfg.writeProfiles([{
      name: 'codex-kimi',
      commandName: 'codex-kimi',
      cliType: 'codex',
      provider: 'openai',
      createdAt: '2026-05-17T00:00:00Z',
    } as any]);

    const result = fixProviderOnProfile(cfg, 'codex-kimi', 'kimi');
    expect(result.changed).toBe(true);
    expect(result.from).toBe('openai');
    expect(result.to).toBe('kimi');

    const updated = cfg.getProfiles().find(p => p.commandName === 'codex-kimi');
    expect(updated?.provider).toBe('kimi');

    const backups = fs.readdirSync(cfg.getBackupsDir())
      .filter(f => f.startsWith('config.json.provider_fix.') && f.endsWith('.bak'));
    expect(backups.length).toBe(1);
  });
});
