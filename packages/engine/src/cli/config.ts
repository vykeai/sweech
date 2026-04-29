import type { Command } from 'commander';
import { loadProviders, saveProviders, getProvidersPath, providersExists } from '../providers.js';
import type { ProviderAccount, ProvidersConfig } from '../providers.js';

export function registerConfigCommands(program: Command) {
  const config = program
    .command('config')
    .description('Manage providers.yaml configuration');

  config
    .command('tui')
    .description('Interactive config UI (providers, profiles, keys)')
    .action(async () => {
      const { runConfigTUI } = await import('../tui/index.js');
      runConfigTUI();
    });

  config
    .command('path')
    .description('Print the path to providers.yaml')
    .action(() => {
      process.stdout.write(getProvidersPath() + '\n');
    });

  config
    .command('show')
    .description('Show current providers configuration')
    .option('--json', 'Output as JSON')
    .action(async (flags: { json?: boolean }) => {
      if (!(await providersExists())) {
        process.stderr.write('providers.yaml not found. Run `omnai config init` to create it.\n');
        process.exitCode = 1;
        return;
      }

      const providers = await loadProviders();
      if (flags.json) {
        process.stdout.write(JSON.stringify(providers, null, 2) + '\n');
        return;
      }

      process.stdout.write(`Providers (${getProvidersPath()}):\n`);
      process.stdout.write(`Failover order: ${providers.failoverOrder.join(' -> ')}\n\n`);
      for (const [id, acc] of Object.entries(providers.accounts)) {
        const status = acc.enabled ? 'enabled' : 'disabled';
        process.stdout.write(`  ${id} (${acc.provider}, ${acc.type}, ${status})\n`);
        process.stdout.write(`    models: ${acc.models.join(', ')}\n`);
        if (acc.baseUrl) process.stdout.write(`    baseUrl: ${acc.baseUrl}\n`);
        if (acc.apiKeyEnv) process.stdout.write(`    apiKeyEnv: ${acc.apiKeyEnv}\n`);
        if (acc.rateLimit) process.stdout.write(`    rateLimit: ${JSON.stringify(acc.rateLimit)}\n`);
        if (acc.quota) process.stdout.write(`    quota: ${JSON.stringify(acc.quota)}\n`);
      }
    });

  config
    .command('list-accounts')
    .description('List all provider accounts')
    .action(async () => {
      if (!(await providersExists())) {
        process.stderr.write('providers.yaml not found.\n');
        process.exitCode = 1;
        return;
      }

      const providers = await loadProviders();
      for (const [id, acc] of Object.entries(providers.accounts)) {
        const mark = acc.enabled ? '+' : '-';
        process.stdout.write(`${mark} ${id}  provider=${acc.provider}  type=${acc.type}  models=${acc.models.length}\n`);
      }
    });

  config
    .command('enable <accountId>')
    .description('Enable a provider account')
    .action(async (accountId: string) => {
      const providers = await loadProviders();
      const acc = providers.accounts[accountId];
      if (!acc) {
        process.stderr.write(`Account "${accountId}" not found.\n`);
        process.exitCode = 1;
        return;
      }
      acc.enabled = true;
      await saveProviders(providers);
      process.stdout.write(`Account "${accountId}" enabled.\n`);
    });

  config
    .command('disable <accountId>')
    .description('Disable a provider account')
    .action(async (accountId: string) => {
      const providers = await loadProviders();
      const acc = providers.accounts[accountId];
      if (!acc) {
        process.stderr.write(`Account "${accountId}" not found.\n`);
        process.exitCode = 1;
        return;
      }
      acc.enabled = false;
      await saveProviders(providers);
      process.stdout.write(`Account "${accountId}" disabled.\n`);
    });

  config
    .command('set-failover <accounts...>')
    .description('Set the failover order (space-separated account IDs)')
    .action(async (accounts: string[]) => {
      const providers = await loadProviders();
      for (const id of accounts) {
        if (!providers.accounts[id]) {
          process.stderr.write(`Account "${id}" not found in providers.yaml.\n`);
          process.exitCode = 1;
          return;
        }
      }
      providers.failoverOrder = accounts;
      await saveProviders(providers);
      process.stdout.write(`Failover order: ${accounts.join(' -> ')}\n`);
    });
}
