import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAndValidate, loadEstate, mergeSweechProfiles } from '../estate.js';
import type { Estate } from '../estate.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function startMockSweechDaemon(accounts: object[], port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(accounts));
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const VALID_YAML = `
version: 1
accounts:
  claude-pro:
    provider: anthropic
    engine: claude-code
    type: subscription
    configDir: ~/.claude
    quota:
      period: daily
      limit: 200
      softLimit: 150
  gemini-free:
    provider: google
    engine: gemini-cli
    type: free-tier
    apiKeyEnv: GEMINI_API_KEY
  openai-key:
    provider: openai
    engine: codex
    type: api-key
    apiKeyEnv: OPENAI_API_KEY
    quota:
      period: monthly
failoverOrder:
  - claude-pro
  - gemini-free
  - openai-key
`;

describe('parseAndValidate', () => {
  it('parses valid estate YAML', () => {
    const estate = parseAndValidate(VALID_YAML);

    expect(estate.version).toBe(1);
    expect(Object.keys(estate.accounts)).toEqual(['claude-pro', 'gemini-free', 'openai-key']);
    expect(estate.failoverOrder).toEqual(['claude-pro', 'gemini-free', 'openai-key']);

    const claude = estate.accounts['claude-pro'];
    expect(claude.provider).toBe('anthropic');
    expect(claude.engine).toBe('claude-code');
    expect(claude.type).toBe('subscription');
    expect(claude.configDir).toBe('~/.claude');
    expect(claude.quota).toEqual({ period: 'daily', limit: 200, softLimit: 150 });

    const gemini = estate.accounts['gemini-free'];
    expect(gemini.type).toBe('free-tier');
    expect(gemini.apiKeyEnv).toBe('GEMINI_API_KEY');
    expect(gemini.quota).toBeUndefined();

    const openai = estate.accounts['openai-key'];
    expect(openai.quota).toEqual({ period: 'monthly' });
  });

  it('throws on missing version', () => {
    expect(() => parseAndValidate(`
accounts: {}
failoverOrder: []
`)).toThrow('"version" must be a number');
  });

  it('throws on missing accounts', () => {
    expect(() => parseAndValidate(`
version: 1
failoverOrder: []
`)).toThrow('"accounts" must be an object');
  });

  it('throws on missing failoverOrder', () => {
    expect(() => parseAndValidate(`
version: 1
accounts: {}
`)).toThrow('"failoverOrder" must be an array');
  });

  it('throws on invalid account type', () => {
    expect(() => parseAndValidate(`
version: 1
accounts:
  bad:
    provider: test
    engine: test
    type: invalid
failoverOrder: []
`)).toThrow('invalid type "invalid"');
  });

  it('throws on account missing provider', () => {
    expect(() => parseAndValidate(`
version: 1
accounts:
  bad:
    engine: test
    type: api-key
failoverOrder: []
`)).toThrow('missing "provider"');
  });

  it('throws on failoverOrder referencing unknown account', () => {
    expect(() => parseAndValidate(`
version: 1
accounts:
  real:
    provider: test
    engine: test
    type: api-key
failoverOrder:
  - real
  - ghost
`)).toThrow('unknown account "ghost"');
  });

  it('throws on invalid quota period', () => {
    expect(() => parseAndValidate(`
version: 1
accounts:
  bad:
    provider: test
    engine: test
    type: api-key
    quota:
      period: yearly
failoverOrder: []
`)).toThrow('invalid period "yearly"');
  });
});

describe('loadEstate', () => {
  it('throws on missing file', async () => {
    await expect(loadEstate('/nonexistent/estate.yaml')).rejects.toThrow();
  });

  it('merges official sweech subscription profiles into the estate', async () => {
    const port = 17860;
    const dir = await mkdtemp(join(tmpdir(), 'omnai-estate-'));
    const estatePath = join(dir, 'estate.yaml');

    await writeFile(estatePath, VALID_YAML);

    const server = await startMockSweechDaemon([
      { commandName: 'claude-pole', cliType: 'claude', provider: 'anthropic', slug: 'claude-pole' },
      { commandName: 'codex-pole', cliType: 'codex', provider: 'openai', slug: 'codex-pole' },
      { commandName: 'kimi-work', cliType: 'claude', provider: 'kimi', slug: 'kimi-work' },
    ], port);
    cleanups.push(() => new Promise<void>((res) => server.close(() => res())));

    const estate = await loadEstate(estatePath, port);
    expect(estate.accounts['claude-pole']).toMatchObject({
      provider: 'claude',
      engine: 'claude-code',
      type: 'subscription',
    });
    expect(estate.accounts['codex-pole']).toMatchObject({
      provider: 'codex',
      engine: 'codex',
      type: 'subscription',
    });
    expect(estate.accounts['kimi-work']).toBeUndefined();
    expect(estate.failoverOrder.slice(-2)).toEqual(['claude-pole', 'codex-pole']);
  });
});

describe('mergeSweechProfiles', () => {
  it('preserves explicit estate accounts over discovered sweech accounts', () => {
    const base = parseAndValidate(`
version: 1
accounts:
  claude-pole:
    provider: claude
    engine: claude-code
    type: subscription
    configDir: /explicit/pole
failoverOrder:
  - claude-pole
`);

    const merged = mergeSweechProfiles(base, [
      { commandName: 'claude-pole', cliType: 'claude', provider: 'anthropic' },
    ]);

    expect(merged.accounts['claude-pole'].configDir).toBe('/explicit/pole');
    expect(merged.failoverOrder).toEqual(['claude-pole']);
  });
});
