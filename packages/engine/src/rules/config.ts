import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Rule, RulesConfig } from './types.js';
import { DEFAULT_RULES_CONFIG } from './types.js';

const CONFIG_PATH = join(homedir(), '.omnai', 'rules.json');

let cached: RulesConfig | null = null;

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export async function loadRules(): Promise<RulesConfig> {
  if (cached) return cached;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    cached = { ...DEFAULT_RULES_CONFIG, ...JSON.parse(raw) };
    return cached!;
  } catch {
    cached = { ...DEFAULT_RULES_CONFIG };
    return cached;
  }
}

export async function saveRules(config: RulesConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  cached = config;
}

export function clearRulesCache(): void {
  cached = null;
}

export async function addRule(rule: Rule): Promise<RulesConfig> {
  const config = await loadRules();
  const existing = config.rules.findIndex(r => r.name === rule.name);
  if (existing >= 0) {
    config.rules[existing] = rule;
  } else {
    config.rules.push(rule);
  }
  config.rules.sort((a, b) => a.priority - b.priority);
  await saveRules(config);
  return config;
}

export async function removeRule(name: string): Promise<boolean> {
  const config = await loadRules();
  const before = config.rules.length;
  config.rules = config.rules.filter(r => r.name !== name);
  if (config.rules.length === before) return false;
  await saveRules(config);
  return true;
}

export async function toggleRule(name: string, enabled: boolean): Promise<boolean> {
  const config = await loadRules();
  const rule = config.rules.find(r => r.name === name);
  if (!rule) return false;
  rule.enabled = enabled;
  await saveRules(config);
  return true;
}
