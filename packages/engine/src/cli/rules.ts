import { Command } from 'commander';
import { loadRules, saveRules, addRule, removeRule, toggleRule, getConfigPath } from '../rules/config.js';
import { evaluateRules } from '../rules/engine.js';
import { DEFAULT_RULES_CONFIG } from '../rules/types.js';
import type { Rule, RuleEvent, RuleAction, RuleCondition } from '../rules/types.js';
import type { AgentEvent, EngineId } from '../types.js';

export function registerRulesCommands(parent: Command): void {
  const rules = parent
    .command('rules')
    .description('Manage failover, retry, and budget rules');

  // ── omnai rules list ────────────────────────────────────────────────────────
  rules
    .command('list')
    .description('Show all rules')
    .option('--json', 'Output as JSON')
    .action(async (flags: { json?: boolean }) => {
      const config = await loadRules();
      if (flags.json) {
        console.log(JSON.stringify(config.rules, null, 2));
        return;
      }
      if (config.rules.length === 0) {
        console.log('No rules configured.');
        console.log(`Config: ${getConfigPath()}`);
        return;
      }
      for (const rule of config.rules) {
        const status = rule.enabled ? 'ON ' : 'OFF';
        const when = formatCondition(rule.when);
        const then = formatAction(rule.then);
        console.log(`[${status}] ${rule.name} (priority: ${rule.priority})`);
        console.log(`  when: ${when}`);
        console.log(`  then: ${then}`);
      }
    });

  // ── omnai rules add ─────────────────────────────────────────────────────────
  rules
    .command('add <name>')
    .description('Add or update a rule')
    .requiredOption('--event <event>', 'Trigger event (error|rate_limit|timeout|cost_exceeded|engine_unavailable)')
    .requiredOption('--action <action>', 'Action (retry|fallback|fallback_tier|abort|warn|switch_profile)')
    .option('--engine <engine>', 'Match specific engine')
    .option('--pattern <regex>', 'Match error message pattern')
    .option('--max-cost <usd>', 'Cost threshold for cost_exceeded', parseFloat)
    .option('--provider <provider>', 'Match specific provider')
    .option('--priority <n>', 'Rule priority (lower = first)', (v: string) => Number(v), 100)
    .option('--max-retries <n>', 'Max retries (for retry action)', (v: string) => Number(v), 3)
    .option('--delay <ms>', 'Retry delay in ms', (v: string) => Number(v), 1000)
    .option('--fallback-engine <engine>', 'Target engine for fallback action')
    .option('--fallback-tier <tier>', 'Target tier for fallback_tier action')
    .option('--profile <name>', 'Profile name for switch_profile action')
    .option('--message <msg>', 'Message for warn/abort actions')
    .option('--disabled', 'Create rule in disabled state')
    .action(async (name: string, flags: any) => {
      const when: RuleCondition = {
        event: flags.event as RuleEvent,
      };
      if (flags.engine) when.engine = flags.engine as EngineId;
      if (flags.pattern) when.pattern = flags.pattern;
      if (flags.maxCost) when.maxCostUsd = flags.maxCost;
      if (flags.provider) when.provider = flags.provider;

      const then = buildAction(flags);

      const rule: Rule = {
        name,
        enabled: !flags.disabled,
        priority: flags.priority,
        when,
        then,
      };

      await addRule(rule);
      console.log(`Rule "${name}" saved.`);
    });

  // ── omnai rules remove ──────────────────────────────────────────────────────
  rules
    .command('remove <name>')
    .description('Remove a rule')
    .action(async (name: string) => {
      const removed = await removeRule(name);
      if (removed) {
        console.log(`Rule "${name}" removed.`);
      } else {
        console.error(`Rule "${name}" not found.`);
        process.exit(1);
      }
    });

  // ── omnai rules enable/disable ──────────────────────────────────────────────
  rules
    .command('enable <name>')
    .description('Enable a rule')
    .action(async (name: string) => {
      const ok = await toggleRule(name, true);
      if (ok) console.log(`Rule "${name}" enabled.`);
      else { console.error(`Rule "${name}" not found.`); process.exit(1); }
    });

  rules
    .command('disable <name>')
    .description('Disable a rule')
    .action(async (name: string) => {
      const ok = await toggleRule(name, false);
      if (ok) console.log(`Rule "${name}" disabled.`);
      else { console.error(`Rule "${name}" not found.`); process.exit(1); }
    });

  // ── omnai rules test ────────────────────────────────────────────────────────
  rules
    .command('test')
    .description('Dry-run: test which rule would match a scenario')
    .requiredOption('--event-type <type>', 'Simulated event type (error|result|text)')
    .option('--message <msg>', 'Simulated error message')
    .option('--engine <engine>', 'Engine context', 'claude-code')
    .option('--cost <usd>', 'Cumulative cost context', parseFloat, 0)
    .option('--provider <provider>', 'Provider context')
    .action(async (flags: any) => {
      const config = await loadRules();
      const event: AgentEvent = flags.eventType === 'error'
        ? { type: 'error', message: flags.message ?? 'simulated error' }
        : { type: 'text', content: flags.message ?? '' };

      const action = evaluateRules(event, config, {
        engine: flags.engine as EngineId,
        provider: flags.provider,
        cumulativeCostUsd: flags.cost,
      });

      if (action) {
        console.log(`Matched rule action: ${formatAction(action)}`);
      } else {
        console.log('No rules matched.');
      }
    });

  // ── omnai rules add-budget-guard ────────────────────────────────────────────
  rules
    .command('add-budget-guard')
    .description('Add a cost_exceeded rule that downgrades to a cheaper tier')
    .requiredOption('--max-cost <usd>', 'Cost threshold in USD', parseFloat)
    .option('--downgrade-to <tier>', 'Tier to fall back to when threshold is hit', 'cheap')
    .option('--action <action>', 'abort or fallback_tier (default: fallback_tier)', 'fallback_tier')
    .option('--name <name>', 'Rule name', 'budget-guard')
    .option('--priority <n>', 'Rule priority', (v: string) => Number(v), 80)
    .action(async (flags: { maxCost: number; downgradeTo: string; action: string; name: string; priority: number }) => {
      const action = flags.action === 'abort' ? 'abort' : 'fallback_tier';
      const rule: Rule = {
        name: flags.name,
        enabled: true,
        priority: flags.priority,
        when: { event: 'cost_exceeded', maxCostUsd: flags.maxCost },
        then: action === 'abort'
          ? { action: 'abort', message: `Cost cap reached ($${flags.maxCost.toFixed(2)})` }
          : { action: 'fallback_tier', tier: flags.downgradeTo },
      };
      await addRule(rule);
      if (action === 'abort') {
        console.log(`Budget guard "${flags.name}" saved: abort when cost > $${flags.maxCost.toFixed(2)}`);
      } else {
        console.log(`Budget guard "${flags.name}" saved: downgrade to tier "${flags.downgradeTo}" when cost > $${flags.maxCost.toFixed(2)}`);
      }
      console.log(`Config: ${getConfigPath()}`);
    });

  // ── omnai rules reset ───────────────────────────────────────────────────────
  rules
    .command('reset')
    .description('Reset rules to defaults (keeps tiers)')
    .action(async () => {
      const config = await loadRules();
      config.rules = [];
      await saveRules(config);
      console.log('All rules cleared.');
    });

  // ── omnai rules init ────────────────────────────────────────────────────────
  rules
    .command('init')
    .description('Create starter rules for common scenarios')
    .action(async () => {
      const starterRules: Rule[] = [
        {
          name: 'retry-network-errors',
          enabled: true,
          priority: 10,
          when: { event: 'error', pattern: 'ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed' },
          then: { action: 'retry', maxRetries: 3, delayMs: 1000 },
        },
        {
          name: 'retry-rate-limits',
          enabled: true,
          priority: 20,
          when: { event: 'rate_limit' },
          then: { action: 'retry', maxRetries: 2, delayMs: 5000 },
        },
        {
          name: 'fallback-claude-to-gemini',
          enabled: false,
          priority: 50,
          when: { event: 'engine_unavailable', engine: 'claude-code' },
          then: { action: 'fallback', engine: 'gemini-cli' },
        },
        {
          name: 'budget-cap-5usd',
          enabled: false,
          priority: 90,
          when: { event: 'cost_exceeded', maxCostUsd: 5 },
          then: { action: 'abort', message: 'Cost cap reached ($5.00)' },
        },
      ];

      for (const rule of starterRules) {
        await addRule(rule);
      }
      console.log(`Created ${starterRules.length} starter rules (some disabled by default).`);
      console.log(`Config: ${getConfigPath()}`);
      console.log('Use "omnai rules list" to review, "omnai rules enable <name>" to activate.');
    });
}

