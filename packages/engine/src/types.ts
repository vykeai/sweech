export type EngineId = 'claude-code' | 'qwen-code' | 'gemini-cli' | 'amazon-q' | 'pi-mono' | 'opencode' | 'goose' | 'codex' | 'copilot' | 'http';

export type Provider =
  | 'claude'       // Local Claude Code subscription (~/.claude/) — no API key
  | 'codex'        // Local Codex CLI subscription/login — no API key
  | 'qwen'         // Local Qwen Code subscription — no API key
  | 'anthropic'    // Anthropic API via pi-mono — requires ANTHROPIC_API_KEY
  | 'openai'
  | 'google'
  | 'ollama'
  | 'openrouter'
  | 'deepseek'
  | 'groq'
  | 'cerebras'
  | 'xai'
  | 'mistral'
  | 'minimax'
  | 'kimi'
  | 'azure'
  | 'bedrock'
  | 'vercel'
  | 'dashscope'    // Alibaba Cloud DashScope — OpenAI-compat or Anthropic-compat endpoint
  | 'gemini'       // Local Gemini CLI subscription — no API key (1000 req/day free)
  | 'amazon-q'     // Local Amazon Q CLI — AWS Builder ID free tier (50 agentic req/mo)
  | 'github'       // GitHub Copilot subscription — multi-model (Claude, GPT, Gemini)
  | 'copilot'      // Alias for 'github'
  | string; // OpenAI-compat custom

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; name: string; input: unknown; id?: string; toolCallId?: string; tool_call_id?: string; toolUseId?: string; tool_use_id?: string; startedAt?: number; durationMs?: number; policyAudit?: import('./middleware/types.js').ToolPolicyAuditRecord }
  | { type: 'tool_result'; name: string; content: string; isError: boolean; id?: string; toolCallId?: string; tool_call_id?: string; toolUseId?: string; tool_use_id?: string; startedAt?: number; durationMs?: number; policyAudit?: import('./middleware/types.js').ToolPolicyAuditRecord }
  | { type: 'hook_error'; hookEvent: 'PreToolUse' | 'PostToolUse' | 'Stop'; hookId: string; code: string; message: string; recoverable: boolean; toolName?: string; sessionId?: string }
  | { type: 'result'; output: string; sessionId?: string; usage: TokenUsage; costUsd: number; durationMs: number }
  | { type: 'error'; message: string; code?: string; retry?: import('./middleware/types.js').RetryDecisionAudit; reroute?: import('./middleware/types.js').BudgetRerouteAudit; policyAudit?: import('./middleware/types.js').ToolPolicyAuditRecord }
  | { type: 'stream_parse_error'; source: 'stdout' | 'stderr'; line: number; raw: string; reason: string }
  | { type: 'progress'; tokensGenerated: number; estimatedTotal?: number; percentComplete?: number }
  | { type: 'cost_update'; costUsd: number; tokensUsed: TokenUsage };

// ── Hooks (claude-code only) ──────────────────────────────────────────────────

export interface HookEntry {
  command?: string;
  block?: boolean;
}

/** Function hook — matches the agent SDK's HookCallback signature */
export type FnHook = (input: any, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

export interface HookMatcher {
  matcher: string;
  hooks: (HookEntry | FnHook)[];
}

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'Notification' | 'SessionStart' | 'SessionEnd' | 'SubagentStart' | 'SubagentStop';

export interface RunHooks {
  PreToolUse?: HookMatcher[];
  PostToolUse?: HookMatcher[];
  Stop?: HookMatcher[];
  [key: string]: HookMatcher[] | undefined;
}

// ── Permission modes ──────────────────────────────────────────────────────────

/** claude-code full permission mode set */
export type PermissionMode = 'ask' | 'bypass' | 'auto' | 'acceptEdits' | 'plan' | 'dontAsk';

// ── Thinking config ───────────────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type ThinkingConfig =
  | { type: 'disabled' }
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number };

// ── Structured output ─────────────────────────────────────────────────────────

export interface OutputFormat {
  type: 'json';
  schema: Record<string, unknown>;
}

