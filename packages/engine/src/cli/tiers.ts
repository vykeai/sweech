import { Command } from 'commander';
import { loadRules, saveRules } from '../rules/config.js';
import { DEFAULT_RULES_CONFIG } from '../rules/types.js';
import type { EngineId } from '../types.js';

export function registerTiersCommands(parent: Command): void {
  const tiers = parent
    .command('tiers')
    .description('Manage engine budget tiers');

  // ── omnai tiers list ────────────────────────────────────────────────────────
  tiers
    .command('list')
    .description('Show all tiers and their engines')
    .option('--json', 'Output as JSON')
    .action(async (flags: { json?: boolean }) => {
      const config = await loadRules();
      if (flags.json) {
        console.log(JSON.stringify(config.tiers, null, 2));
        return;
      }
      for (const [tier, engines] of Object.entries(config.tiers)) {
        console.log(`${tier}: ${engines.join(', ')}`);
      }
    });

  // ── omnai tiers set ─────────────────────────────────────────────────────────
  tiers
    .command('set <tier> <engines...>')
    .description('Set engines for a tier (e.g. omnai tiers set free gemini-cli amazon-q)')
    .action(async (tier: string, engines: string[]) => {
      const config = await loadRules();
      config.tiers[tier] = engines as EngineId[];
      await saveRules(config);
      console.log(`Tier "${tier}" set to: ${engines.join(', ')}`);
    });

  // ── omnai tiers remove ──────────────────────────────────────────────────────
  tiers
    .command('remove <tier>')
    .description('Remove a tier')
    .action(async (tier: string) => {
      const config = await loadRules();
      if (!config.tiers[tier]) {
        console.error(`Tier "${tier}" not found.`);
        process.exit(1);
      }
      delete config.tiers[tier];
      await saveRules(config);
      console.log(`Tier "${tier}" removed.`);
    });

  // ── omnai tiers reset ───────────────────────────────────────────────────────
  tiers
    .command('reset')
    .description('Reset tiers to defaults')
    .action(async () => {
      const config = await loadRules();
      config.tiers = { ...DEFAULT_RULES_CONFIG.tiers };
      await saveRules(config);
      console.log('Tiers reset to defaults.');
    });
}
