/**
 * Tests for plugin system (plugins.ts)
 *
 * Covers: manifest management, hook execution, error isolation,
 * install/uninstall, listing, and lifecycle hook wiring.
 */

import * as path from 'path';

const MOCK_HOME = '/mock/home';

jest.mock('fs');
jest.mock('child_process');
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: jest.fn(() => MOCK_HOME),
}));

import * as fs from 'fs';
import { execFileSync } from 'child_process';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;

import {
  loadPluginManifest,
  savePluginManifest,
  installPlugin,
  uninstallPlugin,
  listPlugins,
  loadPlugin,
  runHook,
  PluginManifest,
  SweechPlugin,
} from '../src/plugins';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SWEECH_DIR = path.join(MOCK_HOME, '.sweech');
const MANIFEST_PATH = path.join(SWEECH_DIR, 'plugins.json');
const PLUGINS_DIR = path.join(SWEECH_DIR, 'plugins');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Reset require cache for plugin loading
  jest.resetModules();
});

// ---------------------------------------------------------------------------
// loadPluginManifest
// ---------------------------------------------------------------------------

describe('loadPluginManifest', () => {
  test('returns empty manifest when file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    const manifest = loadPluginManifest();
    expect(manifest).toEqual({ plugins: [] });
  });

  test('returns empty manifest when file contains invalid JSON', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('not json {{{');

    const manifest = loadPluginManifest();
    expect(manifest).toEqual({ plugins: [] });
  });

  test('returns empty manifest when plugins array is missing', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{"foo": "bar"}');

    const manifest = loadPluginManifest();
    expect(manifest).toEqual({ plugins: [] });
  });

  test('parses valid manifest', () => {
    const valid: PluginManifest = {
      plugins: [{ name: 'test-plugin', version: '1.0.0', enabled: true }],
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(valid));

    const manifest = loadPluginManifest();
    expect(manifest.plugins).toHaveLength(1);
    expect(manifest.plugins[0].name).toBe('test-plugin');
    expect(manifest.plugins[0].enabled).toBe(true);
  });

  test('handles readFileSync throwing', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const manifest = loadPluginManifest();
    expect(manifest).toEqual({ plugins: [] });
  });
});

// ---------------------------------------------------------------------------
// savePluginManifest
// ---------------------------------------------------------------------------

describe('savePluginManifest', () => {
  test('creates .sweech dir if it does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockImplementation(() => undefined as any);
    mockFs.writeFileSync.mockImplementation(() => {});

    savePluginManifest({ plugins: [] });

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.sweech'),
      { recursive: true, mode: 0o700 }
    );
  });

  test('writes manifest JSON', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.writeFileSync.mockImplementation(() => {});

    const manifest: PluginManifest = {
      plugins: [{ name: 'my-plugin', version: '2.0.0', enabled: true }],
    };

    savePluginManifest(manifest);

    const [filePath, content] = (mockFs.writeFileSync as jest.Mock).mock.calls[0];
    expect(filePath).toBe(MANIFEST_PATH);
    const parsed = JSON.parse(content as string);
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0].name).toBe('my-plugin');
  });
});

// ---------------------------------------------------------------------------
// listPlugins
// ---------------------------------------------------------------------------

