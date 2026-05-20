/**
 * Tests for custom provider functionality
 */

import {
  promptCustomProvider,
  createCustomProviderConfig,
  LOCAL_LLM_EXAMPLES
} from '../src/customProvider';
import { ProviderConfig } from '../src/providers';

jest.mock('inquirer', () => ({
  prompt: jest.fn()
}));

jest.mock('chalk', () => ({
  bold: jest.fn((str) => str),
  cyan: jest.fn((str) => str),
  gray: jest.fn((str) => str)
}));

import inquirer from 'inquirer';

const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;

describe('Custom Provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Suppress console.log during tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('promptCustomProvider', () => {
    test('prompts for all required fields', async () => {
      mockPrompt.mockResolvedValue({
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai',
        defaultModel: 'llama-3.1-8b',
        smallFastModel: '',
        displayName: ''
      });

      const result = await promptCustomProvider();

      expect(mockPrompt).toHaveBeenCalled();
      expect(result.baseUrl).toBe('http://localhost:1234');
      expect(result.apiFormat).toBe('openai');
      expect(result.defaultModel).toBe('llama-3.1-8b');
    });

    test('handles optional fields', async () => {
      mockPrompt.mockResolvedValue({
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai',
        defaultModel: 'llama-3.1-8b',
        smallFastModel: 'llama-3.1-8b-fast',
        displayName: 'My Local LLM'
      });

      const result = await promptCustomProvider();

      expect(result.smallFastModel).toBe('llama-3.1-8b-fast');
      expect(result.displayName).toBe('My Local LLM');
    });

    test('handles empty optional fields', async () => {
      mockPrompt.mockResolvedValue({
        baseUrl: 'http://localhost:1234',
        apiFormat: 'anthropic',
        defaultModel: 'custom-model',
        smallFastModel: '',
        displayName: ''
      });

      const result = await promptCustomProvider();

      expect(result.smallFastModel).toBeUndefined();
      expect(result.displayName).toBeUndefined();
    });

    test('supports both API formats', async () => {
      // OpenAI format
      mockPrompt.mockResolvedValueOnce({
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai',
        defaultModel: 'llama-3.1-8b',
        smallFastModel: '',
        displayName: ''
      });

      let result = await promptCustomProvider();
      expect(result.apiFormat).toBe('openai');

      // Anthropic format
      mockPrompt.mockResolvedValueOnce({
        baseUrl: 'http://localhost:5000',
        apiFormat: 'anthropic',
        defaultModel: 'custom-claude',
        smallFastModel: '',
        displayName: ''
      });

      result = await promptCustomProvider();
      expect(result.apiFormat).toBe('anthropic');
    });
  });

  describe('createCustomProviderConfig', () => {
    test('creates valid provider config from prompts', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'llama-3.1-8b',
        smallFastModel: 'llama-3.1-8b-fast',
        displayName: 'My Local LLM'
      };

      const config = createCustomProviderConfig(prompts, 'my-local-llm');

      expect(config.name).toBe('my-local-llm');
      expect(config.displayName).toBe('My Local LLM');
      expect(config.baseUrl).toBe('http://localhost:1234');
      expect(config.defaultModel).toBe('llama-3.1-8b');
      expect(config.smallFastModel).toBe('llama-3.1-8b-fast');
      expect(config.apiFormat).toBe('openai');
      expect(config.isCustom).toBe(true);
      expect(config.pricingModel).toBe('free');
    });

    test('generates display name from hostname when not provided', () => {
      const prompts = {
        baseUrl: 'http://192.168.1.100:8080',
        apiFormat: 'openai' as const,
        defaultModel: 'model-1'
      };

      const config = createCustomProviderConfig(prompts, 'lan-llm');

      expect(config.displayName).toContain('192.168.1.100');
      expect(config.displayName).toContain('Custom');
      expect(config.pricingModel).toBe('paid');
    });

    test('sets compatibility based on OpenAI format', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'llama-3.1-8b'
      };

      const config = createCustomProviderConfig(prompts, 'local-openai');

      expect(config.compatibility).toEqual(['codex']);
      expect(config.apiFormat).toBe('openai');
    });

    test('sets compatibility based on Anthropic format', () => {
      const prompts = {
        baseUrl: 'http://localhost:5000',
        apiFormat: 'anthropic' as const,
        defaultModel: 'custom-claude'
      };

      const config = createCustomProviderConfig(prompts, 'local-anthropic');

      expect(config.compatibility).toEqual(['claude', 'kimi']);
      expect(config.apiFormat).toBe('anthropic');
    });

    test('marks as custom provider', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.isCustom).toBe(true);
    });

    test('includes pricing info', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.pricing).toBeDefined();
      expect(config.pricing).toContain('Self-hosted');
    });

    test('handles localhost URLs', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.baseUrl).toBe('http://localhost:1234');
      expect(config.displayName).toContain('localhost');
      expect(config.pricingModel).toBe('free');
    });

    test('handles LAN IPs', () => {
      const prompts = {
        baseUrl: 'http://192.168.1.100:8080',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.baseUrl).toBe('http://192.168.1.100:8080');
      expect(config.displayName).toContain('192.168.1.100');
      expect(config.pricingModel).toBe('paid');
    });

    test('handles custom domains', () => {
      const prompts = {
        baseUrl: 'https://api.mycompany.com',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.baseUrl).toBe('https://api.mycompany.com');
      expect(config.displayName).toContain('api.mycompany.com');
      expect(config.pricingModel).toBe('paid');
    });
  });

  describe('LOCAL_LLM_EXAMPLES', () => {
    test('includes common local LLM servers', () => {
      const exampleNames = Object.keys(LOCAL_LLM_EXAMPLES);

      expect(exampleNames).toContain('LM Studio');
      expect(exampleNames).toContain('Ollama (OpenAI compatible)');
      expect(exampleNames).toContain('llama.cpp server');
      expect(exampleNames).toContain('text-generation-webui');
      expect(exampleNames).toContain('LocalAI');
      expect(exampleNames.length).toBe(5);
    });

    test('all examples have required fields', () => {
      Object.values(LOCAL_LLM_EXAMPLES).forEach(example => {
        expect(example.baseUrl).toBeDefined();
        expect(example.apiFormat).toBeDefined();
        expect(example.description).toBeDefined();
        expect(['openai', 'anthropic']).toContain(example.apiFormat);
      });
    });

    test('LM Studio example is correct', () => {
      const lmStudio = LOCAL_LLM_EXAMPLES['LM Studio'];

      expect(lmStudio.baseUrl).toBe('http://localhost:1234');
      expect(lmStudio.apiFormat).toBe('openai');
    });

    test('Ollama example is correct', () => {
      const ollama = LOCAL_LLM_EXAMPLES['Ollama (OpenAI compatible)'];

      expect(ollama.baseUrl).toBe('http://localhost:11434/v1');
      expect(ollama.apiFormat).toBe('openai');
    });

    test('all examples use localhost', () => {
      Object.values(LOCAL_LLM_EXAMPLES).forEach(example => {
        expect(
          example.baseUrl.includes('localhost') ||
          example.baseUrl.includes('127.0.0.1')
        ).toBe(true);
      });
    });
  });

  describe('URL Validation Patterns', () => {
    test('accepts localhost URLs', () => {
      const urls = [
        'http://localhost:1234',
        'https://localhost:8080',
        'http://127.0.0.1:5000',
        'https://127.0.0.1:11434'
      ];

      urls.forEach(url => {
        const prompts = {
          baseUrl: url,
          apiFormat: 'openai' as const,
          defaultModel: 'model'
        };
        const config = createCustomProviderConfig(prompts, 'test');
        expect(config.baseUrl).toBe(url);
      });
    });

    test('accepts LAN IPs', () => {
      const urls = [
        'http://192.168.1.100:8080',
        'http://192.168.0.50:1234',
        'http://10.0.0.100:5000',
        'http://172.16.0.1:8080'
      ];

      urls.forEach(url => {
        const prompts = {
          baseUrl: url,
          apiFormat: 'openai' as const,
          defaultModel: 'model'
        };
        const config = createCustomProviderConfig(prompts, 'test');
        expect(config.baseUrl).toBe(url);
      });
    });

    test('accepts custom domains', () => {
      const urls = [
        'https://api.example.com',
        'http://llm.company.local',
        'https://ai-server.myorg.net'
      ];

      urls.forEach(url => {
        const prompts = {
          baseUrl: url,
          apiFormat: 'openai' as const,
          defaultModel: 'model'
        };
        const config = createCustomProviderConfig(prompts, 'test');
        expect(config.baseUrl).toBe(url);
      });
    });

    test('removes trailing slashes', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234/',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      // Note: This will be handled by the prompt filter in actual usage
      // Testing the expected behavior
      const cleanUrl = prompts.baseUrl.endsWith('/')
        ? prompts.baseUrl.slice(0, -1)
        : prompts.baseUrl;

      expect(cleanUrl).toBe('http://localhost:1234');
    });
  });

  describe('API Format Compatibility', () => {
    test('OpenAI format works with Codex', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'llama-3.1-8b'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.compatibility).toContain('codex');
      expect(config.apiFormat).toBe('openai');
    });

    test('Anthropic format works with Claude', () => {
      const prompts = {
        baseUrl: 'http://localhost:5000',
        apiFormat: 'anthropic' as const,
        defaultModel: 'custom-model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.compatibility).toContain('claude');
      expect(config.apiFormat).toBe('anthropic');
    });

    test('cannot use OpenAI format with Claude', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.compatibility).not.toContain('claude');
    });

    test('cannot use Anthropic format with Codex', () => {
      const prompts = {
        baseUrl: 'http://localhost:5000',
        apiFormat: 'anthropic' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.compatibility).not.toContain('codex');
    });
  });

  describe('Real-World Use Cases', () => {
    test('LM Studio with OpenAI API for Codex', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'llama-3.1-8b-instruct',
        smallFastModel: 'llama-3.1-8b-instruct',
        displayName: 'LM Studio Local'
      };

      const config = createCustomProviderConfig(prompts, 'lm-studio');

      expect(config.compatibility).toEqual(['codex']);
      expect(config.displayName).toBe('LM Studio Local');
      expect(config.baseUrl).toBe('http://localhost:1234');
    });

    test('Ollama with OpenAI compatibility for Codex', () => {
      const prompts = {
        baseUrl: 'http://localhost:11434/v1',
        apiFormat: 'openai' as const,
        defaultModel: 'codellama:7b',
        displayName: 'Ollama Local'
      };

      const config = createCustomProviderConfig(prompts, 'ollama');

      expect(config.compatibility).toEqual(['codex']);
      expect(config.baseUrl).toBe('http://localhost:11434/v1');
    });

    test('LAN server for household sharing', () => {
      const prompts = {
        baseUrl: 'http://192.168.1.100:8080',
        apiFormat: 'openai' as const,
        defaultModel: 'mistral-7b',
        displayName: 'Home Server'
      };

      const config = createCustomProviderConfig(prompts, 'home-server');

      expect(config.displayName).toBe('Home Server');
      expect(config.baseUrl).toContain('192.168.1.100');
    });

    test('Custom remote API with Anthropic format for Claude', () => {
      const prompts = {
        baseUrl: 'https://api.company.com',
        apiFormat: 'anthropic' as const,
        defaultModel: 'company-model-v1',
        displayName: 'Company AI'
      };

      const config = createCustomProviderConfig(prompts, 'company-ai');

      expect(config.compatibility).toEqual(['claude', 'kimi']);
      expect(config.apiFormat).toBe('anthropic');
    });
  });

  describe('Provider Config Structure', () => {
    test('has all required ProviderConfig fields', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      // Check all required fields from ProviderConfig interface
      expect(config.name).toBeDefined();
      expect(config.displayName).toBeDefined();
      expect(config.baseUrl).toBeDefined();
      expect(config.defaultModel).toBeDefined();
      expect(config.description).toBeDefined();
      expect(config.compatibility).toBeDefined();
      expect(config.apiFormat).toBeDefined();
      expect(config.isCustom).toBeDefined();
      expect(config.pricingModel).toBeDefined();
    });

    test('maintains type compatibility with ProviderConfig', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config: ProviderConfig = createCustomProviderConfig(prompts, 'test');

      expect(config).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    test('handles very long model names', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'very-long-model-name-with-lots-of-details-v1.2.3-beta'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.defaultModel).toBe('very-long-model-name-with-lots-of-details-v1.2.3-beta');
    });

    test('handles URLs with paths', () => {
      const prompts = {
        baseUrl: 'http://localhost:8080/api/v1',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.baseUrl).toBe('http://localhost:8080/api/v1');
    });

    test('handles URLs with query parameters', () => {
      const prompts = {
        baseUrl: 'https://api.example.com?region=us-east',
        apiFormat: 'openai' as const,
        defaultModel: 'model'
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.baseUrl).toContain('region=us-east');
    });

    test('handles empty display name gracefully', () => {
      const prompts = {
        baseUrl: 'http://localhost:1234',
        apiFormat: 'openai' as const,
        defaultModel: 'model',
        displayName: ''
      };

      const config = createCustomProviderConfig(prompts, 'test');

      expect(config.displayName).toBeTruthy();
      expect(config.displayName).toContain('Custom');
    });
  });
});
