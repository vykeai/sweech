import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ConversationStore, AgentMemoryStore } from './types.js';

// ── ConversationStore implementations ────────────────────────────────────────

/**
 * In-memory conversation store. History is lost when the process exits.
 * Good for tests and ephemeral sessions.
 */
const MAX_SESSIONS = 10_000;
const MAX_HISTORY_PER_SESSION = 5_000;

export class InMemoryConversationStore implements ConversationStore {
  private store = new Map<string, ChatMessage[]>();

  async load(sessionId: string): Promise<ChatMessage[]> {
    return this.store.get(sessionId) ?? [];
  }

  async save(sessionId: string, messages: ChatMessage[]): Promise<void> {
    if (this.store.size >= MAX_SESSIONS && !this.store.has(sessionId)) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(sessionId, messages.slice(-MAX_HISTORY_PER_SESSION));
  }

  async clear(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }
}

/**
 * File-backed conversation store. Each session is a JSON file at `{dir}/{sessionId}.json`.
 * History survives process restarts.
 */
export class FileConversationStore implements ConversationStore {
  constructor(private readonly dir: string) {}

  private path(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  async load(sessionId: string): Promise<ChatMessage[]> {
    const p = this.path(sessionId);
    if (!existsSync(p)) return [];
    try {
      return JSON.parse(await readFile(p, 'utf8')) as ChatMessage[];
    } catch {
      return [];
    }
  }

  async save(sessionId: string, messages: ChatMessage[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(sessionId), JSON.stringify(messages, null, 2), 'utf8');
  }

  async clear(sessionId: string): Promise<void> {
    const p = this.path(sessionId);
    if (existsSync(p)) {
      const { unlink } = await import('node:fs/promises');
      await unlink(p);
    }
  }
}

// ── AgentMemoryStore implementations ─────────────────────────────────────────

/**
 * File-backed agent memory store. Each agent has a markdown file at `{dir}/{agentId}.md`.
 * Appends dated entries — same format as aiyayai's soul.md growth log.
 *
 * @example
 * const memory = new FileAgentMemoryStore('~/.myapp/memory')
 * await memory.append('twin', 'User prefers concise answers with no preamble.')
 * // Appends:
 * // ## 2026-03-12 19:30
 * // User prefers concise answers with no preamble.
 */
export class FileAgentMemoryStore implements AgentMemoryStore {
  constructor(private readonly dir: string) {}

  private path(agentId: string): string {
    // Sanitise agentId to safe filename
    const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `${safe}.md`);
  }

  async read(agentId: string): Promise<string> {
    const p = this.path(agentId);
    if (!existsSync(p)) return '';
    try {
      return await readFile(p, 'utf8');
    } catch {
      return '';
    }
  }

  async append(agentId: string, insight: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const p = this.path(agentId);
    const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const entry = `\n## ${date}\n${insight.trim()}\n`;
    const { appendFile } = await import('node:fs/promises');
    await appendFile(p, entry, 'utf8');
  }

  async search(agentId: string, query: string): Promise<string[]> {
    const content = await this.read(agentId);
    if (!content) return [];
    const q = query.toLowerCase();
    // Split into sections by ## heading, return sections containing the query
    const sections = content.split(/^## /m).filter(Boolean);
    return sections
      .filter(s => s.toLowerCase().includes(q))
      .map(s => `## ${s.trim()}`);
  }
}
