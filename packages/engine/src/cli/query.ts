import type { Command } from 'commander';
import { queryAvailable } from '../query.js';

export function registerQueryCommand(program: Command): void {
  program
    .command('query')
    .description('Show engines, providers, models, effort, and thinking options available on this system')
    .option('--json', 'Output as JSON')
    .option('--available-only', 'Show only available (installed) engines')
    .action(async (opts: { json?: boolean; availableOnly?: boolean }) => {
      try {
        const result = await queryAvailable();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const engines = opts.availableOnly
          ? result.engines.filter((e) => e.available)
          : result.engines;

        for (const e of engines) {
          const mark = e.available ? '✓' : '✗';
          const loc = e.binaryPath ? `  (${e.binaryPath})` : '  (not found)';
          console.log(`\n${mark} ${e.engine}${loc}`);
          if (e.available) {
            console.log(`    providers:  ${e.providers.join(', ')}`);
            console.log(`    models:     ${e.models.join(', ')}`);
            console.log(`    effort:     ${e.supportsEffort ? e.effortLevels.join(' | ') : 'not supported'}`);
            console.log(`    thinking:   ${e.supportsThinking ? e.thinkingLevels.join(' | ') : 'not supported'}`);
          }
        }

        console.log(`\nAvailable providers: ${result.providers.join(', ') || 'none'}`);
        console.log(`Effort levels:       ${result.effortLevels.join(' | ') || 'none'}`);
        console.log(`Thinking levels:     ${result.thinkingLevels.join(' | ') || 'none'}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });
}
