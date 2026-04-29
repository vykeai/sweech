import { Command } from 'commander';
import { loadProfiles, saveProfiles, importSweechProfiles, getProfilesPath, loadProfilesConfig, setDefaultProfile, getDefaultProfile, setFailoverOrder, getFailoverOrder } from '../middleware/profiles.js';
import type { CredentialProfile } from '../middleware/types.js';
import type { EngineId, Provider } from '../types.js';

export function registerProfilesCommands(parent: Command): void {
  const profiles = parent
    .command('profiles')
    .description('Manage credential profiles (multi-account support)');

  // ── omnai profiles list ─────────────────────────────────────────────────────
  profiles
    .command('list')
    .description('Show all profiles')
    .option('--json', 'Output as JSON')
    .action(async (flags: { json?: boolean }) => {
      const config = await loadProfilesConfig();
      const all = await loadProfiles();
      if (flags.json) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }
      const entries = Object.values(all);
      if (entries.length === 0) {
        console.log('No profiles configured.');
        console.log(`Run "omnai profiles import-sweech" to import from sweech, or "omnai profiles add" to create one.`);
        return;
      }
      const defaults = config._config?.defaults ?? {};
      const failover = config._config?.failoverOrder ?? [];

      for (const p of entries) {
        const details: string[] = [p.provider];
        if (p.claudeConfigDir) details.push(`config=${p.claudeConfigDir}`);
        if (p.baseUrl) details.push(`url=${p.baseUrl}`);
        if (p.apiKey) details.push('(has api key)');

        const isDefault = Object.values(defaults).includes(p.name);
        const marker = isDefault ? ' *' : '';
        console.log(`  ${p.name}${marker}  [${details.join(', ')}]`);
      }

      if (Object.keys(defaults).length > 0) {
        console.log(`\n  Defaults:`);
        for (const [engine, profile] of Object.entries(defaults)) {
          console.log(`    ${engine} -> ${profile}`);
        }
      }
      if (failover.length > 0) {
        console.log(`  Failover order: ${failover.join(' -> ')}`);
      }
    });

  // ── omnai profiles add ──────────────────────────────────────────────────────
  profiles
    .command('add <name>')
    .description('Add a credential profile')
    .requiredOption('--provider <provider>', 'Provider (claude, anthropic, openai, etc.)')
    .option('--config-dir <path>', 'CLAUDE_CONFIG_DIR for sweech-style multi-instance')
    .option('--api-key <key>', 'API key')
    .option('--base-url <url>', 'Base URL for OpenAI-compatible endpoints')
    .action(async (name: string, flags: { provider: string; configDir?: string; apiKey?: string; baseUrl?: string }) => {
      const all = await loadProfiles();
      all[name] = {
        name,
        provider: flags.provider as Provider,
        claudeConfigDir: flags.configDir,
        apiKey: flags.apiKey,
        baseUrl: flags.baseUrl,
      };
      await saveProfiles(all);
      console.log(`Profile "${name}" saved.`);
    });

  // ── omnai profiles remove ───────────────────────────────────────────────────
  profiles
    .command('remove <name>')
    .description('Remove a profile')
    .action(async (name: string) => {
      const all = await loadProfiles();
      if (!all[name]) {
        console.error(`Profile "${name}" not found.`);
        process.exit(1);
      }
      delete all[name];
      await saveProfiles(all);
      console.log(`Profile "${name}" removed.`);
    });

  // ── omnai profiles import-sweech ────────────────────────────────────────────
  profiles
    .command('import-sweech')
    .description('Auto-import profiles from ~/.sweech/config.json')
    .action(async () => {
      const { imported, skipped } = await importSweechProfiles();
      if (imported.length === 0 && skipped.length === 0) {
        console.log('No sweech config found at ~/.sweech/config.json');
        return;
      }
      if (imported.length > 0) console.log(`Imported: ${imported.join(', ')}`);
      if (skipped.length > 0) console.log(`Skipped (already exist): ${skipped.join(', ')}`);
      console.log(`Config: ${getProfilesPath()}`);
    });

  // ── omnai profiles set-default ──────────────────────────────────────────────
  profiles
    .command('set-default <engine> <profile>')
    .description('Set the default profile for an engine (e.g. omnai profiles set-default claude-code claude)')
    .action(async (engine: string, profile: string) => {
      const all = await loadProfiles();
      if (!all[profile]) {
        console.error(`Profile "${profile}" not found.`);
        process.exit(1);
      }
      await setDefaultProfile(engine as EngineId, profile);
      console.log(`Default for ${engine}: ${profile}`);
    });

  // ── omnai profiles set-failover ─────────────────────────────────────────────
  profiles
    .command('set-failover <profiles...>')
    .description('Set failover order for profiles (e.g. omnai profiles set-failover claude claude-pole)')
    .action(async (profileNames: string[]) => {
      const all = await loadProfiles();
      for (const name of profileNames) {
        if (!all[name]) {
          console.error(`Profile "${name}" not found.`);
          process.exit(1);
        }
      }
      await setFailoverOrder(profileNames);
      console.log(`Failover order: ${profileNames.join(' -> ')}`);
    });
}
