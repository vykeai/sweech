"use strict";
/**
 * Cross-platform detection helpers.
 *
 * Provides `isMacOS()`, `isLinux()`, `isWindows()` and platform-specific
 * path constants so the rest of the codebase can gate macOS-only features
 * (Keychain, launchd) behind runtime checks.
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
exports.isMacOS = isMacOS;
exports.isLinux = isLinux;
exports.isWindows = isWindows;
exports.platformName = platformName;
exports.sweechConfigDir = sweechConfigDir;
exports.credentialsDir = credentialsDir;
exports.launchAgentsDir = launchAgentsDir;
exports.hasKeychain = hasKeychain;
exports.hasSecretTool = hasSecretTool;
exports.hasLaunchd = hasLaunchd;
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// ── Platform detection ───────────────────────────────────────────────────────
function isMacOS() {
    return process.platform === 'darwin';
}
function isLinux() {
    return process.platform === 'linux';
}
function isWindows() {
    return process.platform === 'win32';
}
/**
 * Human-readable platform name for display purposes.
 */
function platformName() {
    if (isMacOS())
        return 'macOS';
    if (isLinux())
        return 'Linux';
    if (isWindows())
        return 'Windows';
    return process.platform;
}
// ── Platform-specific paths ──────────────────────────────────────────────────
/**
 * Base sweech config directory.
 *
 * All platforms: ~/.sweech
 *   - macOS:   /Users/<user>/.sweech
 *   - Linux:   /home/<user>/.sweech
 *   - Windows: C:\Users\<user>\.sweech
 */
function sweechConfigDir() {
    return path.join(os.homedir(), '.sweech');
}
/**
 * Directory for file-based credential fallback.
 *
 * All platforms: ~/.sweech/credentials/
 */
function credentialsDir() {
    return path.join(sweechConfigDir(), 'credentials');
}
/**
 * The LaunchAgents plist directory (macOS only).
 * Returns undefined on non-macOS platforms.
 */
function launchAgentsDir() {
    if (!isMacOS())
        return undefined;
    return path.join(os.homedir(), 'Library', 'LaunchAgents');
}
// ── Feature availability ─────────────────────────────────────────────────────
/**
 * Whether the native macOS Keychain is available.
 */
function hasKeychain() {
    return isMacOS();
}
/**
 * Whether libsecret (secret-tool) may be available.
 */
function hasSecretTool() {
    return isLinux();
}
/**
 * Whether launchd is available for background services.
 */
function hasLaunchd() {
    return isMacOS();
}
