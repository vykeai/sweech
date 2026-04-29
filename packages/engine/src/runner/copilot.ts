import type { ModelRunner, AgentEvent, RunOptions, TokenUsage } from '../types.js';

const MODEL_MAP: Record<string, string> = {
  opus:   'claude-opus-4.6',
  sonnet: 'claude-sonnet-4.6',
  haiku:  'claude-haiku-4.5',
  'gpt-5':     'gpt-5.4',
  'gpt-5-mini': 'gpt-5-mini',
  'codex':     'gpt-5.3-codex',
  'gemini':    'gemini-3-pro-preview',
};

function resolveModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return MODEL_MAP[model] ?? model;
}

interface CopilotJsonEvent {
  type: string;
  data?: {
    deltaContent?: string;
    content?: string;
    messageId?: string;
    outputTokens?: number;
    toolRequests?: { name: string; input: unknown; id: string }[];
    toolName?: string;
    toolCallId?: string;
    result?: string;
    isError?: boolean;
  };
  sessionId?: string;
  exitCode?: number;
  usage?: {
    premiumRequests?: number;
    totalApiDurationMs?: number;
    sessionDurationMs?: number;
  };
}

type CopilotStreamSource = 'stdout' | 'stderr';

interface StreamState {
  buffer: string;
  line: number;
}

interface StreamChunk {
  source: CopilotStreamSource;
  result: IteratorResult<unknown>;
}

interface ParsedLine {
  events: AgentEvent[];
  outputTokens: number;
  sessionId?: string;
  setUsageFromResult?: boolean;
}

function readChunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString();
  return String(chunk);
}

function parseLine(
  line: string,
  source: CopilotStreamSource,
  lineNumber: number,
  pendingTools: Map<string, string>,
): ParsedLine {
  if (!line.trim()) return { events: [], outputTokens: 0 };

  try {
    const event = JSON.parse(line) as CopilotJsonEvent;
    const parsed: ParsedLine = { events: [], outputTokens: 0 };

    switch (event.type) {
      case 'assistant.message_delta':
        if (event.data?.deltaContent) {
          parsed.events.push({ type: 'text', content: event.data.deltaContent });
        }
        break;
      case 'assistant.message':
        if (event.data?.outputTokens) {
          parsed.outputTokens += event.data.outputTokens;
        }
        if (event.data?.toolRequests) {
          for (const tr of event.data.toolRequests) {
            pendingTools.set(tr.id, tr.name);
            parsed.events.push({ type: 'tool_use', name: tr.name, input: tr.input });
          }
        }
        break;
      case 'tool.result':
        if (event.data?.toolCallId) {
          const toolName = pendingTools.get(event.data.toolCallId) ?? event.data.toolName ?? 'unknown';
          pendingTools.delete(event.data.toolCallId);
          parsed.events.push({
            type: 'tool_result',
            name: toolName,
            content: event.data.result ?? '',
            isError: event.data.isError ?? false,
          });
        }
        break;
      case 'result':
        parsed.sessionId = event.sessionId;
        if (event.usage?.totalApiDurationMs) {
          parsed.setUsageFromResult = true;
        }
        break;
      case 'error':
        parsed.events.push({ type: 'error', message: event.data?.content ?? 'Copilot error' });
        break;
      default:
        break;
    }

    return parsed;
  } catch {
    return {
      events: [
        {
          type: 'stream_parse_error',
          source,
          line: lineNumber,
          raw: line,
          reason: `Invalid Copilot JSON event line from ${source}`,
        },
      ],
      outputTokens: 0,
    };
  }
}

function parseChunk(
  chunk: string,
  source: CopilotStreamSource,
  state: StreamState,
  pendingTools: Map<string, string>,
): ParsedLine[] {
  let { buffer } = state;
  buffer += chunk;
  const lines = buffer.split('\n');
  state.buffer = lines.pop() ?? '';

  return lines
    .filter(line => line.trim())
    .map(line => {
      return parseLine(line, source, state.line++, pendingTools);
    });
}

