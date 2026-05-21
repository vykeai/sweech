import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { SessionsDb, type DashboardSession } from './sessionsDb';
import { routeWithinBudget } from './budgetRouter';
import { ConfigManager } from './config';
import { getCLI } from './clis';
import { buildAutoExecEnv, readSettingsEnv } from './autoCommand';

const DEFAULT_EVENT_LIMIT = 30;
const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_JSONL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';

export interface JsonlEventDigest {
  role: string;
  text: string;
  at?: number;
}

export interface SessionSummaryResult {
  sessionId: string;
  summaryOne: string;
  summaryBullets: string[];
  summaryProvider: string;
  summaryModel: string | null;
  summaryCostUsd: number | null;
  summaryAt: number;
  summaryMsgAt: number;
}

export interface SummaryCommandResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
  status?: number | null;
}

export type SummaryCommandRunner = (args: string[], input: string) => Promise<SummaryCommandResult>;
export type SummaryEventPublisher = (type: 'summary.updated', data: unknown) => void;

export interface SessionSummarizerOptions {
  db?: SessionsDb;
  eventLimit?: number;
  debounceMs?: number;
  timeoutMs?: number;
  maxJsonlBytes?: number;
  maxOutputBytes?: number;
  allowCloudFallback?: boolean;
  ollamaUrl?: string;
  ollamaModel?: string;
  now?: () => number;
  runCommand?: SummaryCommandRunner;
  publish?: SummaryEventPublisher;
}

interface PendingItem {
  sessionId: string;
  reason: SummaryTriggerReason;
  resolve: (result: SessionSummaryResult | null) => void;
  reject: (error: unknown) => void;
}

export type SummaryTriggerReason = 'eager' | 'session-end' | 'viewport';

export class SessionSummarizer {
  private readonly db: SessionsDb;
  private readonly eventLimit: number;
  private readonly maxJsonlBytes: number;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly runCommand: SummaryCommandRunner;
  private readonly publish: SummaryEventPublisher;
  private readonly ownsDb: boolean;
  private readonly pending = new Map<string, PendingItem>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;

