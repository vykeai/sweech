import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';

export interface ConfigDir { label: string; dir: string; }

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  status?: string;   // "idle" | "working" | "completed" | ...
  kind?: string;     // "interactive" | "background"
  startedAt?: number;
  updatedAt?: number;
  version?: string;
  profile: string;   // which ~/.claude* dir this came from
  alive: boolean;    // pid still exists
}

export interface ConfiguredAgent {
  name: string;
  source: 'user' | 'builtin';
  profiles: Set<string>;
  invocations: number;
  lastTs: number | null;
}

// ── Discovery ─────────────────────────────────────────────────────────────

export function enumerateClaudeConfigDirs(home: string = os.homedir()): ConfigDir[] {
  let entries: string[];
  try { entries = fs.readdirSync(home); } catch { return []; }
  return entries
    .filter(n => /^\.claude(-.*)?$/.test(n))
    .map(n => ({ label: n.replace(/^\./, ''), dir: path.join(home, n) }))
    .filter(({ dir }) => {
      try { return fs.statSync(dir).isDirectory(); } catch { return false; }
    });
}

// ── Live sessions ─────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readLiveSessions(dirs?: ConfigDir[]): LiveSession[] {
  const sources = dirs ?? enumerateClaudeConfigDirs();
  const out: LiveSession[] = [];
  for (const { label, dir } of sources) {
    const sessionsDir = path.join(dir, 'sessions');
    let files: string[];
    try { files = fs.readdirSync(sessionsDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fpath = path.join(sessionsDir, f);
      let raw: string;
      try { raw = fs.readFileSync(fpath, 'utf-8'); } catch { continue; }
      let obj: any;
      try { obj = JSON.parse(raw); } catch { continue; }
      if (typeof obj?.pid !== 'number') continue;
      out.push({
        pid: obj.pid,
        sessionId: obj.sessionId ?? '',
        cwd: obj.cwd ?? '',
        name: obj.name,
        status: obj.status,
        kind: obj.kind,
        startedAt: obj.startedAt,
        updatedAt: obj.updatedAt,
        version: obj.version,
        profile: label,
        alive: pidAlive(obj.pid),
      });
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

// ── Configured agents (file-based + invocation counts) ────────────────────

export function readUserAgents(dir: string): string[] {
  const agentsDir = path.join(dir, 'agents');
  try {
    return fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
  } catch { return []; }
}

export function scanSessionsForSubagents(dir: string, sinceMs: number): Map<string, { count: number; lastTs: number }> {
  const out = new Map<string, { count: number; lastTs: number }>();
  const projectsDir = path.join(dir, 'projects');
  let projects: string[];
  try { projects = fs.readdirSync(projectsDir); } catch { return out; }
  for (const proj of projects) {
    const sessionsDir = path.join(projectsDir, proj);
    let names: string[];
    try { names = fs.readdirSync(sessionsDir); } catch { continue; }
    for (const fname of names) {
      if (!fname.endsWith('.jsonl')) continue;
      const fpath = path.join(sessionsDir, fname);
      let stat: fs.Stats;
      try { stat = fs.statSync(fpath); } catch { continue; }
      if (stat.mtimeMs < sinceMs) continue;
      let content: string;
      try { content = fs.readFileSync(fpath, 'utf-8'); } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line.includes('subagent_type')) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        const ts = Date.parse(obj.timestamp || '');
        if (!ts || ts < sinceMs) continue;
        const items = obj.message?.content;
        if (!Array.isArray(items)) continue;
        for (const it of items) {
          if (it.type !== 'tool_use') continue;
          if (it.name !== 'Agent' && it.name !== 'Task') continue;
          const name = it.input?.subagent_type;
          if (!name) continue;
          const prev = out.get(name) ?? { count: 0, lastTs: 0 };
          prev.count++;
          if (ts > prev.lastTs) prev.lastTs = ts;
          out.set(name, prev);
        }
      }
    }
  }
  return out;
}

export function aggregateConfigured(windowDays: number, dirs?: ConfigDir[]): ConfiguredAgent[] {
  const sinceMs = Date.now() - windowDays * 86_400_000;
  const sources = dirs ?? enumerateClaudeConfigDirs();
  const records = new Map<string, ConfiguredAgent>();
  for (const { label, dir } of sources) {
    for (const name of readUserAgents(dir)) {
      let r = records.get(name);
      if (!r) { r = { name, source: 'user', profiles: new Set(), invocations: 0, lastTs: null }; records.set(name, r); }
      r.profiles.add(label);
    }
    const sub = scanSessionsForSubagents(dir, sinceMs);
    for (const [name, { count, lastTs }] of sub) {
      let r = records.get(name);
      if (!r) { r = { name, source: 'builtin', profiles: new Set(), invocations: 0, lastTs: null }; records.set(name, r); }
      r.invocations += count;
      if (r.lastTs === null || lastTs > r.lastTs) r.lastTs = lastTs;
      r.profiles.add(label);
    }
  }
  return [...records.values()].sort((a, b) => {
    if (b.invocations !== a.invocations) return b.invocations - a.invocations;
    return (b.lastTs ?? 0) - (a.lastTs ?? 0);
  });
}

// ── Rendering ──────────────────────────────────────────────────────────────

function timeAgo(ms: number | undefined | null): string {
  if (!ms) return chalk.dim('—');
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortCwd(cwd: string): string {
  const home = os.homedir();
  return cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
}

function colorStatus(status: string | undefined, alive: boolean): string {
  if (!alive) return chalk.red('dead   ');
  switch (status) {
    case 'busy':
    case 'working':   return chalk.yellow((status).padEnd(7));
    case 'waiting':   return chalk.magenta('waiting');
    case 'idle':      return chalk.green('idle   ');
    case 'completed':
    case 'done':      return chalk.cyan('done   ');
    default:          return chalk.dim((status ?? '?').padEnd(7));
  }
}

export function renderLiveSessions(sessions: LiveSession[], dirCount: number): string {
  const lines: string[] = [];
  const alive = sessions.filter(s => s.alive);
  const dead = sessions.filter(s => !s.alive);
  lines.push(chalk.bold('sweech agents') + chalk.dim(` — ${alive.length} live / ${dead.length} stale across ${dirCount} profile dir(s)`));
  lines.push('');

  if (sessions.length === 0) {
    lines.push(chalk.dim('  no live Claude Code sessions registered'));
    lines.push(chalk.dim('  (only Claude Code ≥2.1.131 writes to sessions/<pid>.json)'));
    return lines.join('\n');
  }

  const shown = [...alive, ...dead.slice(0, 5)]; // suppress most dead entries
  const widthName = Math.max(6, ...shown.map(s => (s.name || s.sessionId.slice(0, 8)).length));
  const widthProf = Math.max(7, ...shown.map(s => s.profile.length));
  const widthCwd  = Math.max(3, ...shown.map(s => shortCwd(s.cwd).length));

  lines.push(
    '  ' +
    chalk.dim('SESSION'.padEnd(widthName)) + '  ' +
    chalk.dim('PROFILE'.padEnd(widthProf)) + '  ' +
    chalk.dim('STATUS ') + '  ' +
    chalk.dim('CWD'.padEnd(widthCwd)) + '  ' +
    chalk.dim('UPDATED'.padStart(8)) + '  ' +
    chalk.dim('PID')
  );

  for (const s of shown) {
    const label = s.name || chalk.dim(s.sessionId.slice(0, 8));
    const labelPadded = (s.name ?? s.sessionId.slice(0, 8)).padEnd(widthName);
    lines.push(
      '  ' +
      (s.name ? label.padEnd(widthName) : label + ' '.repeat(widthName - 8)) + '  ' +
      s.profile.padEnd(widthProf) + '  ' +
      colorStatus(s.status, s.alive) + '  ' +
      shortCwd(s.cwd).padEnd(widthCwd) + '  ' +
      timeAgo(s.updatedAt).padStart(8) + '  ' +
      (s.alive ? String(s.pid) : chalk.dim(String(s.pid)))
    );
    void labelPadded;
  }
  if (dead.length > 5) {
    lines.push(chalk.dim(`  …and ${dead.length - 5} more stale entries (run \`sweech agents --all\` to see them)`));
  }
  return lines.join('\n');
}

export function renderConfigured(records: ConfiguredAgent[], windowDays: number, dirCount: number): string {
  const lines: string[] = [];
  lines.push(chalk.bold('Configured agents') + chalk.dim(` — ${records.length} across ${dirCount} profile dir(s), ${windowDays}d invocations`));
  lines.push('');
  if (records.length === 0) {
    lines.push(chalk.dim('  no agents configured'));
    return lines.join('\n');
  }
  const fmtProfs = (set: Set<string>): string => {
    const sorted = [...set].sort();
    if (sorted.length <= 3) return sorted.join(', ');
    return `${sorted.slice(0, 2).join(', ')} +${sorted.length - 2} more`;
  };
  const widthName = Math.max(5, ...records.map(r => r.name.length));
  const widthProf = Math.max(8, ...records.map(r => fmtProfs(r.profiles).length));
  lines.push(
    '  ' +
    chalk.dim('AGENT'.padEnd(widthName)) + '  ' +
    chalk.dim('SRC    ') + '  ' +
    chalk.dim('PROFILES'.padEnd(widthProf)) + '  ' +
    chalk.dim('USED'.padStart(5)) + '  ' +
    chalk.dim('LAST')
  );
  for (const r of records) {
    const src = r.source === 'user' ? chalk.green('user   ') : chalk.cyan('builtin');
    const used = r.invocations > 0 ? chalk.bold(String(r.invocations).padStart(5)) : chalk.dim('    0');
    lines.push(
      '  ' +
      r.name.padEnd(widthName) + '  ' +
      src + '  ' +
      fmtProfs(r.profiles).padEnd(widthProf) + '  ' +
      used + '  ' +
      timeAgo(r.lastTs)
    );
  }
  return lines.join('\n');
}

// ── Entry points used by cli.ts ───────────────────────────────────────────

export function runLiveAgents(opts: { showAll?: boolean } = {}): void {
  const dirs = enumerateClaudeConfigDirs();
  let sessions = readLiveSessions(dirs);
  if (!opts.showAll) {
    // Hide stale entries older than 24h
    const cutoff = Date.now() - 86_400_000;
    sessions = sessions.filter(s => s.alive || (s.updatedAt ?? 0) > cutoff);
  }
  console.log(renderLiveSessions(sessions, dirs.length));
}

export function runConfiguredAgents(windowDays = 7): void {
  const dirs = enumerateClaudeConfigDirs();
  const records = aggregateConfigured(windowDays, dirs);
  console.log(renderConfigured(records, windowDays, dirs.length));
}

// Backward-compat alias for the prior export.
export const runAggregatedAgents = runConfiguredAgents;
