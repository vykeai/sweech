"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.installLaunchd = installLaunchd;
exports.uninstallLaunchd = uninstallLaunchd;
exports.isLaunchdInstalled = isLaunchdInstalled;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const chalk_1 = __importDefault(require("chalk"));
const PLIST_LABEL = 'ai.sweech.serve';
const PLIST_FILENAME = `${PLIST_LABEL}.plist`;
const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(PLIST_DIR, PLIST_FILENAME);
const LOG_PATH = path.join(os.homedir(), 'Library', 'Logs', 'sweech-serve.log');
function findNodeBinary() {
    const candidates = [
        '/opt/homebrew/bin/node',
        '/usr/local/bin/node',
        '/usr/bin/node',
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error('Could not find node binary. Checked: ' + candidates.join(', '));
}
function generatePlist(port) {
    const nodeBin = findNodeBinary();
    const sweechScript = path.resolve(path.join(__dirname, '../dist/cli.js'));
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${sweechScript}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${port}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`;
}
function installLaunchd(port) {
    try {
        const plistContent = generatePlist(port);
        fs.mkdirSync(PLIST_DIR, { recursive: true });
        fs.writeFileSync(PLIST_PATH, plistContent, 'utf-8');
        console.log(chalk_1.default.green(`Wrote plist to ${PLIST_PATH}`));
        try {
            (0, child_process_1.execSync)(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
        }
        catch {
            // Ignore — may not be loaded yet
        }
        (0, child_process_1.execSync)(`launchctl load "${PLIST_PATH}"`);
        console.log(chalk_1.default.green(`Loaded ${PLIST_LABEL} via launchctl`));
        console.log(chalk_1.default.gray(`Logs: ${LOG_PATH}`));
    }
    catch (err) {
        console.error(chalk_1.default.red(`Failed to install launchd service: ${err.message}`));
        throw err;
    }
}
function uninstallLaunchd() {
    try {
        if (!fs.existsSync(PLIST_PATH)) {
            console.error(chalk_1.default.yellow(`Plist not found at ${PLIST_PATH} — nothing to uninstall`));
            return;
        }
        try {
            (0, child_process_1.execSync)(`launchctl unload "${PLIST_PATH}"`);
            console.log(chalk_1.default.green(`Unloaded ${PLIST_LABEL} via launchctl`));
        }
        catch {
            console.error(chalk_1.default.yellow(`launchctl unload failed — service may not be loaded`));
        }
        fs.unlinkSync(PLIST_PATH);
        console.log(chalk_1.default.green(`Removed ${PLIST_PATH}`));
    }
    catch (err) {
        console.error(chalk_1.default.red(`Failed to uninstall launchd service: ${err.message}`));
        throw err;
    }
}
function isLaunchdInstalled() {
    return fs.existsSync(PLIST_PATH);
}
