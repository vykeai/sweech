/**
 * Active session detection and management for running CLI processes
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SUPPORTED_CLIS } from './clis';

export interface ActiveSession {
  pid: number;
  commandName: string;
  cliType: string;
  configDir: string;
  startedAt: string;
  command: string;
}

const SESSION_TAGS_FILE = path.join(os.homedir(), '.sweech', 'session-tags.json');

/**
 * Known CLI command names extracted from SUPPORTED_CLIS.
 * Used to match running processes against supported CLIs.
 */
function getKnownCommands(): Map<string, string> {
  const commands = new Map<string, string>();
  for (const [cliType, config] of Object.entries(SUPPORTED_CLIS)) {
    commands.set(config.command, cliType);
  }
  return commands;
}

/**
 * Build a map from config-dir env var names to their CLI type.
 * e.g. "CLAUDE_CONFIG_DIR" -> "claude", "CODEX_HOME" -> "codex"
 */
function getEnvVarToCLIType(): Map<string, string> {
  const envVars = new Map<string, string>();
  for (const [cliType, config] of Object.entries(SUPPORTED_CLIS)) {
    envVars.set(config.configDirEnvVar, cliType);
  }
  return envVars;
}

/**
 * Parse the full command string to extract config dir if present.
 * Looks for patterns like CLAUDE_CONFIG_DIR=/path or --config-dir=/path.
 */
function extractConfigDir(command: string): string {
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
function resolveCLIType(command: string): string {
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
function deriveCommandName(configDir: string, cliType: string): string {
  if (configDir) {
    const base = path.basename(configDir);
    // Strip leading dot: .claude-work -> claude-work
    return base.startsWith('.') ? base.slice(1) : base;
  }

  // Fall back to the CLI's default command name
  const cli = SUPPORTED_CLIS[cliType];
  return cli ? cli.command : cliType;
}

/**
 * Parse `ps aux` output into structured process entries.
 * Columns: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND...
 * The COMMAND field may contain spaces and is everything from column 11 onward.
 */
function parsePsOutput(output: string): Array<{ pid: number; command: string; startTime: string }> {
  const lines = output.split('\n');
  const entries: Array<{ pid: number; command: string; startTime: string }> = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Split into at most 11 parts: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND...
    const parts = line.split(/\s+/);
    if (parts.length < 11) continue;

    const pid = parseInt(parts[1], 10);
    if (isNaN(pid)) continue;

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
function normalizeStartTime(startTime: string): string {
  // Try to parse common ps time formats
  const now = new Date();

  // Format: "HH:MMAM" or "H:MMPM" (today's process)
  const timeMatch = startTime.match(/^(\d{1,2}):(\d{2})(AM|PM)?$/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const ampm = (timeMatch[3] || '').toUpperCase();

    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;

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
export function detectActiveSessions(): ActiveSession[] {
  let psOutput: string;

  try {
    psOutput = execSync('ps aux', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // ps might fail on some systems or in restricted environments
    return [];
  }

  const processes = parsePsOutput(psOutput);
  const knownCommands = getKnownCommands();
  const sessions: ActiveSession[] = [];

  for (const proc of processes) {
    // Skip our own process
    if (proc.pid === process.pid) continue;

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

    if (!matched) continue;

    const cliType = resolveCLIType(proc.command);
    if (!cliType) continue;

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
export function getSessionsForAccount(commandName: string): ActiveSession[] {
  const sessions = detectActiveSessions();
  return sessions.filter(s => s.commandName === commandName);
}

/**
 * Send SIGTERM to a process to gracefully terminate a session.
 * Returns true if the signal was sent successfully, false otherwise.
 */
export function killSession(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    // Process may have already exited, or we lack permissions
    return false;
  }
}

/**
 * Read the session tags file.
 */
function readSessionTags(): Record<string, string> {
  try {
    if (fs.existsSync(SESSION_TAGS_FILE)) {
      const data = fs.readFileSync(SESSION_TAGS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Corrupted or unreadable file - start fresh
  }
  return {};
}

/**
 * Write the session tags file, ensuring the parent directory exists.
 */
function writeSessionTags(tags: Record<string, string>): void {
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
export function tagSession(pid: number, tag: string): void {
  const tags = readSessionTags();
  tags[String(pid)] = tag;
  writeSessionTags(tags);
}
