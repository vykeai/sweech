export { loadRules, saveRules, clearRulesCache, addRule, removeRule, toggleRule, getConfigPath } from './config.js';
export { evaluateRule, evaluateRules } from './engine.js';
export type { EvalContext } from './engine.js';
export type { Rule, RuleCondition, RuleAction, RuleEvent, TierConfig, RulesConfig } from './types.js';
export { DEFAULT_RULES_CONFIG } from './types.js';
