/**
 * T-LU-005: tests for src/launchd.ts.
 *
 * Covers:
 *   - installLaunchd: writes plist, calls launchctl load, handles re-install
 *   - uninstallLaunchd: unloads + unlinks, missing-plist is graceful
 *   - isLaunchdInstalled: boolean from fs.existsSync
 *   - isLaunchdRunning: parses launchctl list output (running, stopped, not-loaded)
 *   - non-macOS: install/uninstall throw clearly, isLaunchdRunning returns safe default
 *
 * Mocks: child_process.execSync, fs (writeFileSync/mkdirSync/unlinkSync/existsSync).
 * jest.resetModules() between tests so the launchd module re-imports
 * the freshly-mocked child_process / fs.
 */

import * as path from 'path';
import * as os from 'os';

const PLIST_LABEL = 'ai.sweech.serve';
const EXPECTED_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const EXPECTED_LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'sweech-serve.log');

// ── helper: build a fully mocked launchd module ─────────────────────────────

function loadLaunchdWithMocks(opts: {
  platform?: NodeJS.Platform;
  execSyncImpl?: (cmd: string, ...args: unknown[]) => Buffer | string;
  fsOverrides?: Partial<{
    existsSync: (p: string) => boolean;
    writeFileSync: (p: string, content: string, enc?: string) => void;
    mkdirSync: (p: string, opts?: unknown) => void;
    unlinkSync: (p: string) => void;
  }>;
}) {
  jest.resetModules();

  const execSync = opts.execSyncImpl ?? jest.fn(() => Buffer.from(''));
  jest.doMock('child_process', () => ({ execSync }));

  const realFs = jest.requireActual<typeof import('fs')>('fs');
  const fsMock = {
    ...realFs,
    existsSync: opts.fsOverrides?.existsSync ?? jest.fn((p: string) => {
      if (p === '/opt/homebrew/bin/node') return true;
      if (p === EXPECTED_PLIST_PATH) return false;
      return false;
    }),
    writeFileSync: opts.fsOverrides?.writeFileSync ?? jest.fn(),
    mkdirSync: opts.fsOverrides?.mkdirSync ?? jest.fn(),
    unlinkSync: opts.fsOverrides?.unlinkSync ?? jest.fn(),
  };
  jest.doMock('fs', () => fsMock);

  const platform = opts.platform ?? 'darwin';
  jest.doMock('../src/platform', () => {
    const actual = jest.requireActual<typeof import('../src/platform')>('../src/platform');
    return {
      ...actual,
      isMacOS: () => platform === 'darwin',
      isLinux: () => platform === 'linux',
      isWindows: () => platform === 'win32',
    };
  });

  jest.doMock('chalk', () => {
    const passthrough = (s: string) => s;
    return {
      __esModule: true,
      default: { green: passthrough, red: passthrough, yellow: passthrough, gray: passthrough },
      green: passthrough,
      red: passthrough,
      yellow: passthrough,
      gray: passthrough,
    };
  });

  const mod = require('../src/launchd');
  return { mod, execSync, fsMock };
}

// ── installLaunchd ───────────────────────────────────────────────────────────

