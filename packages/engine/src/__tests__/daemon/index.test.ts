import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serve: vi.fn(),
  createApp: vi.fn(() => ({ fetch: vi.fn() })),
  preloadEstate: vi.fn(),
  preloadProviders: vi.fn(),
  setDaemonLifecycleState: vi.fn(),
  resetDaemonStartedAt: vi.fn(),
  cancelAllRunSessions: vi.fn(),
  loadEstate: vi.fn().mockResolvedValue({ version: 1, accounts: {}, failoverOrder: [] }),
  loadProviders: vi.fn().mockResolvedValue({ accounts: {}, failoverOrder: [] }),
  watchProviders: vi.fn().mockResolvedValue(vi.fn()),
  providersExists: vi.fn().mockResolvedValue(false),
  quotaLoad: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error('missing')),
  registerTool: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@hono/node-server', () => ({
  serve: mocks.serve,
}));

vi.mock('../../daemon/server.js', () => ({
  createApp: mocks.createApp,
  preloadEstate: mocks.preloadEstate,
  preloadProviders: mocks.preloadProviders,
  setDaemonLifecycleState: mocks.setDaemonLifecycleState,
  resetDaemonStartedAt: mocks.resetDaemonStartedAt,
  cancelAllRunSessions: mocks.cancelAllRunSessions,
}));

vi.mock('../../estate.js', () => ({
  loadEstate: mocks.loadEstate,
}));

vi.mock('../../providers.js', () => ({
  loadProviders: mocks.loadProviders,
  watchProviders: mocks.watchProviders,
  providersExists: mocks.providersExists,
}));

vi.mock('../../daemon/quota.js', () => ({
  QuotaTracker: class {
    load = mocks.quotaLoad;
  },
}));

vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  unlink: mocks.unlink,
  readFile: mocks.readFile,
}));

vi.mock('@vykeai/fed', () => ({
  registerTool: mocks.registerTool,
}));

describe('daemon lifecycle entrypoint', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.providersExists.mockResolvedValue(false);
    mocks.loadEstate.mockResolvedValue({ version: 1, accounts: {}, failoverOrder: [] });
    mocks.loadProviders.mockResolvedValue({ accounts: {}, failoverOrder: [] });
    mocks.watchProviders.mockResolvedValue(vi.fn());
    mocks.readFile.mockRejectedValue(new Error('missing'));
  });

  afterEach(async () => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('boots to ready and shuts down cleanly', async () => {
    const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const closeAllConnections = vi.fn();
    const closeIdleConnections = vi.fn();
    const stopWatch = vi.fn();

    mocks.providersExists.mockResolvedValue(true);
    mocks.watchProviders.mockResolvedValue(stopWatch);
    mocks.serve.mockImplementation((_options, onListen) => {
      onListen?.();
      return { close, closeAllConnections, closeIdleConnections };
    });

    const { startDaemon } = await import('../../daemon/index.js');
    const daemon = await startDaemon({ registerSignalHandlers: false, shutdownTimeoutMs: 10 });

    await daemon.requestShutdown('unit-test');

    expect(mocks.setDaemonLifecycleState).toHaveBeenNthCalledWith(1, 'booting', 'initializing');
    expect(mocks.setDaemonLifecycleState).toHaveBeenCalledWith('ready', 'daemon running');
    expect(mocks.setDaemonLifecycleState).toHaveBeenCalledWith('shutting-down', 'unit-test');
    expect(mocks.setDaemonLifecycleState).toHaveBeenCalledWith('terminated', 'unit-test (complete)');
    expect(mocks.cancelAllRunSessions).toHaveBeenCalledTimes(1);
    expect(stopWatch).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
  });

  it('handles SIGTERM with an idempotent shutdown path', async () => {
    const close = vi.fn((callback?: (error?: Error) => void) => callback?.());

    mocks.serve.mockImplementation((_options, onListen) => {
      onListen?.();
      return { close };
    });

    const { startDaemon } = await import('../../daemon/index.js');
    const daemon = await startDaemon({ shutdownTimeoutMs: 10 });

    process.emit('SIGTERM');
    await daemon.requestShutdown('manual-cleanup');

    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.setDaemonLifecycleState).toHaveBeenCalledWith('shutting-down', 'signal:SIGTERM');
    expect(mocks.setDaemonLifecycleState).toHaveBeenCalledWith('terminated', 'signal:SIGTERM (complete)');
  });

  it('forces connection cleanup when graceful shutdown times out', async () => {
    vi.useFakeTimers();

    const close = vi.fn();
    const closeAllConnections = vi.fn();
    const closeIdleConnections = vi.fn();

    mocks.serve.mockImplementation((_options, onListen) => {
      onListen?.();
      return { close, closeAllConnections, closeIdleConnections };
    });

    const { startDaemon } = await import('../../daemon/index.js');
    const daemon = await startDaemon({ registerSignalHandlers: false, shutdownTimeoutMs: 25 });

    const shutdownPromise = daemon.requestShutdown('timeout-test');
    await vi.advanceTimersByTimeAsync(25);
    await shutdownPromise;

    expect(close).toHaveBeenCalledTimes(1);
    expect(closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(mocks.setDaemonLifecycleState).toHaveBeenCalledWith('terminated', 'timeout-test (forced after timeout)');
  });
});
