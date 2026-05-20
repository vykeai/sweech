/**
 * Custom provider setup for local/self-hosted LLMs
 * Supports localhost, LAN, and custom remote hosts
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { ProviderConfig, APIFormat, classifyPricingModel } from './providers';

export interface CustomProviderPrompts {
  baseUrl: string;
  apiFormat: APIFormat;
  defaultModel: string;
  smallFastModel?: string;
  displayName?: string;
}

/**
 * Validate URL format (allows localhost, IP addresses, and domains)
 */
function validateUrl(input: string): boolean | string {
  if (!input || input.trim().length === 0) {
    return 'Base URL is required';
  }

  const trimmed = input.trim();

  // Allow localhost variations
  if (
    trimmed.startsWith('http://localhost') ||
    trimmed.startsWith('https://localhost') ||
    trimmed.startsWith('http://127.0.0.1') ||
    trimmed.startsWith('https://127.0.0.1')
  ) {
    return true;
  }

  // Allow local network IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  const localIpPattern = /^https?:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3})/;
  if (localIpPattern.test(trimmed)) {
    return true;
  }

  // Allow standard URLs
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return true;
    }
    return 'URL must use http:// or https://';
  } catch {
    return 'Invalid URL format. Examples:\n  - http://localhost:1234\n  - http://192.168.1.100:8080\n  - https://api.example.com';
  }
}

/**
 * Prompt user for custom provider configuration
 */
export async function promptCustomProvider(): Promise<CustomProviderPrompts> {
  console.log(chalk.bold('\n🔧 Custom Provider Setup\n'));
  console.log(chalk.gray('Configure a local or self-hosted LLM provider\n'));

  console.log(chalk.cyan('Examples:'));
  console.log(chalk.gray('  Local:     http://localhost:1234'));
  console.log(chalk.gray('  LAN:       http://192.168.1.100:8080'));
  console.log(chalk.gray('  Remote:    https://api.your-server.com'));
  console.log();

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Base URL:',
      validate: validateUrl,
      filter: (input: string) => {
        const trimmed = input.trim();
        // Remove trailing slash if present
        return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
      }
    },
    {
      type: 'list',
      name: 'apiFormat',
      message: 'API format:',
      choices: [
        {
          name: 'OpenAI-compatible (GPT, Codex, LM Studio, llama.cpp, etc.)',
          value: 'openai'
        },
        {
          name: 'Anthropic-compatible (Claude API format)',
          value: 'anthropic'
        }
      ],
      default: 'openai'
    },
    {
      type: 'input',
      name: 'defaultModel',
      message: 'Default model name:',
      validate: (input: string) => {
        if (!input || input.trim().length === 0) {
          return 'Model name is required';
        }
        return true;
      },
      default: (answers: any) => {
        // Suggest defaults based on common setups
        if (answers.apiFormat === 'openai') {
          return 'gpt-3.5-turbo'; // Common default for OpenAI-compatible
        }
        return 'claude-sonnet-4-5'; // Common default for Anthropic-compatible
      }
    },
    {
      type: 'input',
      name: 'smallFastModel',
      message: 'Small/fast model (optional, press Enter to skip):',
      default: ''
    },
    {
      type: 'input',
      name: 'displayName',
      message: 'Display name (optional, press Enter to use base URL):',
      default: ''
    }
  ]);

  return {
    baseUrl: answers.baseUrl,
    apiFormat: answers.apiFormat,
    defaultModel: answers.defaultModel.trim(),
    smallFastModel: answers.smallFastModel?.trim() || undefined,
    displayName: answers.displayName?.trim() || undefined
  };
}

/**
 * Create ProviderConfig from custom provider prompts
 */
export function createCustomProviderConfig(
  prompts: CustomProviderPrompts,
  name: string
): ProviderConfig {
  // Generate display name if not provided
  const displayName = prompts.displayName || `Custom (${new URL(prompts.baseUrl).hostname})`;

  // Determine CLI compatibility based on API format
  const compatibility = prompts.apiFormat === 'openai' ? ['codex' as const] : ['claude' as const, 'kimi' as const];

  return {
    name,
    displayName,
    baseUrl: prompts.baseUrl,
    defaultModel: prompts.defaultModel,
    smallFastModel: prompts.smallFastModel,
    description: `Custom ${prompts.apiFormat}-compatible provider`,
    pricing: 'Self-hosted / varies',
    pricingModel: classifyPricingModel({ name, baseUrl: prompts.baseUrl, isCustom: true }),
    compatibility,
    apiFormat: prompts.apiFormat,
    isCustom: true
  };
}

/**
 * Common local LLM examples for reference
 */
export const LOCAL_LLM_EXAMPLES = {
  'LM Studio': {
    baseUrl: 'http://localhost:1234',
    apiFormat: 'openai' as APIFormat,
    description: 'LM Studio local server'
  },
  'Ollama (OpenAI compatible)': {
    baseUrl: 'http://localhost:11434/v1',
    apiFormat: 'openai' as APIFormat,
    description: 'Ollama with OpenAI compatibility layer'
  },
  'llama.cpp server': {
    baseUrl: 'http://localhost:8080',
    apiFormat: 'openai' as APIFormat,
    description: 'llama.cpp HTTP server'
  },
  'text-generation-webui': {
    baseUrl: 'http://localhost:5000',
    apiFormat: 'openai' as APIFormat,
    description: 'oobabooga text-generation-webui'
  },
  'LocalAI': {
    baseUrl: 'http://localhost:8080',
    apiFormat: 'openai' as APIFormat,
    description: 'LocalAI server'
  }
};

/**
 * Display examples of local LLM setups
 */
export function displayLocalLLMExamples(): void {
  console.log(chalk.bold('\n📚 Common Local LLM Setups:\n'));

  Object.entries(LOCAL_LLM_EXAMPLES).forEach(([name, config]) => {
    console.log(chalk.cyan(`  ${name}:`));
    console.log(chalk.gray(`    URL: ${config.baseUrl}`));
    console.log(chalk.gray(`    Format: ${config.apiFormat}`));
    console.log();
  });
}
