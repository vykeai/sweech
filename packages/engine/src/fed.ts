import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface FedEventClientLike {
  publish(type: string, source: string, data: unknown): Promise<unknown>;
}

export interface FedToolRegistration {
  name: string;
  displayName: string;
  port: number;
  fedPort: number;
  identity: string;
  version: string;
  capabilities?: string[];
  getInfo?: () => Promise<Record<string, unknown>>;
  getRuns?: () => Promise<unknown[]>;
  getWidget?: () => Promise<unknown>;
}

let fedClientPromise: Promise<FedEventClientLike> | null = null;

const FED_CONFIG_FILE = join(homedir(), '.fed', 'config.json');
const FALLBACK_FED_PORT = 7840;

interface FedConfigTools {
  [slug: string]: { dash?: number; fed?: number; enabled?: boolean };
}

async function readFedPort(): Promise<number> {
  try {
    const raw = await readFile(FED_CONFIG_FILE, 'utf-8');
    const cfg = JSON.parse(raw) as { tools?: FedConfigTools };
    const fedPort = cfg?.tools?.['fed']?.dash;
    return typeof fedPort === 'number' && fedPort > 0 ? fedPort : FALLBACK_FED_PORT;
  } catch {
    return FALLBACK_FED_PORT;
  }
}

async function loadFedClient(): Promise<FedEventClientLike> {
  if (!fedClientPromise) {
    fedClientPromise = (async () => {
      try {
        const port = await readFedPort();
        const { FedEventClient } = await import('@vykeai/fed');
        return new FedEventClient(`http://localhost:${port}`) as FedEventClientLike;
      } catch {
        return {
          async publish() {
            return undefined;
          },
        };
      }
    })();
  }
  return fedClientPromise;
}

export async function publishFedEvent(type: string, source: string, data: unknown): Promise<void> {
  const client = await loadFedClient();
  await client.publish(type, source, data).catch(() => {});
}

export async function registerFedTool(registration: FedToolRegistration): Promise<void> {
  try {
    const { registerTool } = await import('@vykeai/fed');
    await registerTool(registration);
  } catch {
    // Fed is optional for OSS installs.
  }
}
