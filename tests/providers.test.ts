/**
 * Tests for provider configurations
 */

import {
  getProvider,
  getProviderList,
  getProvidersForCLI,
  isProviderCompatible,
  getProvidersByFormat,
  PROVIDERS
} from '../src/providers';

describe('Provider Management', () => {
  describe('getProvider', () => {
    test('returns correct provider config', () => {
      const minimax = getProvider('minimax');
      expect(minimax).toBeDefined();
      expect(minimax?.name).toBe('minimax');
      expect(minimax?.displayName).toBe('MiniMax');
      expect(minimax?.baseUrl).toBe('https://api.minimax.io/anthropic');
    });

    test('returns undefined for unknown provider', () => {
      const unknown = getProvider('unknown-provider');
      expect(unknown).toBeUndefined();
    });

    test('all providers have required fields', () => {
      Object.values(PROVIDERS).forEach(provider => {
        expect(provider.name).toBeDefined();
        expect(provider.displayName).toBeDefined();
        expect(provider.baseUrl).toBeDefined();
        expect(provider.defaultModel).toBeDefined();
        expect(provider.description).toBeDefined();
        expect(provider.compatibility).toBeDefined();
        expect(Array.isArray(provider.compatibility)).toBe(true);
        expect(provider.apiFormat).toBeDefined();
        expect(['anthropic', 'openai']).toContain(provider.apiFormat);
      });
    });

    test('all providers have valid compatibility', () => {
      Object.values(PROVIDERS).forEach(provider => {
        expect(provider.compatibility.length).toBeGreaterThan(0);
        provider.compatibility.forEach(cli => {
          expect(['claude', 'codex']).toContain(cli);
        });
      });
    });
  });

  describe('getProviderList', () => {
    test('returns array of providers', () => {
      const list = getProviderList();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
    });

    test('each item has name and value', () => {
      const list = getProviderList();
      list.forEach(item => {
        expect(item.name).toBeDefined();
        expect(item.value).toBeDefined();
        expect(typeof item.name).toBe('string');
        expect(typeof item.value).toBe('string');
      });
    });

    test('includes all major providers', () => {
      const list = getProviderList();
      const values = list.map(item => item.value);

      // Anthropic-compatible
      expect(values).toContain('anthropic');
      expect(values).toContain('minimax');
      expect(values).toContain('qwen');
      expect(values).toContain('kimi');
      expect(values).toContain('deepseek');
      expect(values).toContain('glm');

      // OpenAI-compatible
      expect(values).toContain('deepseek-openai');
      expect(values).toContain('qwen-openai');
      expect(values).toContain('openrouter');

      // Custom
      expect(values).toContain('custom');
    });

    test('filters providers by CLI type', () => {
      const claudeProviders = getProviderList('claude');
      const codexProviders = getProviderList('codex');

      // Check that filtering works
      expect(claudeProviders.length).toBeGreaterThan(0);
      expect(codexProviders.length).toBeGreaterThan(0);

      // Anthropic providers should only be in claude list
      const claudeValues = claudeProviders.map(p => p.value);
      expect(claudeValues).toContain('anthropic');
      expect(claudeValues).toContain('qwen'); // Anthropic-compatible version

      // OpenAI providers should only be in codex list
      const codexValues = codexProviders.map(p => p.value);
      expect(codexValues).toContain('deepseek-openai');
      expect(codexValues).toContain('qwen-openai');
      expect(codexValues).toContain('openrouter');
    });

    test('returns all providers when no CLI type specified', () => {
      const allProviders = getProviderList();
      const claudeProviders = getProviderList('claude');
      const codexProviders = getProviderList('codex');

      expect(allProviders.length).toBeGreaterThanOrEqual(
        Math.max(claudeProviders.length, codexProviders.length)
      );
    });
  });

  describe('getProvidersForCLI', () => {
    test('returns Claude-compatible providers', () => {
      const claudeProviders = getProvidersForCLI('claude');

      expect(claudeProviders.length).toBeGreaterThan(0);
      claudeProviders.forEach(provider => {
        expect(provider.compatibility).toContain('claude');
      });
    });

    test('returns Codex-compatible providers', () => {
      const codexProviders = getProvidersForCLI('codex');

      expect(codexProviders.length).toBeGreaterThan(0);
      codexProviders.forEach(provider => {
        expect(provider.compatibility).toContain('codex');
      });
    });

    test('Anthropic providers use anthropic API format', () => {
      const claudeProviders = getProvidersForCLI('claude');
      const anthropicFormatProviders = claudeProviders.filter(
        p => p.apiFormat === 'anthropic' && !p.isCustom
      );

      expect(anthropicFormatProviders.length).toBeGreaterThan(0);
      anthropicFormatProviders.forEach(provider => {
        expect(provider.apiFormat).toBe('anthropic');
      });
    });

    test('OpenAI-compatible providers use openai API format', () => {
      const codexProviders = getProvidersForCLI('codex');
      const openaiFormatProviders = codexProviders.filter(
        p => p.apiFormat === 'openai' && !p.isCustom
      );

      expect(openaiFormatProviders.length).toBeGreaterThan(0);
      openaiFormatProviders.forEach(provider => {
        expect(provider.apiFormat).toBe('openai');
      });
    });
  });

  describe('isProviderCompatible', () => {
    test('returns true for compatible provider-CLI pairs', () => {
      expect(isProviderCompatible('anthropic', 'claude')).toBe(true);
      expect(isProviderCompatible('qwen', 'claude')).toBe(true);
      expect(isProviderCompatible('deepseek-openai', 'codex')).toBe(true);
      expect(isProviderCompatible('openrouter', 'codex')).toBe(true);
    });

    test('returns false for incompatible provider-CLI pairs', () => {
      expect(isProviderCompatible('anthropic', 'codex')).toBe(false);
      expect(isProviderCompatible('openrouter', 'claude')).toBe(false);
    });

    test('returns false for unknown providers', () => {
      expect(isProviderCompatible('unknown-provider', 'claude')).toBe(false);
      expect(isProviderCompatible('unknown-provider', 'codex')).toBe(false);
    });

    test('custom provider is compatible with both CLIs', () => {
      expect(isProviderCompatible('custom', 'claude')).toBe(true);
      expect(isProviderCompatible('custom', 'codex')).toBe(true);
    });
  });

  describe('getProvidersByFormat', () => {
    test('groups providers by API format', () => {
      const grouped = getProvidersByFormat();

      expect(grouped).toHaveProperty('anthropic');
      expect(grouped).toHaveProperty('openai');
      expect(Array.isArray(grouped.anthropic)).toBe(true);
      expect(Array.isArray(grouped.openai)).toBe(true);
    });

    test('anthropic group contains Anthropic-compatible providers', () => {
      const grouped = getProvidersByFormat();

      expect(grouped.anthropic.length).toBeGreaterThan(0);
      grouped.anthropic.forEach(provider => {
        expect(provider.apiFormat).toBe('anthropic');
      });
    });

    test('openai group contains OpenAI-compatible providers', () => {
      const grouped = getProvidersByFormat();

      expect(grouped.openai.length).toBeGreaterThan(0);
      grouped.openai.forEach(provider => {
        expect(provider.apiFormat).toBe('openai');
      });
    });

    test('all providers are in exactly one group', () => {
      const grouped = getProvidersByFormat();
      const allProviders = Object.values(PROVIDERS);
      const groupedCount = grouped.anthropic.length + grouped.openai.length;

      expect(groupedCount).toBe(allProviders.length);
    });
  });

  describe('Provider Compatibility Matrix', () => {
    test('DeepSeek has both Anthropic and OpenAI variants', () => {
      const deepseek = getProvider('deepseek');
      const deepseekOpenai = getProvider('deepseek-openai');

      expect(deepseek).toBeDefined();
      expect(deepseekOpenai).toBeDefined();
      expect(deepseek?.compatibility).toContain('claude');
      expect(deepseekOpenai?.compatibility).toContain('codex');
    });

    test('Qwen has both Anthropic and OpenAI variants', () => {
      const qwen = getProvider('qwen');
      const qwenOpenai = getProvider('qwen-openai');

      expect(qwen).toBeDefined();
      expect(qwenOpenai).toBeDefined();
      expect(qwen?.compatibility).toContain('claude');
      expect(qwenOpenai?.compatibility).toContain('codex');
    });

    test('OpenRouter is Codex-only', () => {
      const openrouter = getProvider('openrouter');

      expect(openrouter).toBeDefined();
      expect(openrouter?.compatibility).toEqual(['codex']);
      expect(openrouter?.apiFormat).toBe('openai');
    });

    test('Anthropic is Claude-only', () => {
      const anthropic = getProvider('anthropic');

      expect(anthropic).toBeDefined();
      expect(anthropic?.compatibility).toEqual(['claude']);
      expect(anthropic?.apiFormat).toBe('anthropic');
    });
  });

  describe('Custom Provider', () => {
    test('custom provider exists', () => {
      const custom = getProvider('custom');

      expect(custom).toBeDefined();
      expect(custom?.isCustom).toBe(true);
    });

    test('custom provider is compatible with both CLIs', () => {
      const custom = getProvider('custom');

      expect(custom?.compatibility).toContain('claude');
      expect(custom?.compatibility).toContain('codex');
    });

    test('custom provider has empty baseUrl and model', () => {
      const custom = getProvider('custom');

      expect(custom?.baseUrl).toBe('');
      expect(custom?.defaultModel).toBe('');
    });
  });
});
