/**
 * Profile templates for quick setup.
 *
 * Templates provide pre-configured defaults for common provider/CLI
 * combinations so users can bootstrap new profiles in a single step.
 * Built-in templates ship with the CLI; users can also save custom
 * templates to ~/.sweech/templates.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileTemplate {
  name: string;
  description: string;
  cliType: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SWEECH_DIR = path.join(os.homedir(), '.sweech');
const CUSTOM_TEMPLATES_PATH = path.join(SWEECH_DIR, 'templates.json');

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

export const BUILT_IN_TEMPLATES: ProfileTemplate[] = [
  {
    name: 'claude-pro',
    description: 'Anthropic Claude Pro',
    cliType: 'claude',
    provider: 'anthropic',
    tags: ['claude', 'anthropic', 'pro'],
  },
  {
    name: 'claude-team',
    description: 'Anthropic Claude Team',
    cliType: 'claude',
    provider: 'anthropic',
    tags: ['claude', 'anthropic', 'team'],
  },
  {
    name: 'codex-pro',
    description: 'OpenAI Codex Pro',
    cliType: 'codex',
    provider: 'openai',
    tags: ['codex', 'openai', 'pro'],
  },
  {
    name: 'deepseek-coder',
    description: 'DeepSeek Coder',
    cliType: 'claude',
    provider: 'deepseek',
    tags: ['deepseek', 'coder'],
  },
  {
    name: 'qwen-coder',
    description: 'Qwen Coder',
    cliType: 'claude',
    provider: 'qwen',
    tags: ['qwen', 'coder'],
  },
  {
    name: 'openrouter-default',
    description: 'OpenRouter Multi-model',
    cliType: 'claude',
    provider: 'openrouter',
    tags: ['openrouter', 'multi-model'],
  },
  {
    name: 'gemini-pro',
    description: 'Google Gemini Pro',
    cliType: 'gemini',
    provider: 'google',
    tags: ['gemini', 'google', 'pro'],
  },
  {
    name: 'local-ollama',
    description: 'Local Ollama',
    cliType: 'claude',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    tags: ['ollama', 'local', 'self-hosted'],
  },
];

// ---------------------------------------------------------------------------
// Custom template persistence
// ---------------------------------------------------------------------------

/**
 * Load user-defined templates from ~/.sweech/templates.json.
 * Returns an empty array when the file does not exist or is invalid.
 */
export function loadCustomTemplates(): ProfileTemplate[] {
  if (!fs.existsSync(CUSTOM_TEMPLATES_PATH)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(CUSTOM_TEMPLATES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed as ProfileTemplate[];
  } catch {
    return [];
  }
}

/**
 * Save a custom template to ~/.sweech/templates.json.
 *
 * If a template with the same name already exists it is replaced;
 * otherwise the new template is appended.
 */
export function saveCustomTemplate(template: ProfileTemplate): void {
  if (!fs.existsSync(SWEECH_DIR)) {
    fs.mkdirSync(SWEECH_DIR, { recursive: true });
  }

  const templates = loadCustomTemplates();
  const idx = templates.findIndex((t) => t.name === template.name);

  if (idx >= 0) {
    templates[idx] = template;
  } else {
    templates.push(template);
  }

  fs.writeFileSync(CUSTOM_TEMPLATES_PATH, JSON.stringify(templates, null, 2));
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Return every available template (built-in + custom).
 *
 * Custom templates appear after built-in ones.  If a custom template
 * shares a name with a built-in template the custom version wins
 * (the built-in entry is omitted).
 */
export function getAllTemplates(): ProfileTemplate[] {
  const custom = loadCustomTemplates();
  const customNames = new Set(custom.map((t) => t.name));

  const builtIn = BUILT_IN_TEMPLATES.filter((t) => !customNames.has(t.name));

  return [...builtIn, ...custom];
}

/**
 * Find a template by name or tag.
 *
 * Matching is case-insensitive and supports partial strings.  An exact
 * name match is preferred; if none is found the first template whose
 * name or any tag contains the query substring is returned.
 */
export function findTemplate(query: string): ProfileTemplate | undefined {
  const all = getAllTemplates();
  const q = query.toLowerCase();

  // Exact name match first.
  const exact = all.find((t) => t.name.toLowerCase() === q);
  if (exact) return exact;

  // Partial match on name or tags.
  return all.find((t) => {
    if (t.name.toLowerCase().includes(q)) return true;
    return t.tags.some((tag) => tag.toLowerCase().includes(q));
  });
}
