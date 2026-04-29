import { Command } from 'commander';
import { PRICING, estimateCost } from '../pricing.js';

export function registerCostCommands(parent: Command): void {
  const cost = parent
    .command('cost')
    .description('Model pricing and cost estimation');

  // ── omnai cost list ─────────────────────────────────────────────────────────
  cost
    .command('list')
    .description('Show pricing for all known models')
    .option('--json', 'Output as JSON')
    .option('--sort <field>', 'Sort by: input, output, name', 'name')
    .action((flags: { json?: boolean; sort: string }) => {
      if (flags.json) {
        console.log(JSON.stringify(PRICING, null, 2));
        return;
      }

      const entries = Object.entries(PRICING);
      if (flags.sort === 'input') entries.sort((a, b) => a[1].inputPer1M - b[1].inputPer1M);
      else if (flags.sort === 'output') entries.sort((a, b) => a[1].outputPer1M - b[1].outputPer1M);
      else entries.sort((a, b) => a[0].localeCompare(b[0]));

      console.log('Model'.padEnd(28) + 'Input/1M'.padEnd(12) + 'Output/1M'.padEnd(12) + 'Cache/1M');
      console.log('-'.repeat(60));
      for (const [model, pricing] of entries) {
        const cache = pricing.cachePer1M != null ? `$${pricing.cachePer1M}` : '-';
        console.log(
          model.padEnd(28) +
          `$${pricing.inputPer1M}`.padEnd(12) +
          `$${pricing.outputPer1M}`.padEnd(12) +
          cache
        );
      }
    });

  // ── omnai cost estimate ─────────────────────────────────────────────────────
  cost
    .command('estimate')
    .description('Estimate cost for a token count')
    .requiredOption('-m, --model <model>', 'Model name')
    .requiredOption('-i, --input <tokens>', 'Input tokens', parseInt)
    .requiredOption('-o, --output <tokens>', 'Output tokens', parseInt)
    .option('-c, --cache <tokens>', 'Cache read tokens', (v: string) => Number(v), 0)
    .action((flags: { model: string; input: number; output: number; cache: number }) => {
      const result = estimateCost(
        { inputTokens: flags.input, outputTokens: flags.output, cacheReadTokens: flags.cache },
        flags.model,
      );
      if (result === 0 && !PRICING[flags.model]) {
        console.error(`Unknown model: ${flags.model}`);
        console.error(`Use "omnai cost list" to see known models.`);
        process.exit(1);
      }
      console.log(`$${result.toFixed(6)}`);
    });

  // ── omnai cost compare ──────────────────────────────────────────────────────
  cost
    .command('compare <models...>')
    .description('Compare cost across models for the same workload')
    .requiredOption('-i, --input <tokens>', 'Input tokens', parseInt)
    .requiredOption('-o, --output <tokens>', 'Output tokens', parseInt)
    .action((models: string[], flags: { input: number; output: number }) => {
      const usage = { inputTokens: flags.input, outputTokens: flags.output };
      console.log('Model'.padEnd(28) + 'Cost');
      console.log('-'.repeat(40));
      const results = models.map(m => ({ model: m, cost: estimateCost(usage, m) }));
      results.sort((a, b) => a.cost - b.cost);
      for (const { model, cost } of results) {
        const label = cost === 0 ? '(unknown model)' : `$${cost.toFixed(6)}`;
        console.log(model.padEnd(28) + label);
      }
    });
}