// ── MCP server config ─────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ── RunOptions ────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Working directory for the agent. Defaults to process.cwd(). */
  cwd?: string;
  /** Abstract tier ('opus'|'sonnet'|'haiku') or concrete model ID. */
  model?: string;
  /** Provider. Defaults to 'claude' (local subscription). */
  provider?: Provider;
  /** Base URL for OpenAI-compatible endpoints. */
  baseUrl?: string;
  abortSignal?: AbortSignal;
  maxBudgetUsd?: number;
  /** claude-code: effort level. pi-mono: maps to thinking level. */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Resume a previous session by ID. */
  resumeSessionId?: string;
  env?: Record<string, string>;
  permissionMode?: PermissionMode;

  // ── Prompt / context ───────────────────────────────────────────────────────
  /** Override or append to the system prompt. */
  systemPrompt?: string;
  /** Extra directories the agent can access (claude-code only). */
  additionalDirectories?: string[];

  // ── Tools ──────────────────────────────────────────────────────────────────
  /** Restrict to specific tools. Empty array = no tools. */
  allowedTools?: string[];
  /** Explicitly remove tools from context. */
  disallowedTools?: string[];
  /** Policy controls for tool and command validation. */
  toolPolicy?: import('./middleware/types.js').ToolPolicy;

  // ── Thinking ───────────────────────────────────────────────────────────────
  /** Thinking configuration. claude-code: full ThinkingConfig. pi-mono: mapped to --thinking flag. */
  thinking?: ThinkingConfig | ThinkingLevel;

  // ── Session ────────────────────────────────────────────────────────────────
  /** Continue the most recent session in cwd (claude-code only). */
  continueSession?: boolean;
  /** Don't persist session to disk (claude-code only). */
  persistSession?: boolean;
  /** Cap conversation turns (claude-code only). */
  maxTurns?: number;

  // ── Output ─────────────────────────────────────────────────────────────────
  /** Structured JSON output schema (claude-code only). */
  outputFormat?: OutputFormat;

  // ── MCP (claude-code only) ─────────────────────────────────────────────────
  /** Inject MCP server configs programmatically. */
  mcpServers?: Record<string, McpServerConfig>;

  // ── Hooks (claude-code only) ───────────────────────────────────────────────
  hooks?: RunHooks;

  // ── pi-mono specific ───────────────────────────────────────────────────────
  /** Max output tokens (pi-mono). */
  maxTokens?: number;
  /** Sampling temperature 0-1 (pi-mono). */
  temperature?: number;
  /** Explicit API key — prefer env vars, use this for dynamic key switching (pi-mono). */
  apiKey?: string;

  // ── Middleware options ──────────────────────────────────────────────────────
  /** Credential profile name from ~/.omnai/profiles.json. */
  profile?: string;
  /**
   * Sweech profile name (e.g. "codex-ted", "claude-pole").
   * Resolves to an estate account via Sweech auto-merge — the profile's
   * commandName becomes the account ID and its configDir sets CODEX_HOME
   * or CLAUDE_CONFIG_DIR. Falls back to default routing if Sweech is absent.
   */
  sweechProfile?: string;
  /**
   * Named account route.
   *
   * This is the preferred routing dimension above raw profile names:
   * - local Sweech-managed Claude/Codex accounts such as `claude-ted`
   * - named API-key accounts from ~/.omnai/providers.yaml / estate.yaml such as `dashscope-prod`
   *
   * When both `account` and `profile` are supplied, `account` wins.
   */
  account?: string;
  /** Retry/fallback policy. Set `managedBy: 'omnai'` to use built-in retry, or 'consumer' (default) to handle it yourself. */
  retryPolicy?: import('./middleware/types.js').RetryPolicy;
  /** Shared cost accumulator across runs. */
  costAccumulator?: import('./middleware/types.js').CostAccumulator;
  /** Route to this cost tier instead of default engine selection (e.g. 'free', 'cheap', 'full'). */
  budgetTier?: string;
  /** Hint for what kind of task this is — used to filter models by capability */
  taskType?: 'coding' | 'analysis' | 'planning' | 'review' | 'chat' | 'research';
  /** Input content type — 'image' or 'mixed' routes to a vision-capable engine */
  contentType?: 'text' | 'image' | 'mixed';
  /** Domain tag for routing — matches accounts tagged in providers.yaml (e.g. 'fitness', 'midi') */
  domain?: string;
  /** Subscription quality tier — routes to matching account type (gold/premium/full=subscription, silver/standard/cheap=api-key, bronze/free/economy=free-tier) */
  tier?: string;
  /** Ordered fallback accounts to try when the primary account is unavailable or quota-limited. */
  fallbackAccounts?: string[];
  /** Dynamic account selection hint for subscription seats backed by Sweech telemetry. */
  accountStrategy?: import('./subscription-routing.js').AccountRoutingStrategy;
  /** Auto-downgrade or abort when cumulative cost exceeds threshold. */
  budgetGuard?: import('./middleware/types.js').BudgetGuard;
  /** Custom HTTP headers to send with API requests. Merged with provider defaults. */
  headers?: Record<string, string>;
}

export interface ModelRunner {
  engine: EngineId;
  isAvailable(): Promise<boolean>;
  run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent>;
}

/** @deprecated Use `ModelRunner` instead. */
export type AgentRunner = ModelRunner;

export interface EngineStatus {
  engine: EngineId;
  available: boolean;
  binaryPath?: string;
  providers?: Provider[];
}

export interface OmnaiConfig {
  defaultProvider?: Provider;
  defaultModel?: string;
  claudeBinaryPath?: string;
  piMonoBinaryPath?: string;
}