describe('installLaunchd', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    jest.resetModules();
  });

  test('writes plist file at the expected LaunchAgents path', () => {
    const writeFileSync = jest.fn();
    const { mod } = loadLaunchdWithMocks({
      fsOverrides: { writeFileSync },
    });
    mod.installLaunchd(7854);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [calledPath, contents] = writeFileSync.mock.calls[0];
    expect(calledPath).toBe(EXPECTED_PLIST_PATH);
    expect(typeof contents).toBe('string');
    expect(contents).toContain('<key>Label</key>');
    expect(contents).toContain(`<string>${PLIST_LABEL}</string>`);
  });

  test('plist embeds the supplied port', () => {
    const writeFileSync = jest.fn();
    const { mod } = loadLaunchdWithMocks({
      fsOverrides: { writeFileSync },
    });
    mod.installLaunchd(9999);
    const contents = writeFileSync.mock.calls[0][1] as string;
    expect(contents).toContain('<string>9999</string>');
    expect(contents).toContain('<key>KeepAlive</key>');
    expect(contents).toContain('<key>RunAtLoad</key>');
  });

  test('plist redirects stdout/stderr to the sweech-serve log', () => {
    const writeFileSync = jest.fn();
    const { mod } = loadLaunchdWithMocks({
      fsOverrides: { writeFileSync },
    });
    mod.installLaunchd(7854);
    const contents = writeFileSync.mock.calls[0][1] as string;
    expect(contents).toContain(`<string>${EXPECTED_LOG_PATH}</string>`);
    expect(contents).toContain('<key>StandardOutPath</key>');
    expect(contents).toContain('<key>StandardErrorPath</key>');
  });

  test('runs `launchctl load` on the plist path', () => {
    const xs = jest.fn((_cmd: string) => Buffer.from(''));
    const { mod } = loadLaunchdWithMocks({ execSyncImpl: xs });
    mod.installLaunchd(7854);
    const calls = xs.mock.calls as Array<[string]>;
    const loadCall = calls.find((c) => String(c[0]).startsWith('launchctl load'));
    expect(loadCall).toBeDefined();
    expect(String(loadCall![0])).toContain(EXPECTED_PLIST_PATH);
  });

  test('re-install path: unload runs before load when plist already exists', () => {
    const callOrder: string[] = [];
    const xs = jest.fn((cmd: string) => {
      if (cmd.includes('unload')) callOrder.push('unload');
      else if (cmd.includes('load')) callOrder.push('load');
      return Buffer.from('');
    });
    const existsSync = jest.fn((p: string) => {
      if (p === '/opt/homebrew/bin/node') return true;
      if (p === EXPECTED_PLIST_PATH) return true;
      return false;
    });
    const { mod } = loadLaunchdWithMocks({
      execSyncImpl: xs,
      fsOverrides: { existsSync },
    });
    mod.installLaunchd(7854);
    expect(callOrder).toEqual(['unload', 'load']);
  });

  test('re-install path logs "Reinstalling" message before unload', () => {
    const existsSync = jest.fn((p: string) => {
      if (p === '/opt/homebrew/bin/node') return true;
      if (p === EXPECTED_PLIST_PATH) return true;
      return false;
    });
    const { mod } = loadLaunchdWithMocks({
      fsOverrides: { existsSync },
    });
    mod.installLaunchd(7854);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toMatch(/Reinstalling/i);
    expect(allLogs).toMatch(/unloading existing service first/i);
  });

  test('fresh install path: no "Reinstalling" message', () => {
    const { mod } = loadLaunchdWithMocks({});
    mod.installLaunchd(7854);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).not.toMatch(/Reinstalling/i);
  });

  test('unload failure during re-install is swallowed (load still attempted)', () => {
    let unloadCalls = 0;
    let loadCalls = 0;
    const xs = jest.fn((cmd: string) => {
      if (cmd.includes('unload')) {
        unloadCalls++;
        throw new Error('unload failed (not loaded)');
      }
      if (cmd.includes('load')) {
        loadCalls++;
        return Buffer.from('');
      }
      return Buffer.from('');
    });
    const { mod } = loadLaunchdWithMocks({ execSyncImpl: xs });
    expect(() => mod.installLaunchd(7854)).not.toThrow();
    expect(unloadCalls).toBe(1);
    expect(loadCalls).toBe(1);
  });

  test('throws clearly on non-macOS', () => {
    const { mod } = loadLaunchdWithMocks({ platform: 'linux' });
    expect(() => mod.installLaunchd(7854)).toThrow(/macOS/);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('throws when no node binary is found anywhere', () => {
    const existsSync = jest.fn(() => false);
    const { mod } = loadLaunchdWithMocks({
      fsOverrides: { existsSync },
    });
    expect(() => mod.installLaunchd(7854)).toThrow(/node binary/);
  });
});