function parseFinalBuffer(
  source: CopilotStreamSource,
  state: StreamState,
  pendingTools: Map<string, string>,
): ParsedLine[] {
  const tail = state.buffer.trim();
  state.buffer = '';
  if (!tail) return [];
  return [parseLine(tail, source, state.line++, pendingTools)];
}

export class CopilotRunner implements ModelRunner {
  readonly engine = 'copilot' as const;

  constructor(private readonly binaryPath: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      const { access } = await import('node:fs/promises');
      await access(this.binaryPath);
      return true;
    } catch {
      return false;
    }
  }

  async *run(prompt: string, opts: RunOptions): AsyncGenerator<AgentEvent> {
    const { execa } = await import('execa');
    const startMs = Date.now();

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      '--allow-all-tools',
      '--stream', 'on',
    ];

    const model = resolveModel(opts.model);
    if (model) args.push('--model', model);

    if (opts.cwd) args.push('--add-dir', opts.cwd);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    if (opts.continueSession) args.push('--continue');
    if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);

    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
      const mcpConfig: Record<string, { command: string; args?: string[] }> = {};
      for (const [name, config] of Object.entries(opts.mcpServers)) {
        mcpConfig[name] = { command: config.command, args: config.args };
      }
      args.push('--additional-mcp-config', JSON.stringify({ mcpServers: mcpConfig }));
    }

    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...opts.env,
    };
    delete childEnv['CLAUDECODE'];
    delete childEnv['CLAUDE_CODE_ENTRYPOINT'];

    const proc = execa(this.binaryPath, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: childEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
    });

    let sessionId: string | undefined;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let finalOutput = '';
    let totalOutputTokens = 0;
    const states: Record<CopilotStreamSource, StreamState> = {
      stdout: { buffer: '', line: 0 },
      stderr: { buffer: '', line: 0 },
    };

    const pendingTools = new Map<string, string>(); // id -> name

    const streams: Array<{ source: CopilotStreamSource; iterator: AsyncIterator<unknown> | undefined }> = [
      { source: 'stdout', iterator: proc.stdout?.[Symbol.asyncIterator]() },
      { source: 'stderr', iterator: proc.stderr?.[Symbol.asyncIterator]() },
    ];

    const pending = new Map<CopilotStreamSource, Promise<StreamChunk>>();
    const applyParsed = (parsed: ParsedLine) => {
      totalOutputTokens += parsed.outputTokens;
      if (parsed.setUsageFromResult) {
        usage = {
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: totalOutputTokens,
        };
      }
      if (parsed.sessionId) sessionId = parsed.sessionId;
      return parsed.events;
    };

    for (const { source, iterator } of streams) {
      if (!iterator) continue;
      const next = iterator.next().then((result): StreamChunk => ({ source, result }));
      pending.set(source, next);
    }

    while (pending.size > 0) {
      const chunkResult = await Promise.race(Array.from(pending.values()));
      const { source, result } = chunkResult;

      pending.delete(source);
      if (result.done) {
        continue;
      }

      const state = states[source];
      const chunkText = readChunkText(result.value);
      for (const parsed of parseChunk(chunkText, source, state, pendingTools)) {
        for (const event of applyParsed(parsed)) {
          if (event.type === 'text') {
            finalOutput += event.content;
          }
          yield event;
        }
      }

      const iterator = streams.find(({ source: streamSource }) => streamSource === source)?.iterator;
      if (iterator) {
        const next = iterator.next().then((resultNext): StreamChunk => ({ source, result: resultNext }));
        pending.set(source, next);
      }
    }

    for (const source of ['stdout', 'stderr'] as CopilotStreamSource[]) {
      const state = states[source];
      for (const parsed of parseFinalBuffer(source, state, pendingTools)) {
        for (const event of applyParsed(parsed)) {
          if (event.type === 'text') {
            finalOutput += event.content;
          }
          yield event;
        }
      }
    }

    await proc;

    if (proc.exitCode && proc.exitCode !== 0 && !finalOutput) {
      yield { type: 'error', message: `Copilot exited with code ${proc.exitCode}` };
    }

    yield {
      type: 'result',
      output: finalOutput,
      sessionId,
      usage,
      costUsd,
      durationMs: Date.now() - startMs,
    };
  }
}
