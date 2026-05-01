/**
 * @sweech/ui/server — server-side SSE bridge
 *
 * Runs a ModelRunner and streams SweechUIEvent over HTTP SSE.
 * No WebSocket dependency. Use EventSource in the browser.
 *
 * @example
 * import { handleAgentSse } from '@sweech/ui/server'
 *
 * http.createServer(async (req, res) => {
 *   if (req.url === '/api/agent/stream') {
 *     await handleAgentSse(res, { runner, prompt, runOptions })
 *   }
 * })
 */

import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  STREAM_KIND_UI,
  STREAM_PROTOCOL,
  STREAM_PROTOCOL_VERSION,
  getSweechStreamSeverity,
  type ModelRunner,
  type AgentEvent,
  type RunOptions,
} from '@sweech/engine'
import type { SweechUIEvent, SweechUIEventEnvelope } from '../types/index.js'

/** @deprecated Use getSweechStreamSeverity from @sweech/engine */
export { getSweechStreamSeverity as getOmnaiStreamSeverity } from '@sweech/engine'

interface UiStreamEnvelopeContext {
  streamId: string
  requestId: string
  traceId: string
  correlationId: string
  sequence: number
}

function makeStreamEnvelope(context: UiStreamEnvelopeContext, event: SweechUIEvent): SweechUIEventEnvelope {
  return {
    schema: STREAM_PROTOCOL,
    version: STREAM_PROTOCOL_VERSION,
    kind: STREAM_KIND_UI,
    streamId: context.streamId,
    requestId: context.requestId,
    sequence: context.sequence,
    traceId: context.traceId,
    severity: getSweechStreamSeverity(event),
    componentId: 'ui.bridge.sse',
    correlationId: context.correlationId,
    event,
    ts: new Date().toISOString(),
  }
}

export interface AgentSseOptions {
  runner: ModelRunner
  prompt: string
  runOptions?: RunOptions
  /** Task ID to use in events — defaults to a timestamp-based ID */
  taskId?: string
  /** Title shown in UI for this session */
  title?: string
  requestId?: string
  traceId?: string
  streamId?: string
  correlationId?: string
}

/** Convert a single AgentEvent into the equivalent SweechUIEvents for the wire protocol */
export function agentEventToUIEvents(event: AgentEvent, taskId: string, title = 'Agent'): SweechUIEvent[] {
  switch (event.type) {
    case 'text':
      return [{ type: 'task_output', taskId, text: event.content }]

    case 'thinking':
      return [{ type: 'task_thinking', taskId, text: event.content }]

    case 'tool_use':
      return [{ type: 'task_tool_call', taskId, toolName: event.name, toolInput: event.input }]

    case 'tool_result':
      return [{ type: 'task_tool_result', taskId, toolName: event.name, content: event.content, isError: event.isError }]

    case 'result':
      return [
        {
          type: 'cost_update',
          totalUsd: event.costUsd,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadTokens: event.usage.cacheReadTokens ?? 0,
          byModel: {},
        },
        {
          type: 'task_completed',
          taskId,
          title,
          durationMs: event.durationMs,
          resultSummary: event.output?.slice(0, 300) || 'Done.',
        },
        { type: 'session_completed', durationMs: event.durationMs, totalUsd: event.costUsd },
      ]

    case 'error':
      return [
        { type: 'task_failed', taskId, title, error: event.message, willRetry: false },
        { type: 'session_failed', error: event.message },
      ]

    case 'progress':
      return [{
        type: 'progress',
        taskId,
        current: event.tokensGenerated,
        total: event.estimatedTotal ?? 0,
      }]

    case 'cost_update':
      return [{
        type: 'cost_update',
        totalUsd: event.costUsd,
        inputTokens: event.tokensUsed.inputTokens,
        outputTokens: event.tokensUsed.outputTokens,
        cacheReadTokens: event.tokensUsed.cacheReadTokens ?? 0,
        byModel: {},
      }]

    default:
      return []
  }
}

/** Yields SweechUIEvents for an agent run — transport-agnostic. Use this when handleAgentSse doesn't fit your framework. */
export async function* streamAgentEvents(opts: AgentSseOptions): AsyncGenerator<SweechUIEvent> {
  const taskId = opts.taskId ?? `task-${Date.now()}`
  const title = opts.title ?? 'Agent'

  yield { type: 'session_started' }
  yield { type: 'task_started', taskId, title, attempt: 1, maxAttempts: 1 }

  try {
    for await (const event of opts.runner.run(opts.prompt, opts.runOptions ?? {})) {
      for (const uiEvent of agentEventToUIEvents(event, taskId, title)) {
        yield uiEvent
        if (uiEvent.type === 'session_completed' || uiEvent.type === 'session_failed') return
      }
    }
  } catch (err) {
    yield { type: 'session_failed', error: String(err) }
  }
}

/**
 * Handle a single HTTP response as an SSE stream for one agent session.
 *
 * Sets the correct SSE headers, emits session_started / task_started,
 * converts all AgentEvents to SweechUIEvents, and closes the stream when done.
 */
export async function handleAgentSse(res: ServerResponse, opts: AgentSseOptions): Promise<void> {
  const streamId = opts.streamId ?? opts.taskId ?? randomUUID()
  const requestId = opts.requestId ?? randomUUID()
  const traceId = opts.traceId ?? requestId
  const correlationId = opts.correlationId ?? streamId
  let sequence = 0

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  })

  res.write('retry: 1000\n\n')

  const send = (event: SweechUIEvent) => {
    sequence += 1
    const envelope = makeStreamEnvelope({
      streamId,
      requestId,
      traceId,
      correlationId,
      sequence,
    }, event)
    res.write(`id: ${sequence}\n`)
    res.write(`data: ${JSON.stringify(envelope)}\n\n`)
  }

  for await (const event of streamAgentEvents(opts)) {
    send(event)
    if (event.type === 'session_completed' || event.type === 'session_failed') {
      res.end()
      return
    }
  }

  res.end()
}
