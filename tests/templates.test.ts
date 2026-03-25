/**
 * Tests for profile templates (templates.ts)
 */

import * as path from 'path';

const MOCK_HOME = '/mock/home';

jest.mock('fs');
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: jest.fn(() => MOCK_HOME),
}));

import * as fs from 'fs';

const mockFs = fs as jest.Mocked<typeof fs>;

import {
  BUILT_IN_TEMPLATES,
  ProfileTemplate,
  loadCustomTemplates,
  saveCustomTemplate,
  getAllTemplates,
  findTemplate,
} from '../src/templates';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CUSTOM_TEMPLATES_PATH = path.join(MOCK_HOME, '.sweech', 'templates.json');

function customTemplate(overrides: Partial<ProfileTemplate> = {}): ProfileTemplate {
  return {
    name: 'custom-test',
    description: 'Custom test template',
    cliType: 'claude',
    provider: 'custom',
    tags: ['custom', 'test'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// BUILT_IN_TEMPLATES
// ---------------------------------------------------------------------------

describe('BUILT_IN_TEMPLATES', () => {
  test('contains at least one template', () => {
    expect(BUILT_IN_TEMPLATES.length).toBeGreaterThan(0);
  });

  test('every built-in template has required fields', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(typeof t.cliType).toBe('string');
      expect(typeof t.provider).toBe('string');
      expect(Array.isArray(t.tags)).toBe(true);
    }
  });

  test('built-in names are unique', () => {
    const names = BUILT_IN_TEMPLATES.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('claude-pro template exists', () => {
    const cp = BUILT_IN_TEMPLATES.find(t => t.name === 'claude-pro');
    expect(cp).toBeDefined();
    expect(cp!.cliType).toBe('claude');
    expect(cp!.provider).toBe('anthropic');
  });

  test('codex-pro template exists', () => {
    const cx = BUILT_IN_TEMPLATES.find(t => t.name === 'codex-pro');
    expect(cx).toBeDefined();
    expect(cx!.cliType).toBe('codex');
    expect(cx!.provider).toBe('openai');
  });

  test('gemini-pro template exists', () => {
    const gp = BUILT_IN_TEMPLATES.find(t => t.name === 'gemini-pro');
    expect(gp).toBeDefined();
    expect(gp!.cliType).toBe('gemini');
    expect(gp!.provider).toBe('google');
  });

  test('local-ollama template has baseUrl', () => {
    const lo = BUILT_IN_TEMPLATES.find(t => t.name === 'local-ollama');
    expect(lo).toBeDefined();
    expect(lo!.baseUrl).toBe('http://localhost:11434');
  });
});

// ---------------------------------------------------------------------------
// loadCustomTemplates
// ---------------------------------------------------------------------------

describe('loadCustomTemplates', () => {
  test('returns empty array when file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = loadCustomTemplates();
    expect(result).toEqual([]);
  });

  test('returns empty array when file contains invalid JSON', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('not json {{{');

    const result = loadCustomTemplates();
    expect(result).toEqual([]);
  });

  test('returns empty array when file contains non-array JSON', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{"name":"not-array"}');

    const result = loadCustomTemplates();
    expect(result).toEqual([]);
  });

  test('returns parsed templates from valid JSON array', () => {
    const templates = [customTemplate({ name: 'my-tmpl' })];
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(templates));

    const result = loadCustomTemplates();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-tmpl');
  });

  test('returns multiple templates', () => {
    const templates = [
      customTemplate({ name: 'tmpl-a' }),
      customTemplate({ name: 'tmpl-b' }),
    ];
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(templates));

    const result = loadCustomTemplates();
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// saveCustomTemplate
// ---------------------------------------------------------------------------

describe('saveCustomTemplate', () => {
  test('creates .sweech dir if it does not exist', () => {
    // First call: existsSync for SWEECH_DIR -> false
    // readFileSync inside loadCustomTemplates needs existsSync for templates file -> false
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockImplementation(() => undefined as any);
    mockFs.writeFileSync.mockImplementation(() => {});

    saveCustomTemplate(customTemplate());

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.sweech'),
      { recursive: true }
    );
  });

  test('appends a new template when none exist yet', () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      // .sweech dir exists but templates.json does not
      if (String(p).endsWith('.sweech')) return true;
      return false;
    });
    mockFs.writeFileSync.mockImplementation(() => {});

    saveCustomTemplate(customTemplate({ name: 'new-one' }));

    const [filePath, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    expect(filePath).toContain('templates.json');
    const parsed = JSON.parse(content as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('new-one');
  });

  test('replaces an existing template with the same name', () => {
    const existing = [customTemplate({ name: 'replace-me', description: 'old' })];
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(existing));
    mockFs.writeFileSync.mockImplementation(() => {});

    saveCustomTemplate(customTemplate({ name: 'replace-me', description: 'new' }));

    const [, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].description).toBe('new');
  });

  test('appends when names differ', () => {
    const existing = [customTemplate({ name: 'existing' })];
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(existing));
    mockFs.writeFileSync.mockImplementation(() => {});

    saveCustomTemplate(customTemplate({ name: 'brand-new' }));

    const [, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((t: any) => t.name)).toEqual(['existing', 'brand-new']);
  });

  test('handles special characters in template fields', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('[]');
    mockFs.writeFileSync.mockImplementation(() => {});

    const special = customTemplate({
      name: 'special-chars',
      description: 'Template with "quotes" & <angle> brackets',
      tags: ['tag with spaces', 'emoji-🚀'],
    });

    saveCustomTemplate(special);

    const [, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed[0].description).toBe('Template with "quotes" & <angle> brackets');
    expect(parsed[0].tags).toContain('tag with spaces');
    expect(parsed[0].tags).toContain('emoji-🚀');
  });
});