function formatCondition(when: RuleCondition): string {
  const parts: string[] = [when.event];
  if (when.engine) parts.push(`engine=${when.engine}`);
  if (when.pattern) parts.push(`pattern=/${when.pattern}/`);
  if (when.maxCostUsd != null) parts.push(`cost>${when.maxCostUsd}`);
  if (when.provider) parts.push(`provider=${when.provider}`);
  return parts.join(' AND ');
}

function formatAction(then: RuleAction): string {
  switch (then.action) {
    case 'retry': return `retry (max=${then.maxRetries}, delay=${then.delayMs ?? 1000}ms)`;
    case 'fallback': return `fallback to ${then.engine}`;
    case 'fallback_tier': return `fallback to tier "${then.tier}"`;
    case 'abort': return `abort${then.message ? `: ${then.message}` : ''}`;
    case 'warn': return `warn: ${then.message}`;
    case 'switch_profile': return `switch to profile "${then.profile}"`;
  }
}

function buildAction(flags: any): RuleAction {
  switch (flags.action) {
    case 'retry':
      return { action: 'retry', maxRetries: flags.maxRetries ?? 3, delayMs: flags.delay ?? 1000 };
    case 'fallback':
      if (!flags.fallbackEngine) throw new Error('--fallback-engine required for fallback action');
      return { action: 'fallback', engine: flags.fallbackEngine as EngineId };
    case 'fallback_tier':
      if (!flags.fallbackTier) throw new Error('--fallback-tier required for fallback_tier action');
      return { action: 'fallback_tier', tier: flags.fallbackTier };
    case 'abort':
      return { action: 'abort', message: flags.message };
    case 'warn':
      return { action: 'warn', message: flags.message ?? 'Rule triggered' };
    case 'switch_profile':
      if (!flags.profile) throw new Error('--profile required for switch_profile action');
      return { action: 'switch_profile', profile: flags.profile };
    default:
      throw new Error(`Unknown action: ${flags.action}`);
  }
}
