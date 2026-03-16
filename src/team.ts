/**
 * Team management for sweech.
 *
 * Connects a local sweech installation to a team hub (self-hosted `sweech serve`),
 * enabling shared account visibility, usage budgets, and remote lock/unlock.
 *
 * Config is stored in ~/.sweech/team.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as https from 'node:https';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamConfig {
  teamId: string;
  name: string;
  hubUrl: string;       // URL of team hub (self-hosted sweech serve)
  role: 'admin' | 'member';
  joinedAt: string;
  inviteCode?: string;
}

export interface TeamMember {
  name: string;
  machine: string;
  accounts: number;
  lastSeen: string;
  role: 'admin' | 'member';
}

export interface UsageBudget {
  accountPattern: string;  // glob pattern matching account names
  maxMessages5h?: number;
  maxMessages7d?: number;
  maxCostUsd?: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const TEAM_CONFIG_PATH = path.join(os.homedir(), '.sweech', 'team.json');

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

/**
 * Read ~/.sweech/team.json.
 * Returns null when the file is missing or unparseable.
 */
export function loadTeamConfig(): TeamConfig | null {
  try {
    if (!fs.existsSync(TEAM_CONFIG_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(TEAM_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as TeamConfig;
  } catch {
    return null;
  }
}

/**
 * Write team config to ~/.sweech/team.json.
 */
export function saveTeamConfig(config: TeamConfig): void {
  fs.mkdirSync(path.dirname(TEAM_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(TEAM_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

/**
 * Shared HTTP helper that reads teamConfig for hubUrl and auth.
 *
 * - Uses node:http or node:https depending on hubUrl scheme
 * - Includes Authorization header from team config (teamId)
 * - 10-second timeout
 * - Returns parsed JSON body or throws with a clear message
 */
export async function teamRequest<T = unknown>(
  method: string,
  apiPath: string,
  body?: object,
): Promise<T> {
  const config = loadTeamConfig();
  if (!config) {
    throw new Error('Not connected to a team. Run `sweech team join` first.');
  }

  let baseUrl: string;
  try {
    // Normalise: strip trailing slash so path joining is predictable
    baseUrl = config.hubUrl.replace(/\/+$/, '');
  } catch {
    throw new Error(`Invalid hub URL in team config: ${config.hubUrl}`);
  }

  const url = new URL(apiPath, baseUrl);
  const transport = url.protocol === 'https:' ? https : http;

  const payload = body ? JSON.stringify(body) : undefined;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.teamId}`,
    'Accept': 'application/json',
  };

  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload).toString();
  }

  return new Promise<T>((resolve, reject) => {
    const req = transport.request(
      url,
      { method, headers, timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;

          if (status < 200 || status >= 300) {
            let message = `Hub returned HTTP ${status}`;
            try {
              const parsed = JSON.parse(responseBody);
              if (parsed.error) message += `: ${parsed.error}`;
            } catch { /* use generic message */ }
            reject(new Error(message));
            return;
          }

          try {
            resolve(JSON.parse(responseBody) as T);
          } catch {
            reject(new Error(`Hub returned invalid JSON (HTTP ${status})`));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to team hub timed out after 10s (${method} ${apiPath})`));
    });

    req.on('error', (err) => {
      reject(new Error(`Team hub request failed (${method} ${apiPath}): ${err.message}`));
    });

    if (payload) {
      req.end(payload);
    } else {
      req.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Team operations
// ---------------------------------------------------------------------------

/**
 * Join a team by invite code.
 *
 * Sends POST to hub /api/team/join with the invite code, then persists the
 * returned team config locally.
 */
export async function joinTeam(inviteCode: string, hubUrl: string): Promise<TeamConfig> {
  const normalizedUrl = hubUrl.replace(/\/+$/, '');
  const url = new URL('/api/team/join', normalizedUrl);
  const transport = url.protocol === 'https:' ? https : http;

  const payload = JSON.stringify({
    inviteCode,
    machine: os.hostname(),
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload).toString(),
    'Accept': 'application/json',
  };

  const config = await new Promise<TeamConfig>((resolve, reject) => {
    const req = transport.request(
      url,
      { method: 'POST', headers, timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;

          if (status < 200 || status >= 300) {
            let message = `Failed to join team (HTTP ${status})`;
            try {
              const parsed = JSON.parse(body);
              if (parsed.error) message += `: ${parsed.error}`;
            } catch { /* use generic message */ }
            reject(new Error(message));
            return;
          }

          try {
            const data = JSON.parse(body) as TeamConfig;
            resolve(data);
          } catch {
            reject(new Error('Hub returned invalid JSON when joining team'));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Join request timed out after 10s (${normalizedUrl})`));
    });

    req.on('error', (err) => {
      reject(new Error(`Failed to connect to team hub: ${err.message}`));
    });

    req.end(payload);
  });

  // Persist locally
  saveTeamConfig(config);
  return config;
}

/**
 * Leave the current team.
 *
 * Notifies the hub via POST /api/team/leave, then removes local team.json.
 */
export async function leaveTeam(): Promise<void> {
  const config = loadTeamConfig();
  if (!config) {
    throw new Error('Not connected to a team.');
  }

  await teamRequest('POST', '/api/team/leave', { machine: os.hostname() });

  // Remove local config
  try {
    fs.unlinkSync(TEAM_CONFIG_PATH);
  } catch { /* file may already be gone */ }
}

/**
 * Invite a new member to the team (admin only).
 *
 * Sends POST to hub /api/team/invite with the target email address.
 * Returns the invite code from the hub response.
 */
export async function inviteMember(email: string): Promise<{ inviteCode: string }> {
  const config = loadTeamConfig();
  if (!config) {
    throw new Error('Not connected to a team.');
  }
  if (config.role !== 'admin') {
    throw new Error('Only team admins can invite members.');
  }

  return teamRequest<{ inviteCode: string }>('POST', '/api/team/invite', { email });
}

/**
 * List all members of the current team.
 */
export async function listMembers(): Promise<TeamMember[]> {
  return teamRequest<TeamMember[]>('GET', '/api/team/members');
}

/**
 * Set a usage budget for accounts matching a pattern.
 */
export async function setBudget(budget: UsageBudget): Promise<void> {
  await teamRequest('POST', '/api/team/budget', budget);
}

/**
 * Get all usage budgets configured for the team.
 */
export async function getBudgets(): Promise<UsageBudget[]> {
  return teamRequest<UsageBudget[]>('GET', '/api/team/budgets');
}

/**
 * Lock an account so it cannot be used.
 */
export async function lockAccount(commandName: string): Promise<void> {
  await teamRequest('POST', '/api/team/lock', { commandName });
}

/**
 * Unlock a previously locked account.
 */
export async function unlockAccount(commandName: string): Promise<void> {
  await teamRequest('POST', '/api/team/unlock', { commandName });
}