  constructor(options: SessionSummarizerOptions = {}) {
    this.db = options.db ?? new SessionsDb();
    this.ownsDb = !options.db;
    this.eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
    this.maxJsonlBytes = options.maxJsonlBytes ?? DEFAULT_MAX_JSONL_BYTES;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.runCommand = options.runCommand ?? defaultSummaryCommandRunner({
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      allowCloudFallback: options.allowCloudFallback ?? process.env.SWEECH_SUMMARY_ALLOW_CLOUD === '1',
      ollamaUrl: options.ollamaUrl ?? process.env.SWEECH_SUMMARY_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
      ollamaModel: options.ollamaModel ?? process.env.SWEECH_SUMMARY_OLLAMA_MODEL ?? 'llama3.2',
    });
    this.publish = options.publish ?? defaultSummaryEventPublisher;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const item of this.pending.values()) {
      item.resolve(null);
    }
    this.pending.clear();
    if (this.ownsDb) this.db.close();
  }

  shouldSummarize(session: DashboardSession, reason: SummaryTriggerReason): boolean {
    if (!session.jsonlPath) return false;
    if (reason === 'session-end' || reason === 'viewport') return session.summaryStale || !session.summaryOne;
    if (session.messageCount <= 0) return false;
    if (!session.summaryMsgAt) return session.messageCount >= 50;
    return session.messageCount >= session.summaryMsgAt + 50;
  }

  enqueue(sessionId: string, reason: SummaryTriggerReason = 'eager'): Promise<SessionSummaryResult | null> {
    const existing = this.pending.get(sessionId);
    if (existing) {
      existing.reason = preferReason(existing.reason, reason);
      return new Promise((resolve, reject) => {
        const priorResolve = existing.resolve;
        const priorReject = existing.reject;
        existing.resolve = (result) => { priorResolve(result); resolve(result); };
        existing.reject = (error) => { priorReject(error); reject(error); };
      });
    }

    const promise = new Promise<SessionSummaryResult | null>((resolve, reject) => {
      this.pending.set(sessionId, { sessionId, reason, resolve, reject });
    });
    this.schedule();
    return promise;
  }

  async summarizeNow(sessionId: string, reason: SummaryTriggerReason = 'eager'): Promise<SessionSummaryResult | null> {
    const session = this.db.byId(sessionId);
    if (!session || !this.shouldSummarize(session, reason)) return null;
    const events = readJsonlDigest(session.jsonlPath, this.eventLimit, this.maxJsonlBytes);
    if (events.length === 0) return null;

    const prompt = buildSummaryPrompt(session, events);
    const providerResult = await runHybridSummary(prompt, this.runCommand);
    const parsed = parseSummaryResponse(providerResult.stdout);
    const summaryAt = this.now();
    const updated = this.db.updateSummary(session.id, {
      summaryOne: parsed.summaryOne,
      summaryBullets: parsed.summaryBullets,
      summaryProvider: providerResult.provider,
      summaryModel: parsed.model ?? providerResult.model,
      summaryCostUsd: parsed.costUsd ?? providerResult.costUsd,
      summaryAt,
      summaryMsgAt: session.messageCount,
    });
    if (!updated) return null;

    const result: SessionSummaryResult = {
      sessionId: session.id,
      summaryOne: parsed.summaryOne,
      summaryBullets: parsed.summaryBullets,
      summaryProvider: providerResult.provider,
      summaryModel: parsed.model ?? providerResult.model,
      summaryCostUsd: parsed.costUsd ?? providerResult.costUsd,
      summaryAt,
      summaryMsgAt: session.messageCount,
    };
    this.publish('summary.updated', { session: updated, summary: result });
    return result;
  }

  private schedule(): void {
    if (this.timer || this.processing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.pending.size > 0) {
        const [sessionId, item] = this.pending.entries().next().value as [string, PendingItem];
        this.pending.delete(sessionId);
        try {
          item.resolve(await this.summarizeNow(sessionId, item.reason));
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.processing = false;
      if (this.pending.size > 0) this.schedule();
    }
  }
}

export function shouldEagerlySummarize(session: DashboardSession): boolean {
  return new SessionSummarizer({ db: noopDb(session) }).shouldSummarize(session, 'eager');
}

export function buildSummaryPrompt(session: DashboardSession, events: JsonlEventDigest[]): string {
  const transcript = events.map((event, index) => {
    const prefix = `${index + 1}. ${event.role}`;
    return `${prefix}: ${event.text}`;
  }).join('\n');
  return [
    'Summarise this coding-agent session for a dashboard tile.',
    'Return strict JSON with keys: summary_one, bullets, model, cost_usd.',
    'summary_one must be one short sentence. bullets must contain 3 to 5 recent concrete activities.',
    `Workspace: ${session.workspace}`,
    `CWD: ${session.cwd}`,
    `Status: ${session.status}`,
    `Message count: ${session.messageCount}`,
    '',
    transcript,
  ].join('\n');
}