// ── uninstallLaunchd ─────────────────────────────────────────────────────────

describe('uninstallLaunchd', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    jest.resetModules();
  });

  test('unloads then unlinks the plist when it exists', () => {
    const callOrder: string[] = [];
    const xs = jest.fn((cmd: string) => {
      if (cmd.includes('unload')) callOrder.push('unload');
      return Buffer.from('');
    });
    const unlinkSync = jest.fn((_p: string) => {
      callOrder.push('unlink');
    });
    const existsSync = jest.fn((p: string) => p === EXPECTED_PLIST_PATH);
    const { mod } = loadLaunchdWithMocks({
      execSyncImpl: xs,
      fsOverrides: { existsSync, unlinkSync },
    });
    mod.uninstallLaunchd();
    expect(callOrder).toEqual(['unload', 'unlink']);
    expect(unlinkSync).toHaveBeenCalledWith(EXPECTED_PLIST_PATH);
  });

  test('missing plist is handled gracefully (no throw, no exec)', () => {
    const xs = jest.fn(() => Buffer.from(''));
    const unlinkSync = jest.fn();
    const existsSync = jest.fn(() => false);
    const { mod } = loadLaunchdWithMocks({
      execSyncImpl: xs,
      fsOverrides: { existsSync, unlinkSync },
    });
    expect(() => mod.uninstallLaunchd()).not.toThrow();
    expect(xs).not.toHaveBeenCalled();
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  test('unload failure still unlinks the plist file', () => {
    const xs = jest.fn(() => {
      throw new Error('not loaded');
    });
    const unlinkSync = jest.fn();
    const existsSync = jest.fn((p: string) => p === EXPECTED_PLIST_PATH);
    const { mod } = loadLaunchdWithMocks({
      execSyncImpl: xs,
      fsOverrides: { existsSync, unlinkSync },
    });
    mod.uninstallLaunchd();
    expect(unlinkSync).toHaveBeenCalledWith(EXPECTED_PLIST_PATH);
  });

  test('throws clearly on non-macOS', () => {
    const { mod } = loadLaunchdWithMocks({ platform: 'linux' });
    expect(() => mod.uninstallLaunchd()).toThrow(/macOS/);
    expect(errorSpy).toHaveBeenCalled();
  });
});

// ── isLaunchdInstalled ──────────────────────────────────────────────────────

describe('isLaunchdInstalled', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('returns true when plist file exists', () => {
    const existsSync = jest.fn((p: string) => p === EXPECTED_PLIST_PATH);
    const { mod } = loadLaunchdWithMocks({
      fsOverrides: { existsSync },
    });
    expect(mod.isLaunchdInstalled()).toBe(true);
  });

  test('returns false when plist file is missing', () => {
    const existsSync = jest.fn(() => false);
    const { mod } = loadLaunchdWithMocks({
      fsOverrides: { existsSync },
    });
    expect(mod.isLaunchdInstalled()).toBe(false);
  });
});

// ── isLaunchdRunning ─────────────────────────────────────────────────────────

