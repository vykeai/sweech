/**
 * Tests for codex config.toml writer (src/codexConfigToml.ts).
 *
 * Covers the bug where `sweech profile create --cli codex --provider <custom>`
 * wrote env vars to settings.json but never wrote a [model_providers.<name>]
 * block to $CODEX_HOME/config.toml — so codex fell through to the ChatGPT
 * OAuth login flow even when a custom provider was configured.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseToml,
  setTopLevelString,
  buildProviderBlock,
  shouldWriteCodexProviderBlock,
  sanitizeProviderName,
  providerEnvKey,
  writeCodexProviderToml,
  writeCodexProviderTomlForProfile,
  codexHomeFor,
  tomlEscape,
} from '../src/codexConfigToml';
import type { ProviderConfig } from '../src/providers';

// ── unit: tomlEscape ───────────────────────────────────────────────────────

describe('tomlEscape', () => {
  test('escapes backslash, quote, tab, newline, cr', () => {
    expect(tomlEscape('a\\b')).toBe('a\\\\b');
    expect(tomlEscape('he said "hi"')).toBe('he said \\"hi\\"');
    expect(tomlEscape('a\tb')).toBe('a\\tb');
    expect(tomlEscape('a\nb')).toBe('a\\nb');
    expect(tomlEscape('a\rb')).toBe('a\\rb');
  });

  test('leaves plain ascii alone', () => {
    expect(tomlEscape('moonshot-v1-128k')).toBe('moonshot-v1-128k');
  });
});

// ── unit: sanitizeProviderName ─────────────────────────────────────────────

describe('sanitizeProviderName', () => {
  test('lowercases and keeps alphanumerics', () => {
    expect(sanitizeProviderName('Kimi')).toBe('kimi');
    expect(sanitizeProviderName('OpenRouter')).toBe('openrouter');
  });

  test('replaces unsafe characters with hyphen', () => {
    expect(sanitizeProviderName('deepseek-openai')).toBe('deepseek-openai');
    expect(sanitizeProviderName('foo bar')).toBe('foo-bar');
    expect(sanitizeProviderName('a/b@c')).toBe('a-b-c');
  });

  test('falls back to "custom" for empty input', () => {
    expect(sanitizeProviderName('')).toBe('custom');
    expect(sanitizeProviderName('   ')).toBe('custom');
    expect(sanitizeProviderName('!!!')).toBe('custom');
  });

  test('strips leading/trailing hyphens', () => {
    expect(sanitizeProviderName('-foo-')).toBe('foo');
    expect(sanitizeProviderName('---a---')).toBe('a');
  });
});

// ── unit: providerEnvKey ───────────────────────────────────────────────────

describe('providerEnvKey', () => {
  test('uppercases and appends _API_KEY', () => {
    expect(providerEnvKey('kimi')).toBe('KIMI_API_KEY');
    expect(providerEnvKey('Custom')).toBe('CUSTOM_API_KEY');
  });

  test('converts hyphens to underscores', () => {
    expect(providerEnvKey('deepseek-openai')).toBe('DEEPSEEK_OPENAI_API_KEY');
    expect(providerEnvKey('qwen-openai')).toBe('QWEN_OPENAI_API_KEY');
  });

  test('handles edge-case providers', () => {
    expect(providerEnvKey('')).toBe('CUSTOM_API_KEY');
  });
});

// ── unit: shouldWriteCodexProviderBlock ────────────────────────────────────

describe('shouldWriteCodexProviderBlock', () => {
  test('returns false for non-codex CLIs', () => {
    expect(shouldWriteCodexProviderBlock('claude', 'kimi')).toBe(false);
    expect(shouldWriteCodexProviderBlock('kimi', 'kimi-coding')).toBe(false);
  });

  test('returns false for codex + openai (handled natively)', () => {
    expect(shouldWriteCodexProviderBlock('codex', 'openai')).toBe(false);
  });

  test('returns true for codex + any other provider', () => {
    expect(shouldWriteCodexProviderBlock('codex', 'kimi')).toBe(true);
    expect(shouldWriteCodexProviderBlock('codex', 'grok')).toBe(true);
    expect(shouldWriteCodexProviderBlock('codex', 'custom')).toBe(true);
    expect(shouldWriteCodexProviderBlock('codex', 'openrouter')).toBe(true);
    expect(shouldWriteCodexProviderBlock('codex', 'deepseek-openai')).toBe(true);
  });
});

// ── unit: buildProviderBlock ───────────────────────────────────────────────

describe('buildProviderBlock', () => {
  test('emits the required four fields', () => {
    const lines = buildProviderBlock({
      displayName: 'Kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      envKey: 'KIMI_API_KEY',
    });
    expect(lines).toEqual([
      'name = "Kimi"',
      'base_url = "https://api.moonshot.ai/v1"',
      'wire_api = "responses"',
      'env_key = "KIMI_API_KEY"',
    ]);
  });

  test('always uses wire_api = "responses" — never "chat"', () => {
    // Codex 0.x removed wire_api = "chat". This is the canary that catches
    // regressions where someone tries to emit the old format.
    const lines = buildProviderBlock({
      displayName: 'X',
      baseUrl: 'http://localhost:8080',
      envKey: 'X_API_KEY',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('wire_api = "responses"');
    expect(joined).not.toContain('"chat"');
  });

  test('escapes quotes and backslashes in values', () => {
    const lines = buildProviderBlock({
      displayName: 'Has "quote" and \\back',
      baseUrl: 'http://x/y\\z',
      envKey: 'K',
    });
    expect(lines[0]).toBe('name = "Has \\"quote\\" and \\\\back"');
    expect(lines[1]).toBe('base_url = "http://x/y\\\\z"');
  });
});

// ── unit: parseToml + setTopLevelString ────────────────────────────────────

describe('parseToml', () => {
  test('parses empty input', () => {
    const r = parseToml('');
    expect(r.topLines).toEqual(['']);
    expect(r.sections.size).toBe(0);
    expect(r.sectionOrder).toEqual([]);
  });

  test('preserves top-level comments and blank lines', () => {
    const r = parseToml('# hello\n\nfoo = "bar"\n');
    expect(r.topLines).toEqual(['# hello', '', 'foo = "bar"', '']);
    expect(r.sections.size).toBe(0);
  });

  test('parses section headers', () => {
    const r = parseToml('[a]\nx = 1\n[b.c]\ny = 2\n');
    expect(r.sectionOrder).toEqual(['a', 'b.c']);
    expect(r.sections.get('a')).toEqual(['x = 1']);
    expect(r.sections.get('b.c')).toEqual(['y = 2', '']);
  });

  test('round-trips dotted section names', () => {
    const r = parseToml('[model_providers.kimi]\nname = "Kimi"\n');
    expect(r.sectionOrder).toEqual(['model_providers.kimi']);
    expect(r.sections.get('model_providers.kimi')).toEqual(['name = "Kimi"', '']);
  });
});

describe('setTopLevelString', () => {
  test('appends a new key when not present', () => {
    const out = setTopLevelString([], 'model_provider', 'kimi');
    expect(out).toEqual(['model_provider = "kimi"']);
  });

  test('replaces an existing key inline', () => {
    const out = setTopLevelString(
      ['# header', 'model_provider = "old"', 'other = 1'],
      'model_provider',
      'kimi',
    );
    expect(out).toEqual([
      '# header',
      'model_provider = "kimi"',
      'other = 1',
    ]);
  });

  test('only replaces the first occurrence', () => {
    const out = setTopLevelString(
      ['model = "a"', 'model = "b"'],
      'model',
      'c',
    );
    expect(out).toEqual(['model = "c"', 'model = "b"']);
  });

  test('escapes embedded quotes', () => {
    const out = setTopLevelString([], 'foo', 'has "quote"');
    expect(out).toEqual(['foo = "has \\"quote\\""']);
  });
});

// ── integration: writeCodexProviderToml against a real tmpdir ─────────────

describe('writeCodexProviderToml — file IO', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-codex-toml-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('writes a Kimi-style provider block when config.toml does not exist', () => {
    writeCodexProviderToml({
      codexHome: tmpHome,
      providerName: 'kimi',
      displayName: 'Kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'moonshot-v1-128k',
    });

    const tomlPath = path.join(tmpHome, 'config.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
    const contents = fs.readFileSync(tomlPath, 'utf-8');
    expect(contents).toContain('[model_providers.kimi]');
    expect(contents).toContain('name = "Kimi"');
    expect(contents).toContain('base_url = "https://api.moonshot.ai/v1"');
    expect(contents).toContain('env_key = "KIMI_API_KEY"');
    expect(contents).toContain('model_provider = "kimi"');
    expect(contents).toContain('model = "moonshot-v1-128k"');
  });

  test('writes wire_api = "responses" — never "chat" (codex 0.x removed chat)', () => {
    writeCodexProviderToml({
      codexHome: tmpHome,
      providerName: 'grok',
      displayName: 'xAI Grok',
      baseUrl: 'https://api.x.ai/v1',
    });
    const contents = fs.readFileSync(path.join(tmpHome, 'config.toml'), 'utf-8');
    expect(contents).toContain('wire_api = "responses"');
    expect(contents).not.toMatch(/wire_api\s*=\s*"chat"/);
  });

  test('sets top-level model_provider to the sanitized provider name', () => {
    writeCodexProviderToml({
      codexHome: tmpHome,
      providerName: 'DeepSeek-OpenAI',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const contents = fs.readFileSync(path.join(tmpHome, 'config.toml'), 'utf-8');
    expect(contents).toContain('model_provider = "deepseek-openai"');
    expect(contents).toContain('[model_providers.deepseek-openai]');
  });

  test('preserves existing [model_providers.*] blocks when adding a new one', () => {
    const tomlPath = path.join(tmpHome, 'config.toml');
    const existing = [
      '# user-managed config',
      'model_provider = "custom-x"',
      '',
      '[model_providers.custom-x]',
      'name = "Custom X"',
      'base_url = "http://x.example/v1"',
      'wire_api = "responses"',
      'env_key = "CUSTOM_X_API_KEY"',
      '',
      '[mcp_servers.linear]',
      'command = "linear-mcp"',
      'args = ["--stdio"]',
      '',
    ].join('\n');
    fs.writeFileSync(tomlPath, existing);

    writeCodexProviderToml({
      codexHome: tmpHome,
      providerName: 'kimi',
      displayName: 'Kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'moonshot-v1-128k',
    });

    const merged = fs.readFileSync(tomlPath, 'utf-8');
    // New block landed
    expect(merged).toContain('[model_providers.kimi]');
    expect(merged).toContain('env_key = "KIMI_API_KEY"');
    // Existing custom-x block is intact
    expect(merged).toContain('[model_providers.custom-x]');
    expect(merged).toContain('name = "Custom X"');
    expect(merged).toContain('base_url = "http://x.example/v1"');
    expect(merged).toContain('env_key = "CUSTOM_X_API_KEY"');
    // Unrelated section is intact
    expect(merged).toContain('[mcp_servers.linear]');
    expect(merged).toContain('command = "linear-mcp"');
    expect(merged).toContain('args = ["--stdio"]');
    // Top-level model_provider was switched to the new one
    expect(merged).toContain('model_provider = "kimi"');
    expect(merged).not.toContain('model_provider = "custom-x"');
  });

  test('replaces an existing block for the same provider name (idempotent)', () => {
    writeCodexProviderToml({
      codexHome: tmpHome,
      providerName: 'kimi',
      displayName: 'Old Kimi',
      baseUrl: 'http://old.example/v1',
    });
    writeCodexProviderToml({
      codexHome: tmpHome,
      providerName: 'kimi',
      displayName: 'New Kimi',
      baseUrl: 'http://new.example/v1',
    });

    const contents = fs.readFileSync(path.join(tmpHome, 'config.toml'), 'utf-8');
    expect(contents).toContain('name = "New Kimi"');
    expect(contents).toContain('base_url = "http://new.example/v1"');
    expect(contents).not.toContain('"Old Kimi"');
    expect(contents).not.toContain('old.example');
    // Should still have exactly one [model_providers.kimi] block
    const matches = contents.match(/\[model_providers\.kimi\]/g);
    expect(matches).toHaveLength(1);
  });

  test('creates the codex home dir if missing', () => {
    const nested = path.join(tmpHome, 'nested', 'home');
    expect(fs.existsSync(nested)).toBe(false);
    writeCodexProviderToml({
      codexHome: nested,
      providerName: 'kimi',
      displayName: 'Kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
    expect(fs.existsSync(path.join(nested, 'config.toml'))).toBe(true);
  });

  test('written file has wire_api = responses for plain llama.cpp style URLs', () => {
    writeCodexProviderToml({
      codexHome: tmpHome,
      providerName: 'custom',
      displayName: 'llama.cpp local',
      baseUrl: 'http://localhost:8080',
    });
    const contents = fs.readFileSync(path.join(tmpHome, 'config.toml'), 'utf-8');
    expect(contents).toContain('wire_api = "responses"');
  });
});

// ── integration: writeCodexProviderTomlForProfile ──────────────────────────

describe('writeCodexProviderTomlForProfile', () => {
  let tmpHome: string;
  let originalHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-codex-prof-'));
    // Direct-assign through the require cache to dodge ESM getter
    // protections — `os.homedir` is `writable: true, configurable: true`
    // in node, but `import * as os` produces a frozen namespace under
    // ts-jest. The CommonJS form is mutable.
    const osMod = require('os');
    originalHomedir = osMod.homedir;
    osMod.homedir = () => tmpHome;
  });

  afterEach(() => {
    const osMod = require('os');
    osMod.homedir = originalHomedir;
    if (fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function mkProvider(over: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
      name: 'kimi',
      displayName: 'Kimi (Moonshot)',
      baseUrl: 'https://api.moonshot.ai/v1',
      defaultModel: 'moonshot-v1-128k',
      description: 'test',
      pricingModel: 'paid',
      compatibility: ['codex'],
      apiFormat: 'openai',
      ...over,
    };
  }

  test('does NOT write a block for the official openai provider', () => {
    writeCodexProviderTomlForProfile(
      'codex-default',
      mkProvider({ name: 'openai', displayName: 'OpenAI', baseUrl: '' }),
      'codex',
    );
    const tomlPath = path.join(tmpHome, '.codex-default', 'config.toml');
    expect(fs.existsSync(tomlPath)).toBe(false);
  });

  test('does NOT write a block for non-codex CLIs', () => {
    writeCodexProviderTomlForProfile(
      'claude-kimi',
      mkProvider(),
      'claude',
    );
    const tomlPath = path.join(tmpHome, '.claude-kimi', 'config.toml');
    expect(fs.existsSync(tomlPath)).toBe(false);
  });

  test('writes a block for codex + Kimi-style custom provider', () => {
    writeCodexProviderTomlForProfile('codex-kimi', mkProvider(), 'codex');
    const tomlPath = path.join(tmpHome, '.codex-kimi', 'config.toml');
    expect(fs.existsSync(tomlPath)).toBe(true);
    const contents = fs.readFileSync(tomlPath, 'utf-8');
    expect(contents).toContain('[model_providers.kimi]');
    expect(contents).toContain('base_url = "https://api.moonshot.ai/v1"');
    expect(contents).toContain('env_key = "KIMI_API_KEY"');
    expect(contents).toContain('wire_api = "responses"');
    expect(contents).toContain('model_provider = "kimi"');
    expect(contents).toContain('model = "moonshot-v1-128k"');
  });

  test('skips when codex provider has no base URL (nothing to point at)', () => {
    writeCodexProviderTomlForProfile(
      'codex-empty',
      mkProvider({ baseUrl: '' }),
      'codex',
    );
    const tomlPath = path.join(tmpHome, '.codex-empty', 'config.toml');
    expect(fs.existsSync(tomlPath)).toBe(false);
  });

  test('uses overrides for baseUrl and model when provided', () => {
    writeCodexProviderTomlForProfile(
      'codex-kimi',
      mkProvider(),
      'codex',
      'http://litellm.local/v1',
      'gpt-5.4',
    );
    const tomlPath = path.join(tmpHome, '.codex-kimi', 'config.toml');
    const contents = fs.readFileSync(tomlPath, 'utf-8');
    expect(contents).toContain('base_url = "http://litellm.local/v1"');
    expect(contents).toContain('model = "gpt-5.4"');
  });
});

// ── codexHomeFor sanity check ──────────────────────────────────────────────

describe('codexHomeFor', () => {
  test('returns ~/.{profileName}', () => {
    const result = codexHomeFor('codex-mini');
    expect(result).toBe(path.join(os.homedir(), '.codex-mini'));
  });

  test('returns a leading-dot dirname under the resolved home', () => {
    expect(codexHomeFor('codex-x')).toMatch(/[/\\]\.codex-x$/);
  });
});
