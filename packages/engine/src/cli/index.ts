#!/usr/bin/env node
import { Command } from 'commander';
import { detectEngines } from '../detect.js';
import { select } from '../select.js';
import { selectByBudget } from '../middleware/budget.js';
import type { Provider, EngineId, RunOptions } from '../types.js';
import type { BudgetGuard } from '../middleware/types.js';
import { resolveProfile } from '../middleware/profiles.js';
import { resolveAccount } from '../middleware/accounts.js';
import { registerRulesCommands } from './rules.js';
import { registerTiersCommands } from './tiers.js';
import { registerCostCommands } from './cost.js';
import { registerProfilesCommands } from './profiles.js';
import { registerQueryCommand } from './query.js'
import { registerUsageCommand } from './usage.js';
import { registerDaemonCommands } from './daemon.js';
import { registerConfigCommands } from './config.js';

const program = new Command();

program
  .name('omnai')
  .description('Universal AI agent runner')
  .version('0.1.0');

// ── omnai status ──────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show detected engines and their availability')
  .action(async () => {
    const engines = await detectEngines();
    for (const e of engines) {
      const mark = e.available ? '✓' : '✗';
      const path = e.binaryPath ? `  ${e.binaryPath}` : '  (not found)';
      const providers = e.providers?.join(', ') ?? '';
      console.log(`${mark} ${e.engine}${path}`);
      if (providers) console.log(`    providers: ${providers}`);
    }
  });