// ---------------------------------------------------------------------------
// getAllTemplates
// ---------------------------------------------------------------------------

describe('getAllTemplates', () => {
  test('returns built-in templates when no custom templates exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    const all = getAllTemplates();
    expect(all.length).toBe(BUILT_IN_TEMPLATES.length);
    expect(all.map(t => t.name)).toEqual(BUILT_IN_TEMPLATES.map(t => t.name));
  });

  test('includes custom templates after built-in ones', () => {
    const custom = [customTemplate({ name: 'my-custom' })];
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(custom));

    const all = getAllTemplates();
    expect(all.length).toBe(BUILT_IN_TEMPLATES.length + 1);
    expect(all[all.length - 1].name).toBe('my-custom');
  });

  test('custom template overrides built-in with same name', () => {
    const custom = [customTemplate({ name: 'claude-pro', description: 'My override' })];
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(custom));

    const all = getAllTemplates();
    // Should not have duplicate claude-pro
    const claudePros = all.filter(t => t.name === 'claude-pro');
    expect(claudePros).toHaveLength(1);
    expect(claudePros[0].description).toBe('My override');
  });

  test('multiple custom templates that override different built-ins', () => {
    const custom = [
      customTemplate({ name: 'claude-pro', description: 'Custom Claude' }),
      customTemplate({ name: 'codex-pro', description: 'Custom Codex' }),
    ];
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(custom));

    const all = getAllTemplates();
    // Two built-ins replaced, so total should be built-in count (minus 2) + 2 custom
    expect(all.length).toBe(BUILT_IN_TEMPLATES.length);

    const cp = all.find(t => t.name === 'claude-pro');
    expect(cp!.description).toBe('Custom Claude');
    const cx = all.find(t => t.name === 'codex-pro');
    expect(cx!.description).toBe('Custom Codex');
  });
});

// ---------------------------------------------------------------------------
// findTemplate
// ---------------------------------------------------------------------------

describe('findTemplate', () => {
  beforeEach(() => {
    // No custom templates for most tests
    mockFs.existsSync.mockReturnValue(false);
  });

  test('finds by exact name match (case-insensitive)', () => {
    const result = findTemplate('claude-pro');
    expect(result).toBeDefined();
    expect(result!.name).toBe('claude-pro');
  });

  test('exact match is case-insensitive', () => {
    const result = findTemplate('CLAUDE-PRO');
    expect(result).toBeDefined();
    expect(result!.name).toBe('claude-pro');
  });

  test('returns undefined for completely unknown query', () => {
    const result = findTemplate('nonexistent-xyzzy-42');
    expect(result).toBeUndefined();
  });

  test('partial match on name substring', () => {
    const result = findTemplate('ollama');
    expect(result).toBeDefined();
    expect(result!.name).toBe('local-ollama');
  });

  test('partial match on tag', () => {
    const result = findTemplate('self-hosted');
    expect(result).toBeDefined();
    expect(result!.name).toBe('local-ollama');
  });

  test('exact name match takes priority over partial', () => {
    // "codex-pro" is both an exact name AND a partial match for other templates
    const result = findTemplate('codex-pro');
    expect(result).toBeDefined();
    expect(result!.name).toBe('codex-pro');
  });

  test('finds template by tag search', () => {
    const result = findTemplate('multi-model');
    expect(result).toBeDefined();
    expect(result!.name).toBe('openrouter-default');
  });

  test('finds custom template by name when custom templates exist', () => {
    const custom = [customTemplate({ name: 'my-special', tags: ['special'] })];
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(custom));

    const result = findTemplate('my-special');
    expect(result).toBeDefined();
    expect(result!.name).toBe('my-special');
  });

  test('partial query is case-insensitive', () => {
    const result = findTemplate('ANTHROPIC');
    expect(result).toBeDefined();
    // Should match a template with 'anthropic' tag
    expect(result!.tags).toContain('anthropic');
  });

  test('returns undefined for empty query matching nothing specific', () => {
    // empty string would match everything; first result is returned
    // This tests the function doesn't crash; it returns the first partial match
    const result = findTemplate('');
    // An empty query lowercased is '' which is included in every name
    // so it should return the first template
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Missing template errors & edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('loadCustomTemplates handles readFileSync throwing', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = loadCustomTemplates();
    expect(result).toEqual([]);
  });

  test('template with optional model field is preserved', () => {
    const tmpl = customTemplate({ name: 'with-model', model: 'gpt-4o' });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify([tmpl]));
    mockFs.writeFileSync.mockImplementation(() => {});

    const loaded = loadCustomTemplates();
    expect(loaded[0].model).toBe('gpt-4o');
  });

  test('template with optional baseUrl field is preserved', () => {
    const tmpl = customTemplate({ name: 'with-url', baseUrl: 'http://localhost:8080' });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify([tmpl]));

    const loaded = loadCustomTemplates();
    expect(loaded[0].baseUrl).toBe('http://localhost:8080');
  });

  test('getAllTemplates with empty custom array returns only built-ins', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('[]');

    const all = getAllTemplates();
    expect(all.length).toBe(BUILT_IN_TEMPLATES.length);
  });

  test('saveCustomTemplate persists model and baseUrl fields', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('[]');
    mockFs.writeFileSync.mockImplementation(() => {});

    saveCustomTemplate(customTemplate({
      name: 'full-template',
      model: 'claude-3',
      baseUrl: 'https://api.example.com',
    }));

    const [, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    const parsed = JSON.parse(content as string);
    expect(parsed[0].model).toBe('claude-3');
    expect(parsed[0].baseUrl).toBe('https://api.example.com');
  });
});
