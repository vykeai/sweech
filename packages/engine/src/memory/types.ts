// ── Conversation memory — session-scoped, transient ──────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp */
  ts?: string;
}

/**
 * Stores and retrieves conversation history for a session.
 * Session-scoped: cleared when the session ends or explicitly cleared.
 * Products own the storage backend — omnai owns the contract.
 */
export interface ConversationStore {
  load(sessionId: string): Promise<ChatMessage[]>;
  save(sessionId: string, messages: ChatMessage[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

// ── Agent memory — agent-scoped, persistent markdown ─────────────────────────

/**
 * Stores and retrieves persistent markdown memory for an agent.
 * Agent-scoped (not session-scoped): accumulates across all sessions.
 * The canonical format is human-readable markdown.
 * Products own where files live — omnai owns the contract.
 */
export interface AgentMemoryStore {
  /** Returns the full markdown blob for this agent. Empty string if none. */
  read(agentId: string): Promise<string>;
  /**
   * Appends a new insight to this agent's memory.
   * Implementations should add a dated heading before the insight.
   */
  append(agentId: string, insight: string): Promise<void>;
  /**
   * Optional full-text search over the agent's memory.
   * Returns matching excerpts ranked by relevance.
   */
  search?(agentId: string, query: string): Promise<string[]>;
}