// ── omnai which ───────────────────────────────────────────────────────────────
program
  .command('which')
  .description('Print which engine would be selected for a given provider')
  .option('-p, --provider <provider>', 'Provider route (claude|anthropic|codex|openai|google|...)', 'anthropic')
  .option('-e, --engine <engine>', 'Force a specific engine (claude-code|codex|pi-mono|copilot|...)')
  .option('--account <name>', 'Named account route (preferred over --profile)')
  .option('--profile <name>', 'Legacy profile route')
  .action(async (opts: { provider: Provider; engine?: EngineId; account?: string; profile?: string }) => {
    try {
      const runner = await select({ provider: opts.provider, engine: opts.engine, account: opts.account, profile: opts.profile });
      console.log(runner.engine);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── omnai run ─────────────────────────────────────────────────────────────────
program
  .command('run <prompt>')
  .description('Run a prompt through the selected engine')
  .option('-p, --provider <provider>', 'Provider route: local subscription (claude|codex) or API (anthropic|openai|...)', 'claude')
  .option('-m, --model <model>', 'Model tier (opus|sonnet|haiku) or provider-native model ID')
  .option('-e, --engine <engine>', 'Force engine (claude-code|codex|pi-mono|copilot|...)')
  .option('--cwd <path>', 'Working directory', process.cwd())
  .option('--budget <usd>', 'Max spend in USD', parseFloat)
  .option('--effort <level>', 'Effort level (low|medium|high|max)')
  .option('--bypass-permissions', 'Skip permission prompts (claude-code only)')
  .option('--resume <sessionId>', 'Resume a previous session when supported by the selected engine')
  .option('--base-url <url>', 'Custom base URL for OpenAI-compatible endpoints')
  .option('--account <name>', 'Named account route (preferred over --profile)')
  .option('--profile <name>', 'Use a credential profile')
  .option('--text-only', 'Print only text events (suppress tool calls and result summary)')
  .option('--tier <tier>', 'Route to a cost tier (free|cheap|full|<custom>) instead of default engine')
  .option('--max-cost <usd>', 'Abort or downgrade when cumulative cost exceeds this USD amount', parseFloat)
  .option('--downgrade-to <tier>', 'Tier to fall back to when --max-cost is hit (default: cheap)')
  .option('--on-budget-exceeded <action>', 'What to do when --max-cost is hit: abort|fallback_tier (default: fallback_tier)')
  .option('--add-dir <dirs>', 'Additional directories the agent can access (comma-separated)')
  .action(async (prompt: string, flags: {
    provider: Provider;
    model?: string;
    engine?: EngineId;
    cwd: string;
    budget?: number;
    effort?: string;
    bypassPermissions?: boolean;
    resume?: string;
    baseUrl?: string;
    account?: string;
    profile?: string;
    textOnly?: boolean;
    tier?: string;
    maxCost?: number;
    downgradeTo?: string;
    onBudgetExceeded?: string;
    addDir?: string;
  }) => {
    let runner;
    try {
      if (flags.tier) {
        runner = await selectByBudget(flags.tier, { profile: flags.profile });
      } else {
        runner = await select({ provider: flags.provider, engine: flags.engine, profile: flags.profile, account: flags.account });
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    let runOpts: RunOptions = {
      cwd: flags.cwd,
      model: flags.model,
      provider: flags.provider,
      baseUrl: flags.baseUrl,
      account: flags.account,
      maxBudgetUsd: flags.budget,
      effort: flags.effort as RunOptions['effort'],
      resumeSessionId: flags.resume,
      permissionMode: flags.bypassPermissions ? 'bypass' : 'ask',
      additionalDirectories: flags.addDir ? flags.addDir.split(',') : undefined,
    };

    // Budget guard: --max-cost wires up a BudgetGuard on the runner
    if (flags.maxCost != null) {
      const action = (flags.onBudgetExceeded === 'abort' ? 'abort' : 'fallback_tier') as BudgetGuard['action'];
      runOpts.budgetGuard = {
        maxCostUsd: flags.maxCost,
        action,
        ...(action === 'fallback_tier' ? { downgradeTo: flags.downgradeTo ?? 'cheap' } : {}),
      };
    }

    // Apply named account first, then legacy profile resolution.
    if (flags.account) {
      runOpts = (await resolveAccount(flags.account, runOpts)).options;
    } else if (flags.profile) {
      runOpts = await resolveProfile(flags.profile, runOpts);
    }

    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    runOpts.abortSignal = ac.signal;

    const { wrapRunner, costMiddleware, budgetMiddleware, fallbackMiddleware, toolTimingMiddleware, mcpMiddleware } = await import('../middleware/index.js');
    const middlewares = [costMiddleware, toolTimingMiddleware, mcpMiddleware];
    if (runOpts.budgetGuard) {
      middlewares.unshift(budgetMiddleware(runOpts.budgetGuard));
    }
    if (runOpts.retryPolicy || runOpts.budgetGuard?.action === 'fallback_tier') {
      middlewares.unshift(fallbackMiddleware(runOpts.retryPolicy));
    }
    const wrapped = wrapRunner(runner!, ...middlewares);
    const runStream: (p: string, o: RunOptions) => AsyncGenerator<import('../types.js').AgentEvent> = (p, o) => wrapped.run(p, o);

    try {
      for await (const event of runStream(prompt, runOpts)) {
        switch (event.type) {
          case 'text':
            process.stdout.write(event.content);
            break;
          case 'tool_use':
            if (!flags.textOnly) {
              console.log(`\n[tool: ${event.name}]`);
            }
            break;
          case 'tool_result':
            if (!flags.textOnly && event.isError) {
              console.error(`[tool error: ${event.name}] ${event.content}`);
            }
            break;
          case 'result':
            if (!flags.textOnly) {
              const tokens = event.usage.inputTokens + event.usage.outputTokens;
              console.log(`\n\n[${runner.engine} · $${event.costUsd.toFixed(4)} · ${tokens} tokens · ${(event.durationMs / 1000).toFixed(1)}s]`);
              if (event.sessionId) console.log(`[session: ${event.sessionId}]`);
            }
            break;
          case 'progress':
            if (!flags.textOnly) {
              process.stderr.write(`\r[progress: ~${event.tokensGenerated} tokens]`);
            }
            break;
          case 'cost_update':
            if (!flags.textOnly) {
              console.error(`[cost: $${event.costUsd.toFixed(4)}]`);
            }
            break;
          case 'error':
            console.error(`\n[error] ${event.message}`);
            process.exit(1);
        }
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

registerRulesCommands(program);
registerTiersCommands(program);
registerCostCommands(program);
registerProfilesCommands(program);
registerQueryCommand(program);
registerUsageCommand(program);
registerDaemonCommands(program);
registerConfigCommands(program);

program.parse();
