import type { EngineId } from '../types.js';

export type RuleEvent = 'error' | 'rate_limit' | 'timeout' | 'cost_exceeded' | 'engine_unavailable';

export type RuleAction =
  | { action: 'retry'; maxRetries: number; delayMs?: number }
  | { action: 'fallback'; engine: EngineId }
  | { action: 'fallback_tier'; tier: string }
  | { action: 'abort'; message?: string }
  | { action: 'warn'; message: string }
  | { action: 'switch_profile'; profile: string };

export interface RuleCondition {
  event: RuleEvent;
  engine?: EngineId;
  pattern?: string;
  maxCostUsd?: number;
  provider?: string;
}

export interface Rule {
  name: string;
  enabled: boolean;
  priority: number;
  when: RuleCondition;
  then: RuleAction;
}

export interface TierConfig {
  [tier: string]: EngineId[];
}

export interface RulesConfig {
  version: 1;
  rules: Rule[];
  tiers: TierConfig;
}

export const DEFAULT_RULES_CONFIG: RulesConfig = {
  version: 1,
  rules: [],
  tiers: {
    free: [],
    cheap: ['qwen-code', 'pi-mono', 'opencode', 'goose'],
    full: ['claude-code', 'codex', 'copilot'],
  },
};