export function readJsonlDigest(jsonlPath: string | null, limit = DEFAULT_EVENT_LIMIT, maxBytes = DEFAULT_MAX_JSONL_BYTES): JsonlEventDigest[] {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return [];
  const safePath = resolveSafeJsonlPath(jsonlPath);
  if (!safePath) return [];
  const stat = fs.statSync(safePath);
  if (!stat.isFile()) return [];
  const fd = fs.openSync(safePath, 'r');
  try {
    const bytesToRead = Math.min(stat.size, Math.max(1, maxBytes));
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    const out: JsonlEventDigest[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < Math.max(1, limit); i--) {
      const event = parseJsonlLine(lines[i]);
      if (event?.text.trim()) out.push(event);
    }
    return out.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

export function parseSummaryResponse(stdout: string): { summaryOne: string; summaryBullets: string[]; model: string | null; costUsd: number | null } {
  const json = extractJsonObject(stdout);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const summaryOne = stringValue(parsed.summary_one ?? parsed.summaryOne ?? parsed.title);
  const rawBullets = Array.isArray(parsed.bullets)
    ? parsed.bullets
    : Array.isArray(parsed.summary_bullets)
      ? parsed.summary_bullets
      : [];
  const summaryBullets = rawBullets.map((item) => String(item).trim()).filter(Boolean).slice(0, 5);
  if (!summaryOne) throw new Error('summary response missing summary_one');
  if (summaryBullets.length < 1) throw new Error('summary response missing bullets');
  return {
    summaryOne,
    summaryBullets,
    model: stringValue(parsed.model) || null,
    costUsd: numberValue(parsed.cost_usd ?? parsed.costUsd),
  };
}

async function runHybridSummary(prompt: string, runCommand: SummaryCommandRunner): Promise<{
  stdout: string;
  provider: string;
  model: string | null;
  costUsd: number | null;
}> {
  const local = await runCommand(['auto', '--provider', 'ollama', '--json'], prompt);
  if (local.ok) return { stdout: local.stdout, provider: 'ollama', model: null, costUsd: 0 };

  const fallback = await runCommand(['auto', '--budget', '0.005', '--json'], prompt);
  if (fallback.ok) return { stdout: fallback.stdout, provider: 'auto-budget', model: null, costUsd: null };
  throw new Error('summary provider failed');
}

function defaultSummaryCommandRunner(options: {
  timeoutMs: number;
  maxOutputBytes: number;
  allowCloudFallback: boolean;
  ollamaUrl: string;
  ollamaModel: string;
}): SummaryCommandRunner {
  return async (args, input) => {
    if (args.includes('ollama')) {
      return runOllamaSummary(options.ollamaUrl, options.ollamaModel, input, options.timeoutMs);
    }
    if (args.includes('--budget')) {
      if (!options.allowCloudFallback) {
        return { ok: false, stdout: '', stderr: 'cloud summary fallback disabled', status: 1 };
      }
      return runBudgetedCloudSummary(redactPromptForCloud(input), options.timeoutMs, options.maxOutputBytes);
    }
    return { ok: false, stdout: '', stderr: 'unknown summary route', status: 1 };
  };
}

async function runOllamaSummary(ollamaUrl: string, model: string, prompt: string, timeoutMs: number): Promise<SummaryCommandResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, stdout: '', stderr: `ollama returned ${response.status}`, status: response.status };
    const parsed = JSON.parse(text) as { response?: unknown; model?: unknown };
    return {
      ok: true,
      stdout: typeof parsed.response === 'string' ? parsed.response : text,
      stderr: '',
      status: response.status,
    };
  } catch (error) {
    return { ok: false, stdout: '', stderr: sanitizeProviderError(error), status: null };
  } finally {
    clearTimeout(timer);
  }
}

async function runBudgetedCloudSummary(prompt: string, timeoutMs: number, maxOutputBytes: number): Promise<SummaryCommandResult> {
  try {
    const route = await routeWithinBudget({ cliType: 'claude', maxCostPerCallUsd: 0.005 });
    if (!route) return { ok: false, stdout: '', stderr: 'no cloud summary route under budget', status: 1 };
    const cli = getCLI(route.cliType);
    if (!cli || cli.name !== 'claude') return { ok: false, stdout: '', stderr: 'selected cli has no summary non-interactive mode', status: 1 };
    const profile = new ConfigManager().getProfiles().find((candidate) => candidate.commandName === route.account);
    if (!profile) return { ok: false, stdout: '', stderr: 'selected summary profile missing', status: 1 };
    const config = new ConfigManager();
    const configDir = config.getProfileDir(profile.commandName);
    const env = buildAutoExecEnv(cli, configDir, process.env, readSettingsEnv(configDir));
    return await runBoundedChild(cli.command, ['-p', prompt], env, timeoutMs, maxOutputBytes);
  } catch (error) {
    return { ok: false, stdout: '', stderr: sanitizeProviderError(error), status: null };
  }
}

function runBoundedChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<SummaryCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SummaryCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGTERM');
        return;
      }
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, stdout, stderr: stderr || sanitizeProviderError(error), status: null });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      finish({
        ok: status === 0,
        stdout,
        stderr: signal ? 'summary provider terminated before completion' : sanitizeProviderError(stderr),
        status,
      });
    });
  });
}

function resolveSafeJsonlPath(jsonlPath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(jsonlPath);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return null;
  let realPath: string;
  try {
    realPath = fs.realpathSync(jsonlPath);
  } catch {
    return null;
  }
  if (!realPath.endsWith('.jsonl')) return null;
  const home = fs.realpathSync(os.homedir());
  const roots = [
    ...summaryJsonlRootOverrides(),
    path.join(home, '.claude'),
    ...safeHomeEntries(home).filter((entry) => entry.startsWith('.claude-')).map((entry) => path.join(home, entry)),
  ].map((root) => {
    const projectsRoot = path.join(root, 'projects');
    try {
      return fs.realpathSync(projectsRoot) + path.sep;
    } catch {
      return projectsRoot + path.sep;
    }
  });
  return roots.some((root) => realPath.startsWith(root)) ? realPath : null;
}

function parseJsonlLine(line: string): JsonlEventDigest | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const message = parsed.message && typeof parsed.message === 'object'
      ? parsed.message as Record<string, unknown>
      : parsed;
    const role = stringValue(message.role ?? parsed.role ?? parsed.type) || 'event';
    const text = extractEventText(message) || extractEventText(parsed);
    if (!text) return null;
    return { role, text: truncate(text, 1_200), at: numberValue(parsed.timestamp ?? parsed.created_at) ?? undefined };
  } catch {
    return null;
  }
}

function extractEventText(source: Record<string, unknown>): string {
  const direct = stringValue(source.text ?? source.content ?? source.aiTitle ?? source.summary);
  if (direct) return direct;
  const content = source.content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return stringValue((item as Record<string, unknown>).text);
      return '';
    }).filter(Boolean).join(' ');
  }
  return '';
}

function extractJsonObject(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('summary response was not JSON');
  return trimmed.slice(start, end + 1);
}

export function redactPromptForCloud(prompt: string): string {
  return prompt
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,})\b/g, '[redacted-api-key]')
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD)[A-Za-z0-9_]*=([^\s]+)/gi, (match) => {
      const key = match.split('=')[0];
      return `${key}=[redacted]`;
    })
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]');
}

function safeHomeEntries(home: string): string[] {
  try {
    return fs.readdirSync(home);
  } catch {
    return [];
  }
}

function summaryJsonlRootOverrides(): string[] {
  return (process.env.SWEECH_SUMMARY_JSONL_ROOTS ?? '')
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
}

function defaultSummaryEventPublisher(type: 'summary.updated', data: unknown): void {
  try {
    const { publishDashboardEvent } = require('./dashboardServer') as typeof import('./dashboardServer');
    publishDashboardEvent(type, data);
  } catch {
    // Summary writeback already succeeded; an SSE publish failure must not
    // make the durable DB update look failed.
  }
}

function sanitizeProviderError(error: unknown): string {
  if (typeof error === 'string') return error ? 'summary provider failed' : '';
  if (error instanceof Error) return error.name === 'AbortError' ? 'summary provider timed out' : 'summary provider failed';
  return 'summary provider failed';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function preferReason(current: SummaryTriggerReason, next: SummaryTriggerReason): SummaryTriggerReason {
  const rank: Record<SummaryTriggerReason, number> = { eager: 1, viewport: 2, 'session-end': 3 };
  return rank[next] > rank[current] ? next : current;
}

function noopDb(session: DashboardSession): SessionsDb {
  return {
    byId: () => session,
    close: () => undefined,
  } as unknown as SessionsDb;
}
