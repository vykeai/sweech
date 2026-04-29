import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'yaml';

export type AccountType = 'subscription' | 'api-key' | 'free-tier';

export interface QuotaDef {
  period: 'daily' | 'weekly' | 'monthly';
  limit?: number;
  softLimit?: number;
}

export interface EstateAccount {
  provider: string;
  engine: string;
  type: AccountType;
  configDir?: string;
  apiKeyEnv?: string;
  quota?: QuotaDef;
}

export interface Estate {
  version: number;
  accounts: Record<string, EstateAccount>;
  failoverOrder: string[];
}

interface SweechProfile {
  commandName?: string;
  cliType?: string;
  provider?: string;
}

const VALID_ACCOUNT_TYPES: AccountType[] = ['subscription', 'api-key', 'free-tier'];
const VALID_PERIODS: QuotaDef['period'][] = ['daily', 'weekly', 'monthly'];

export function getEstatePath(): string {
  return join(homedir(), '.omnai', 'estate.yaml');
}

const SWEECH_FED_PORT = 7854;

export async function loadEstate(path?: string, sweechDaemonPort = SWEECH_FED_PORT): Promise<Estate> {
  const filePath = path ?? getEstatePath();
  const content = await readFile(filePath, 'utf-8');
  const estate = parseAndValidate(content);
  return mergeSweechProfiles(estate, await querySweechDaemon(sweechDaemonPort));
}

export function parseAndValidate(content: string): Estate {
  const raw = parse(content);

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('estate.yaml must be a YAML object');
  }

  if (typeof raw.version !== 'number') {
    throw new Error('estate.yaml: "version" must be a number');
  }

  if (typeof raw.accounts !== 'object' || raw.accounts === null || Array.isArray(raw.accounts)) {
    throw new Error('estate.yaml: "accounts" must be an object');
  }

  if (!Array.isArray(raw.failoverOrder)) {
    throw new Error('estate.yaml: "failoverOrder" must be an array');
  }

  const accounts: Record<string, EstateAccount> = {};

  for (const [id, acc] of Object.entries(raw.accounts)) {
    const a = acc as Record<string, unknown>;

    if (typeof a.provider !== 'string') {
      throw new Error(`estate.yaml: account "${id}" missing "provider" string`);
    }
    if (typeof a.engine !== 'string') {
      throw new Error(`estate.yaml: account "${id}" missing "engine" string`);
    }
    if (!VALID_ACCOUNT_TYPES.includes(a.type as AccountType)) {
      throw new Error(`estate.yaml: account "${id}" has invalid type "${a.type}" (expected ${VALID_ACCOUNT_TYPES.join(', ')})`);
    }

    const account: EstateAccount = {
      provider: a.provider,
      engine: a.engine,
      type: a.type as AccountType,
    };

    if (a.configDir !== undefined) {
      if (typeof a.configDir !== 'string') {
        throw new Error(`estate.yaml: account "${id}" configDir must be a string`);
      }
      account.configDir = a.configDir;
    }

    if (a.apiKeyEnv !== undefined) {
      if (typeof a.apiKeyEnv !== 'string') {
        throw new Error(`estate.yaml: account "${id}" apiKeyEnv must be a string`);
      }
      account.apiKeyEnv = a.apiKeyEnv;
    }

    if (a.quota !== undefined) {
      const q = a.quota as Record<string, unknown>;
      if (typeof q !== 'object' || q === null) {
        throw new Error(`estate.yaml: account "${id}" quota must be an object`);
      }
      if (!VALID_PERIODS.includes(q.period as QuotaDef['period'])) {
        throw new Error(`estate.yaml: account "${id}" quota has invalid period "${q.period}"`);
      }
      const quota: QuotaDef = { period: q.period as QuotaDef['period'] };
      if (q.limit !== undefined) {
        if (typeof q.limit !== 'number') throw new Error(`estate.yaml: account "${id}" quota.limit must be a number`);
        quota.limit = q.limit;
      }
      if (q.softLimit !== undefined) {
        if (typeof q.softLimit !== 'number') throw new Error(`estate.yaml: account "${id}" quota.softLimit must be a number`);
        quota.softLimit = q.softLimit;
      }
      account.quota = quota;
    }

    accounts[id] = account;
  }

  for (const ref of raw.failoverOrder) {
    if (typeof ref !== 'string') {
      throw new Error('estate.yaml: failoverOrder entries must be strings');
    }
    if (!(ref in accounts)) {
      throw new Error(`estate.yaml: failoverOrder references unknown account "${ref}"`);
    }
  }

  return {
    version: raw.version,
    accounts,
    failoverOrder: raw.failoverOrder,
  };
}

async function querySweechDaemon(port: number): Promise<SweechProfile[]> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/fed/runs`, { timeout: 1000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer | string) => {
        data += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      });
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          resolve(Array.isArray(raw) ? raw as SweechProfile[] : []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

function toSweechEstateAccount(profile: SweechProfile): { id: string; account: EstateAccount } | null {
  if (typeof profile.commandName !== 'string' || !profile.commandName.trim()) return null;
  if (profile.cliType === 'claude' && profile.provider === 'anthropic') {
    return {
      id: profile.commandName,
      account: {
        provider: 'claude',
        engine: 'claude-code',
        type: 'subscription',
        configDir: join(homedir(), `.${profile.commandName}`),
      },
    };
  }
  if (profile.cliType === 'codex' && profile.provider === 'openai') {
    return {
      id: profile.commandName,
      account: {
        provider: 'codex',
        engine: 'codex',
        type: 'subscription',
        configDir: join(homedir(), `.${profile.commandName}`),
      },
    };
  }
  return null;
}

export function mergeSweechProfiles(baseEstate: Estate, profiles: SweechProfile[]): Estate {
  const accounts = { ...baseEstate.accounts };
  const failoverOrder = [...baseEstate.failoverOrder];

  for (const profile of profiles) {
    const converted = toSweechEstateAccount(profile);
    if (!converted) continue;
    const { id, account } = converted;
    if (!(id in accounts)) {
      accounts[id] = account;
    }
    if (!failoverOrder.includes(id)) {
      failoverOrder.push(id);
    }
  }

  return {
    ...baseEstate,
    accounts,
    failoverOrder,
  };
}