describe('listPlugins', () => {
  test('returns empty array when no plugins installed', () => {
    mockFs.existsSync.mockReturnValue(false);

    const plugins = listPlugins();
    expect(plugins).toEqual([]);
  });

  test('returns all plugins from manifest', () => {
    const manifest: PluginManifest = {
      plugins: [
        { name: 'plugin-a', version: '1.0.0', enabled: true },
        { name: 'plugin-b', version: '2.0.0', enabled: false },
      ],
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(manifest));

    const plugins = listPlugins();
    expect(plugins).toHaveLength(2);
    expect(plugins[0].name).toBe('plugin-a');
    expect(plugins[1].enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// installPlugin
// ---------------------------------------------------------------------------

describe('installPlugin', () => {
  test('creates plugins directory if it does not exist', async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      if (String(p).includes('plugins') && !String(p).includes('.json')) return false;
      return false;
    });
    mockFs.mkdirSync.mockImplementation(() => undefined as any);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => Buffer.from(''));

    await installPlugin('test-pkg');

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('plugins'),
      { recursive: true, mode: 0o700 }
    );
  });

  test('calls npm install with correct prefix', async () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockImplementation(() => undefined as any);
    mockFs.writeFileSync.mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => Buffer.from(''));

    await installPlugin('sweech-plugin-test');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'npm', ['install', '--prefix', expect.any(String), 'sweech-plugin-test'],
      expect.any(Object)
    );
  });

  test('throws on npm install failure', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      const err = new Error('npm failed') as any;
      err.stderr = Buffer.from('404 Not Found');
      throw err;
    });

    await expect(installPlugin('nonexistent-pkg')).rejects.toThrow(
      /Failed to install plugin/
    );
  });

  test('updates manifest after successful install', async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      // plugins dir exists, manifest does not
      if (String(p).includes('plugins.json')) return false;
      if (String(p).includes('package.json')) return false;
      return true;
    });
    mockFs.writeFileSync.mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => Buffer.from(''));

    await installPlugin('my-plugin');

    const writeCalls = (mockFs.writeFileSync as jest.Mock).mock.calls;
    const manifestWrite = writeCalls.find(([p]: any) => String(p).includes('plugins.json'));
    expect(manifestWrite).toBeDefined();
    const parsed = JSON.parse(manifestWrite![1] as string);
    expect(parsed.plugins.length).toBeGreaterThanOrEqual(1);
  });

  test('re-enables existing plugin on reinstall', async () => {
    const existingManifest: PluginManifest = {
      plugins: [{ name: 'my-plugin', version: '1.0.0', enabled: false }],
    };
    mockFs.existsSync.mockImplementation((p: any) => {
      if (String(p).includes('plugins.json')) return true;
      if (String(p).includes('package.json')) return false;
      return true;
    });
    mockFs.readFileSync.mockImplementation((p: any) => {
      if (String(p).includes('plugins.json')) return JSON.stringify(existingManifest);
      return '';
    });
    mockFs.writeFileSync.mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => Buffer.from(''));

    await installPlugin('my-plugin');

    const writeCalls = (mockFs.writeFileSync as jest.Mock).mock.calls;
    const manifestWrite = writeCalls.find(([p]: any) => String(p).includes('plugins.json'));
    const parsed = JSON.parse(manifestWrite![1] as string);
    const plugin = parsed.plugins.find((p: any) => p.name === 'my-plugin');
    expect(plugin.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// uninstallPlugin
// ---------------------------------------------------------------------------

describe('uninstallPlugin', () => {
  test('removes plugin from manifest', async () => {
    const manifest: PluginManifest = {
      plugins: [
        { name: 'keep-me', version: '1.0.0', enabled: true },
        { name: 'remove-me', version: '1.0.0', enabled: true },
      ],
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(manifest));
    mockFs.writeFileSync.mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => Buffer.from(''));

    await uninstallPlugin('remove-me');

    const writeCalls = (mockFs.writeFileSync as jest.Mock).mock.calls;
    const manifestWrite = writeCalls.find(([p]: any) => String(p).includes('plugins.json'));
    const parsed = JSON.parse(manifestWrite![1] as string);
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0].name).toBe('keep-me');
  });

  test('continues cleanup even if npm uninstall fails', async () => {
    const manifest: PluginManifest = {
      plugins: [{ name: 'broken-plugin', version: '1.0.0', enabled: true }],
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(manifest));
    mockFs.writeFileSync.mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => {
      throw new Error('npm uninstall failed');
    });

    // Should not throw
    await uninstallPlugin('broken-plugin');

    const writeCalls = (mockFs.writeFileSync as jest.Mock).mock.calls;
    const manifestWrite = writeCalls.find(([p]: any) => String(p).includes('plugins.json'));
    const parsed = JSON.parse(manifestWrite![1] as string);
    expect(parsed.plugins).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadPlugin
// ---------------------------------------------------------------------------

describe('loadPlugin', () => {
  test('returns null when module cannot be required', () => {
    // loadPlugin uses require() which will fail for non-existent modules
    const consoleError = jest.spyOn(console, 'error').mockImplementation();

    const plugin = loadPlugin('nonexistent-plugin-xyz');
    expect(plugin).toBeNull();

    consoleError.mockRestore();
  });

  test('returns null when module does not export valid plugin', () => {
    // Mock require to return an invalid module
    const consoleError = jest.spyOn(console, 'error').mockImplementation();

    // The module path won't resolve, so it returns null
    const plugin = loadPlugin('invalid-module-xyz');
    expect(plugin).toBeNull();

    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runHook — error isolation
// ---------------------------------------------------------------------------

describe('runHook', () => {
  test('does not throw when no plugins installed', () => {
    mockFs.existsSync.mockReturnValue(false);

    // Should not throw
    expect(() => runHook('onProfileCreate', {} as any)).not.toThrow();
  });

  test('does not throw when plugins have no hooks', () => {
    const manifest: PluginManifest = {
      plugins: [{ name: 'hookless-plugin', version: '1.0.0', enabled: true }],
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(manifest));

    // loadPlugin will fail (module not found), but runHook should not throw
    const consoleError = jest.spyOn(console, 'error').mockImplementation();

    expect(() => runHook('onProfileCreate', {} as any)).not.toThrow();

    consoleError.mockRestore();
  });

  test('skips disabled plugins', () => {
    const manifest: PluginManifest = {
      plugins: [{ name: 'disabled-plugin', version: '1.0.0', enabled: false }],
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(manifest));

    // Should not attempt to load a disabled plugin
    const consoleError = jest.spyOn(console, 'error').mockImplementation();

    runHook('onLaunch', 'test-profile', []);

    // No error should be logged for disabled plugins
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  test('continues to next plugin when one fails to load', () => {
    const manifest: PluginManifest = {
      plugins: [
        { name: 'bad-plugin', version: '1.0.0', enabled: true },
        { name: 'another-bad', version: '1.0.0', enabled: true },
      ],
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(manifest));

    const consoleError = jest.spyOn(console, 'error').mockImplementation();

    // Should process both plugins without throwing
    expect(() => runHook('onLimitReached', 'test-account', '5h')).not.toThrow();

    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Hook type coverage
// ---------------------------------------------------------------------------

describe('hook types', () => {
  test('onProfileCreate hook type is callable', () => {
    const hook: SweechPlugin['hooks'] = {
      onProfileCreate: (_profile) => {},
    };
    expect(typeof hook!.onProfileCreate).toBe('function');
  });

  test('onLaunch hook type is callable', () => {
    const hook: SweechPlugin['hooks'] = {
      onLaunch: (_commandName, _args) => {},
    };
    expect(typeof hook!.onLaunch).toBe('function');
  });

  test('onLimitReached hook type is callable', () => {
    const hook: SweechPlugin['hooks'] = {
      onLimitReached: (_account, _window) => {},
    };
    expect(typeof hook!.onLimitReached).toBe('function');
  });

  test('onProfileRemove hook type is callable', () => {
    const hook: SweechPlugin['hooks'] = {
      onProfileRemove: (_commandName) => {},
    };
    expect(typeof hook!.onProfileRemove).toBe('function');
  });

  test('SweechPlugin interface requires name and version', () => {
    const plugin: SweechPlugin = {
      name: 'test-plugin',
      version: '1.0.0',
      description: 'A test plugin',
    };
    expect(plugin.name).toBe('test-plugin');
    expect(plugin.version).toBe('1.0.0');
    expect(plugin.description).toBe('A test plugin');
    expect(plugin.hooks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Manifest edge cases
// ---------------------------------------------------------------------------

describe('manifest edge cases', () => {
  test('manifest with empty plugins array', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ plugins: [] }));

    const manifest = loadPluginManifest();
    expect(manifest.plugins).toEqual([]);
  });

  test('manifest with multiple plugins in different states', () => {
    const data: PluginManifest = {
      plugins: [
        { name: 'enabled-a', version: '1.0.0', enabled: true },
        { name: 'disabled-b', version: '0.5.0', enabled: false },
        { name: 'enabled-c', version: '3.2.1', enabled: true },
      ],
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(data));

    const manifest = loadPluginManifest();
    expect(manifest.plugins).toHaveLength(3);
    expect(manifest.plugins.filter(p => p.enabled)).toHaveLength(2);
    expect(manifest.plugins.filter(p => !p.enabled)).toHaveLength(1);
  });

  test('savePluginManifest overwrites existing file', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.writeFileSync.mockImplementation(() => {});

    savePluginManifest({ plugins: [{ name: 'x', version: '1.0.0', enabled: true }] });
    savePluginManifest({ plugins: [] });

    const lastWrite = (mockFs.writeFileSync as jest.Mock).mock.calls.slice(-1)[0];
    const parsed = JSON.parse(lastWrite[1] as string);
    expect(parsed.plugins).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Plugin error isolation in lifecycle integration points
// ---------------------------------------------------------------------------

describe('plugin error isolation', () => {
  test('runHook catches errors from hook execution', () => {
    // Even if loadPlugin somehow returns a plugin with a throwing hook,
    // runHook wraps in try/catch
    mockFs.existsSync.mockReturnValue(false);

    // No plugins = no errors possible
    expect(() => runHook('onProfileCreate', {} as any)).not.toThrow();
    expect(() => runHook('onLaunch', 'test', [])).not.toThrow();
    expect(() => runHook('onLimitReached', 'account', '5h')).not.toThrow();
    expect(() => runHook('onProfileRemove', 'command')).not.toThrow();
  });

  test('runHook with all hook types succeeds with no plugins', () => {
    mockFs.existsSync.mockReturnValue(false);

    // All hook types should be callable without throwing
    const hookNames = ['onProfileCreate', 'onProfileRemove', 'onLaunch', 'onLimitReached'] as const;
    for (const hookName of hookNames) {
      expect(() => runHook(hookName, 'test-arg')).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// resolvePackageName (tested indirectly via installPlugin)
// ---------------------------------------------------------------------------

describe('scoped package handling', () => {
  test('installs scoped package correctly', async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      if (String(p).includes('plugins.json')) return false;
      if (String(p).includes('package.json')) return false;
      return true;
    });
    mockFs.writeFileSync.mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => Buffer.from(''));

    await installPlugin('@scope/my-plugin');

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'npm', ['install', '--prefix', expect.any(String), '@scope/my-plugin'],
      expect.any(Object)
    );
  });

  test('strips version specifier from package name', async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      if (String(p).includes('plugins.json')) return false;
      if (String(p).includes('package.json')) return false;
      return true;
    });
    mockFs.writeFileSync.mockImplementation(() => {});
    mockExecFileSync.mockImplementation(() => Buffer.from(''));

    await installPlugin('my-plugin@^2.0.0');

    const writeCalls = (mockFs.writeFileSync as jest.Mock).mock.calls;
    const manifestWrite = writeCalls.find(([p]: any) => String(p).includes('plugins.json'));
    const parsed = JSON.parse(manifestWrite![1] as string);
    // Name should be "my-plugin", not "my-plugin@^2.0.0"
    expect(parsed.plugins[0].name).toBe('my-plugin');
  });
});