describe('isLaunchdRunning', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    jest.resetModules();
  });

  test('parses PID and returns installed+running when launchctl shows an active service', () => {
    const sampleRunning = [
      '{',
      '\t"LimitLoadToSessionType" = "Aqua";',
      '\t"Label" = "ai.sweech.serve";',
      '\t"OnDemand" = false;',
      '\t"LastExitStatus" = 0;',
      '\t"PID" = 81054;',
      '\t"Program" = "/opt/homebrew/bin/node";',
      '};',
      '',
    ].join('\n');
    const xs = jest.fn(() => sampleRunning);
    const { mod } = loadLaunchdWithMocks({ execSyncImpl: xs });
    const status = mod.isLaunchdRunning();
    expect(status).toEqual({ installed: true, running: true, pid: 81054 });
  });

  test('returns installed+!running when launchctl output omits PID key', () => {
    const sampleStopped = [
      '{',
      '\t"LimitLoadToSessionType" = "Aqua";',
      '\t"Label" = "ai.sweech.serve";',
      '\t"OnDemand" = false;',
      '\t"LastExitStatus" = 256;',
      '\t"Program" = "/opt/homebrew/bin/node";',
      '};',
      '',
    ].join('\n');
    const xs = jest.fn(() => sampleStopped);
    const { mod } = loadLaunchdWithMocks({ execSyncImpl: xs });
    const status = mod.isLaunchdRunning();
    expect(status).toEqual({ installed: true, running: false });
  });

  test('returns !installed when launchctl exits non-zero (service not loaded)', () => {
    const xs = jest.fn(() => {
      const err = new Error('Could not find service "ai.sweech.serve" in domain for port');
      (err as Error & { status: number }).status = 113;
      throw err;
    });
    const { mod } = loadLaunchdWithMocks({ execSyncImpl: xs });
    const status = mod.isLaunchdRunning();
    expect(status).toEqual({ installed: false, running: false });
  });

  test('returns safe default on non-macOS without invoking launchctl', () => {
    const xs = jest.fn(() => Buffer.from(''));
    const { mod } = loadLaunchdWithMocks({
      platform: 'linux',
      execSyncImpl: xs,
    });
    const status = mod.isLaunchdRunning();
    expect(status).toEqual({ installed: false, running: false });
    expect(xs).not.toHaveBeenCalled();
  });

  test('returns safe default on win32 without invoking launchctl', () => {
    const xs = jest.fn(() => Buffer.from(''));
    const { mod } = loadLaunchdWithMocks({
      platform: 'win32',
      execSyncImpl: xs,
    });
    const status = mod.isLaunchdRunning();
    expect(status).toEqual({ installed: false, running: false });
    expect(xs).not.toHaveBeenCalled();
  });

  test('invokes launchctl with the ai.sweech.serve label', () => {
    const xs = jest.fn((_cmd: string) => '{ "PID" = 1; };\n');
    const { mod } = loadLaunchdWithMocks({ execSyncImpl: xs });
    mod.isLaunchdRunning();
    const calls = xs.mock.calls as Array<[string]>;
    expect(String(calls[0][0])).toContain('launchctl list ai.sweech.serve');
  });

  test('handles whitespace variations in launchctl output PID line', () => {
    const sample = '{\n  "PID"   =    42 ;\n};\n';
    const xs = jest.fn(() => sample);
    const { mod } = loadLaunchdWithMocks({ execSyncImpl: xs });
    const status = mod.isLaunchdRunning();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(42);
  });

  test('PID 0 is parsed as running with pid 0 (not confused with no-PID)', () => {
    const sample = '{\n\t"PID" = 0;\n};\n';
    const xs = jest.fn(() => sample);
    const { mod } = loadLaunchdWithMocks({ execSyncImpl: xs });
    const status = mod.isLaunchdRunning();
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(0);
  });
});

// ── exported constants ──────────────────────────────────────────────────────

describe('exported constants', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('LAUNCHD_LABEL matches the plist Label key', () => {
    const { mod } = loadLaunchdWithMocks({});
    expect(mod.LAUNCHD_LABEL).toBe(PLIST_LABEL);
  });

  test('LAUNCHD_PLIST_PATH points at ~/Library/LaunchAgents', () => {
    const { mod } = loadLaunchdWithMocks({});
    expect(mod.LAUNCHD_PLIST_PATH).toBe(EXPECTED_PLIST_PATH);
  });

  test('LAUNCHD_LOG_PATH points at ~/Library/Logs/sweech-serve.log', () => {
    const { mod } = loadLaunchdWithMocks({});
    expect(mod.LAUNCHD_LOG_PATH).toBe(EXPECTED_LOG_PATH);
  });
});
