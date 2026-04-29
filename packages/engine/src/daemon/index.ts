import { serve } from '@hono/node-server';
import { createApp, preloadEstate, preloadProviders, setDaemonLifecycleState, resetDaemonStartedAt, cancelAllRunSessions } from './server.js';
import { loadEstate } from '../estate.js';
import { loadProviders, watchProviders, providersExists } from '../providers.js';
import { QuotaTracker } from './quota.js';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { registerTool } from '@vykeai/fed';

let PORT = 7801;
const PID_DIR = join(homedir(), '.omnai');
const PID_FILE = join(PID_DIR, 'daemon.pid');
const FED_CONFIG_FILE = join(homedir(), '.fed', 'config.json');
const SHUTDOWN_TIMEOUT_MS = 10_000;

interface FedConfig {
  identity?: string | null;
  tools?: Record<string, { dash?: number; fed?: number; enabled?: boolean }>;
}

interface StartDaemonOptions {
  registerSignalHandlers?: boolean;
  shutdownTimeoutMs?: number;
}

async function readFedConfig(): Promise<FedConfig | null> {
  try {
    return JSON.parse(await readFile(FED_CONFIG_FILE, 'utf-8')) as FedConfig;
  } catch {
    return null;
  }
}

export async function startDaemon(options: StartDaemonOptions = {}) {
  const registerSignalHandlers = options.registerSignalHandlers ?? true;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;

  // Resolve port: env var > fed config > fallback
  const envPort = parseInt(process.env.OMNAI_PORT ?? '');
  const fedCfg2 = await readFedConfig();
  PORT = (Number.isFinite(envPort) && envPort > 0 ? envPort : fedCfg2?.tools?.omnai?.dash) ?? 7801;

  setDaemonLifecycleState('booting', 'initializing');
  resetDaemonStartedAt();

  let quotaTracker: QuotaTracker | undefined;
  let stopProvidersWatch: (() => void) | null = null;
  let server: ReturnType<typeof serve> | null = null;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let closeServerPromise: Promise<void> | null = null;
  const signalCleanups: Array<() => void> = [];

  try {
    const estate = await loadEstate();
    preloadEstate(estate);
    quotaTracker = new QuotaTracker(estate);
    await quotaTracker.load();
  } catch {
    // estate.yaml may not exist yet — continue without it
  }

  try {
    if (await providersExists()) {
      const providers = await loadProviders();
      preloadProviders(providers);
    }
  } catch {
    // providers.yaml may not exist or be invalid — continue without it
  }

  const app = createApp({ quotaTracker });

  const closeServer = async () => {
    if (!server) return;
    if (closeServerPromise) {
      await closeServerPromise;
      return;
    }

    const serverToClose = server;
    closeServerPromise = new Promise<void>((resolve, reject) => {
      serverToClose.close((error?: Error | undefined) => {
        if (error) reject(error);
        else resolve();
      });
    }).finally(() => {
      if (server === serverToClose) {
        server = null;
      }
      closeServerPromise = null;
    });

    await closeServerPromise;
  };

  const forceCloseServerConnections = () => {
    if (!server) return;
    const forceCloseCapableServer = server as ReturnType<typeof serve> & {
      closeAllConnections?: () => void;
      closeIdleConnections?: () => void;
    };
    forceCloseCapableServer.closeIdleConnections?.();
    forceCloseCapableServer.closeAllConnections?.();
    server = null;
  };

  const cleanupSignalHandlers = () => {
    for (const cleanup of signalCleanups.splice(0)) {
      cleanup();
    }
  };

  const requestShutdown = async (reason = 'shutdown requested') => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      cleanupSignalHandlers();
      setDaemonLifecycleState('shutting-down', reason);
      cancelAllRunSessions();
      stopProvidersWatch?.();
      stopProvidersWatch = null;

      const shutdownResult = await Promise.race([
        closeServer().then(() => 'closed' as const).catch(() => 'close-error' as const),
        new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), shutdownTimeoutMs);
        }),
      ]);

      if (shutdownResult !== 'closed') {
        forceCloseServerConnections();
      }

      await unlink(PID_FILE).catch(() => {});
      setDaemonLifecycleState(
        'terminated',
        shutdownResult === 'timeout' ? `${reason} (forced after timeout)` : `${reason} (complete)`,
      );
    })();

    return shutdownPromise;
  };

  const registerSignal = (signal: NodeJS.Signals) => {
    const listener = () => {
      void requestShutdown(`signal:${signal}`);
    };
    process.once(signal, listener);
    signalCleanups.push(() => {
      process.off(signal, listener);
    });
  };

  if (registerSignalHandlers) {
    registerSignal('SIGINT');
    registerSignal('SIGTERM');
  }

  const fedCfg = await readFedConfig().catch(() => null);
  const fedPort = fedCfg?.tools?.omnai?.fed ?? (PORT + 50);
  const identity = fedCfg?.identity ?? os.hostname();

  server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
    void registerTool({
      name: 'omnai',
      displayName: 'Omnai',
      port: PORT,
      fedPort,
      identity,
      version: '0.1.0',
      capabilities: ['engines', 'routing', 'quota', 'usage'],
      getInfo: async () => ({
        displayName: 'Omnai',
        mainPort: PORT,
        capabilities: ['engines', 'routing', 'quota', 'usage'],
        tools: [{
          id: 'omnai',
          name: 'Omnai',
          version: '0.1.0',
          actions: [
            { name: 'chat', method: 'POST', path: '/api/chat', description: 'Chat with AI engines' },
            { name: 'models', method: 'GET', path: '/api/models', description: 'List available models' },
          ],
          mcpEndpoint: `http://localhost:${PORT}/mcp`,
          docsUrl: 'https://github.com/vykeai/omnai',
          healthPath: '/health',
        }],
      }),
    }).catch(() => {});
  });
  setDaemonLifecycleState('ready', 'daemon running');

  // Hot-reload providers.yaml on change
  if (await providersExists()) {
    stopProvidersWatch = (await watchProviders(undefined, (config) => {
      preloadProviders(config);
    }).catch(() => null)) ?? null;
  }

  await mkdir(PID_DIR, { recursive: true });
  await writeFile(PID_FILE, String(process.pid), 'utf-8');

  return { requestShutdown };
}

export { PID_FILE, PORT };

function isDaemonEntrypoint(importMetaUrl: string): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) return false;
  return pathToFileURL(entryPoint).href === importMetaUrl;
}

async function runDaemonCli(): Promise<void> {
  try {
    await startDaemon();
  } catch (error) {
    const message = (error as Error).message;
    setDaemonLifecycleState('terminated', `startup failed: ${message}`);
    console.error(`omnai daemon failed to start: ${message}`);
    process.exitCode = 1;
  }
}

if (isDaemonEntrypoint(import.meta.url)) {
  void runDaemonCli();
}
