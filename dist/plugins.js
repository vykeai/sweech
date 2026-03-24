"use strict";
/**
 * npm-based plugin system for sweech.
 *
 * Plugins are installed via npm into ~/.sweech/plugins/ and registered
 * in a manifest at ~/.sweech/plugins.json.  Each plugin exports a
 * SweechPlugin object and can hook into profile lifecycle events.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPluginManifest = loadPluginManifest;
exports.savePluginManifest = savePluginManifest;
exports.installPlugin = installPlugin;
exports.uninstallPlugin = uninstallPlugin;
exports.listPlugins = listPlugins;
exports.loadPlugin = loadPlugin;
exports.runHook = runHook;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const SWEECH_DIR = path.join(os.homedir(), '.sweech');
const MANIFEST_PATH = path.join(SWEECH_DIR, 'plugins.json');
const PLUGINS_DIR = path.join(SWEECH_DIR, 'plugins');
// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------
/**
 * Load the plugin manifest from ~/.sweech/plugins.json.
 * Returns a default empty manifest when the file does not exist.
 */
function loadPluginManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) {
        return { plugins: [] };
    }
    try {
        const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        // Minimal validation: ensure the plugins array exists.
        if (!Array.isArray(parsed.plugins)) {
            return { plugins: [] };
        }
        return parsed;
    }
    catch {
        return { plugins: [] };
    }
}
/**
 * Persist the plugin manifest to ~/.sweech/plugins.json.
 */
function savePluginManifest(manifest) {
    if (!fs.existsSync(SWEECH_DIR)) {
        fs.mkdirSync(SWEECH_DIR, { recursive: true });
    }
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}
// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------
/**
 * Install an npm package as a sweech plugin.
 *
 * The package is installed into ~/.sweech/plugins/ via `npm install --prefix`.
 * After a successful install the manifest is updated with the new entry
 * (enabled by default).
 */
async function installPlugin(npmPackage) {
    if (!fs.existsSync(PLUGINS_DIR)) {
        fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    }
    try {
        (0, child_process_1.execSync)(`npm install --prefix "${PLUGINS_DIR}" ${npmPackage}`, {
            stdio: 'pipe',
        });
    }
    catch (err) {
        const msg = err && typeof err === 'object' && 'stderr' in err && err.stderr
            ? String(err.stderr).trim()
            : (err instanceof Error ? err.message : String(err));
        throw new Error(`Failed to install plugin "${npmPackage}": ${msg}`);
    }
    // Resolve the actual package name (handles scoped packages, version
    // specifiers like "foo@1.2.3", etc.) by reading the installed package.json.
    const resolvedName = resolvePackageName(npmPackage);
    // Read installed version from the package's own package.json.
    const pkgJsonPath = path.join(PLUGINS_DIR, 'node_modules', resolvedName, 'package.json');
    let version = 'unknown';
    if (fs.existsSync(pkgJsonPath)) {
        try {
            const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
            version = pkgJson.version ?? 'unknown';
        }
        catch {
            // keep "unknown"
        }
    }
    const manifest = loadPluginManifest();
    const existing = manifest.plugins.find((p) => p.name === resolvedName);
    if (existing) {
        existing.version = version;
        existing.enabled = true;
    }
    else {
        manifest.plugins.push({ name: resolvedName, version, enabled: true });
    }
    savePluginManifest(manifest);
}
/**
 * Uninstall a plugin by name.
 *
 * Removes the npm package from ~/.sweech/plugins/ and deletes the
 * corresponding manifest entry.
 */
async function uninstallPlugin(name) {
    try {
        (0, child_process_1.execSync)(`npm uninstall --prefix "${PLUGINS_DIR}" ${name}`, {
            stdio: 'pipe',
        });
    }
    catch {
        // If npm uninstall fails (e.g. package already gone), continue to
        // clean up the manifest anyway.
    }
    const manifest = loadPluginManifest();
    manifest.plugins = manifest.plugins.filter((p) => p.name !== name);
    savePluginManifest(manifest);
}
// ---------------------------------------------------------------------------
// Listing / loading
// ---------------------------------------------------------------------------
/**
 * Return the list of registered plugins from the manifest.
 */
function listPlugins() {
    return loadPluginManifest().plugins;
}
/**
 * Attempt to load a plugin module by name.
 *
 * Returns the SweechPlugin exported by the package, or null when the
 * module cannot be resolved or does not export a valid plugin object.
 */
function loadPlugin(name) {
    const modulePath = path.join(PLUGINS_DIR, 'node_modules', name);
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(modulePath);
        const plugin = mod.default ?? mod;
        if (!plugin || typeof plugin.name !== 'string' || typeof plugin.version !== 'string') {
            console.error(`Plugin "${name}" does not export a valid SweechPlugin object.`);
            return null;
        }
        return plugin;
    }
    catch (err) {
        console.error(`Failed to load plugin "${name}": ${err}`);
        return null;
    }
}
// ---------------------------------------------------------------------------
// Hook runner
// ---------------------------------------------------------------------------
/**
 * Run a named hook across all enabled plugins.
 *
 * Errors thrown by individual plugin hooks are caught and logged to stderr
 * so that a misbehaving plugin does not break the host CLI.
 */
function runHook(hookName, ...args) {
    const manifest = loadPluginManifest();
    for (const entry of manifest.plugins) {
        if (!entry.enabled)
            continue;
        const plugin = loadPlugin(entry.name);
        if (!plugin?.hooks)
            continue;
        const hookFn = plugin.hooks[hookName];
        if (typeof hookFn !== 'function')
            continue;
        try {
            hookFn(...args);
        }
        catch (err) {
            console.error(`Plugin "${entry.name}" hook "${hookName}" threw: ${err}`);
        }
    }
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Resolve a potentially version-qualified npm specifier (e.g. "foo@^2.0")
 * to just the bare package name.
 */
function resolvePackageName(npmPackage) {
    // Scoped packages: @scope/name or @scope/name@version
    if (npmPackage.startsWith('@')) {
        const withoutVersion = npmPackage.replace(/@[^/]+$/, (match, offset) => {
            // Keep the scope's "@" — only strip a trailing "@version".
            return offset === 0 ? match : '';
        });
        // Simpler approach: split on "@" keeping scope intact.
        const parts = npmPackage.split('/');
        if (parts.length >= 2) {
            const nameAndVersion = parts[1];
            const atIdx = nameAndVersion.indexOf('@');
            if (atIdx > 0) {
                return `${parts[0]}/${nameAndVersion.slice(0, atIdx)}`;
            }
            return `${parts[0]}/${nameAndVersion}`;
        }
        return withoutVersion;
    }
    // Unscoped: "foo@1.2.3" -> "foo"
    const atIdx = npmPackage.indexOf('@');
    if (atIdx > 0) {
        return npmPackage.slice(0, atIdx);
    }
    return npmPackage;
}
