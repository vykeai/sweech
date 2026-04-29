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

async function loadFedClient(): Promise<FedEventClientLike> {
  if (!fedClientPromise) {
    fedClientPromise = import('@vykeai/fed')
      .then(({ FedEventClient }) => new FedEventClient('http://localhost:7840') as FedEventClientLike)
      .catch(() => ({
        async publish() {
          return undefined;
        },
      }));
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
