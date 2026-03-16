"use strict";
/**
 * Active session detection and management for running CLI processes
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
exports.detectActiveSessions = detectActiveSessions;
exports.getSessionsForAccount = getSessionsForAccount;
exports.killSession = killSession;
exports.tagSession = tagSession;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const clis_1 = require("./clis");
const SESSION_TAGS_FILE = path.join(os.homedir(), '.sweech', 'session-tags.json');
/**
 * Known CLI command names extracted from SUPPORTED_CLIS.
 * Used to match running processes against supported CLIs.
 */
function getKnownCommands() {
    const commands = new Map();
    for (const [cliType, config] of Object.entries(clis_1.SUPPORTED_CLIS)) {
        commands.set(config.command, cliType);
    }
    return commands;
}
/**
 * Build a map from config-dir env var names to their CLI type.
 * e.g. "CLAUDE_CONFIG_DIR" -> "claude", "CODEX_HOME" -> "codex"
 */
function getEnvVarToCLIType() {
    const envVars = new Map();
    for (const [cliType, config] of Object.entries(clis_1.SUPPORTED_CLIS)) {
        envVars.set(config.configDirEnvVar, cliType);
    }
    return envVars;
}
/**
 * Parse the full command string to extract config dir if present.
 * Looks for patterns like CLAUDE_CONFIG_DIR=/path or --config-dir=/path.
 */
function extractConfigDir(command) {
    const envVarMap = getEnvVarToCLIType();
    for (const envVar of envVarMap.keys()) {
        // Match ENV_VAR=/some/path (with or without quotes)
        const pattern = new RegExp(`${envVar}=["']?([^\\s"']+)["']?`);
        const match = command.match(pattern);
        if (match) {
            return match[1];
        }
    }
    return '';
}
/**
 * Determine the CLI type from the command string by checking for
 * config dir env vars first, then falling back to command name matching.
 */
function resolveCLIType(command) {
    const envVarMap = getEnvVarToCLIType();
    // Check for config dir env var patterns first (most specific)
    for (const [envVar, cliType] of envVarMap) {
        if (command.includes(`${envVar}=`)) {
            return cliType;
        }
    }
    // Fall back to command name matching
    const knownCommands = getKnownCommands();
    for (const [cmdName, cliType] of knownCommands) {
        // Match the command name as a standalone word boundary to avoid false positives
        // e.g. "claude" should not match "claudebot"
        const pattern = new RegExp(`(?:^|/|\\s)${cmdName}(?:\\s|$)`);
        if (pattern.test(command)) {
            return cliType;
        }
    }
    return '';
}
/**
 * Derive a commandName (sweech profile name) from the config dir path.
 * Config dirs follow the pattern ~/.command-name/, so extract the directory
 * basename and strip the leading dot.
 */
function deriveCommandName(configDir, cliType) {
    if (configDir) {
        const base = path.basename(configDir);
        // Strip leading dot: .claude-work -> claude-work
        return base.startsWith('.') ? base.slice(1) : base;
    }
    // Fall back to the CLI's default command name
    const cli = clis_1.SUPPORTED_CLIS[cliType];
    return cli ? cli.command : cliType;
}
/**
 * Parse `ps aux` output into structured process entries.
 * Columns: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND...
 * The COMMAND field may contain spaces and is everything from column 11 onward.
 */
function parsePsOutput(output) {
    const lines = output.split('\n');
    const entries = [];
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line)
            continue;
        // Split into at most 11 parts: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND...
        const parts = line.split(/\s+/);
        if (parts.length < 11)
            continue;
        const pid = parseInt(parts[1], 10);
        if (isNaN(pid))
            continue;
        const startTime = parts[8] || '';
        // Everything from column index 10 onward is the command
        const command = parts.slice(10).join(' ');
        entries.push({ pid, command, startTime });
    }
    return entries;
}
/**
 * Convert a `ps aux` STARTED value to an ISO 8601 string.
 * ps outputs times like "10:23AM", "Tue02PM", or "Jan01" depending on age.
 * For recent processes we get a reasonable approximation; for older ones we
 * fall back to today's date.
 */
function normalizeStartTime(startTime) {
    // Try to parse common ps time formats
    const now = new Date();
    // Format: "HH:MMAM" or "H:MMPM" (today's process)
    const timeMatch = startTime.match(/^(\d{1,2}):(\d{2})(AM|PM)?$/i);
    if (timeMatch) {
        let hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const ampm = (timeMatch[3] || '').toUpperCase();
        if (ampm === 'PM' && hours < 12)
            hours += 12;
        if (ampm === 'AM' && hours === 12)
            hours = 0;
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
        return d.toISOString();
    }
    // Fallback: return current time as best approximation
    return now.toISOString();
}
/**
 * Detect all active CLI sessions by inspecting the system process list.
 * Finds running processes that match known AI CLI commands and extracts
 * session metadata including PID, CLI type, config directory, and command.
 */
function detectActiveSessions() {
    let psOutput;
    try {
        psOutput = (0, child_process_1.execSync)('ps aux', {
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    catch {
        // ps might fail on some systems or in restricted environments
        return [];
    }
    const processes = parsePsOutput(psOutput);
    const knownCommands = getKnownCommands();
    const sessions = [];
    for (const proc of processes) {
        // Skip our own process
        if (proc.pid === process.pid)
            continue;
        // Check if this process matches any known CLI command
        let matched = false;
        for (const cmdName of knownCommands.keys()) {
            // Match the command name in the process command line
            // Must appear as a standalone command, not as a substring of another word
            const pattern = new RegExp(`(?:^|/|\\s)${cmdName}(?:\\s|$)`);
            if (pattern.test(proc.command)) {
                matched = true;
                break;
            }
        }
        if (!matched)
            continue;
        const cliType = resolveCLIType(proc.command);
        if (!cliType)
            continue;
        const configDir = extractConfigDir(proc.command);
        const commandName = deriveCommandName(configDir, cliType);
        sessions.push({
            pid: proc.pid,
            commandName,
            cliType,
            configDir,
            startedAt: normalizeStartTime(proc.startTime),
            command: proc.command,
        });
    }
    return sessions;
}
/**
 * Get active sessions filtered by a specific command/profile name.
 */
function getSessionsForAccount(commandName) {
    const sessions = detectActiveSessions();
    return sessions.filter(s => s.commandName === commandName);
}
/**
 * Send SIGTERM to a process to gracefully terminate a session.
 * Returns true if the signal was sent successfully, false otherwise.
 */
function killSession(pid) {
    try {
        process.kill(pid, 'SIGTERM');
        return true;
    }
    catch {
        // Process may have already exited, or we lack permissions
        return false;
    }
}
/**
 * Read the session tags file.
 */
function readSessionTags() {
    try {
        if (fs.existsSync(SESSION_TAGS_FILE)) {
            const data = fs.readFileSync(SESSION_TAGS_FILE, 'utf-8');
            return JSON.parse(data);
        }
    }
    catch {
        // Corrupted or unreadable file - start fresh
    }
    return {};
}
/**
 * Write the session tags file, ensuring the parent directory exists.
 */
function writeSessionTags(tags) {
    const dir = path.dirname(SESSION_TAGS_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SESSION_TAGS_FILE, JSON.stringify(tags, null, 2));
}
/**
 * Store a tag for a session identified by PID.
 * Tags are persisted in ~/.sweech/session-tags.json as a pid -> tag mapping.
 */
function tagSession(pid, tag) {
    const tags = readSessionTags();
    tags[String(pid)] = tag;
    writeSessionTags(tags);
}
