import type { AgentEvent, SweechUnsupportedStreamEvent } from '@sweech/engine'
import {
  STREAM_KIND_UI,
  STREAM_PROTOCOL_VERSION,
  isSweechUiEvent,
  isSweechUiStreamEnvelope,
  makeSweechUnsupportedStreamEvent,
} from '@sweech/engine'
import type {
  Message,
  MessageType,
  SweechUIEvent,
  SweechUIEventEnvelope,
} from '../types/index.js'

export interface ParsedSweechUiEnvelopeMeta {
  streamId: string
  requestId?: string
  sequence?: number
  traceId?: string
  severity?: SweechUIEventEnvelope['severity']
  componentId?: string
  correlationId?: string
}
/** @deprecated Use ParsedSweechUiEnvelopeMeta */
export type ParsedOmnaiUiEnvelopeMeta = ParsedSweechUiEnvelopeMeta

export interface ParsedSweechUiMessage {
  event: SweechUIEvent | null
  envelope?: ParsedSweechUiEnvelopeMeta
}
/** @deprecated Use ParsedSweechUiMessage */
export type ParsedOmnaiUiMessage = ParsedSweechUiMessage

let counter = 0
function nextId(): string { return `msg-${++counter}` }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSweechUIEvent(raw: string): SweechUIEvent | null {
  return parseSweechUiMessage(raw).event
}
/** @deprecated Use parseSweechUIEvent */
export const parseOmnaiUIEvent = parseSweechUIEvent

export function parseSweechUiMessage(raw: string): ParsedSweechUiMessage {
  let payload: SweechUIEvent | SweechUIEventEnvelope;
  try {
    payload = JSON.parse(raw) as SweechUIEvent | SweechUIEventEnvelope;
  } catch {
    return {
      event: makeUnsupportedUiEvent({
        reason: 'malformed_json',
        raw,
        streamKind: STREAM_KIND_UI,
        version: STREAM_PROTOCOL_VERSION,
      }),
    }
  }

  if (isSweechUiStreamEnvelope(payload)) {
    return {
      event: payload.event,
      envelope: {
        streamId: payload.streamId,
        ...(payload.requestId ? { requestId: payload.requestId } : {}),
        ...(payload.sequence !== undefined ? { sequence: payload.sequence } : {}),
        ...(payload.traceId ? { traceId: payload.traceId } : {}),
        ...(payload.severity ? { severity: payload.severity } : {}),
        ...(payload.componentId ? { componentId: payload.componentId } : {}),
        ...(payload.correlationId ? { correlationId: payload.correlationId } : {}),
      },
    }
  }

  if (isRecord(payload) && 'kind' in payload) {
    const payloadRecord = payload as Record<string, unknown>;
    return {
      event: makeUnsupportedUiEvent({
        reason: 'unsupported_envelope',
        raw,
        streamKind: String(payloadRecord.kind),
        version: typeof payloadRecord.version === 'number'
          ? payloadRecord.version
          : STREAM_PROTOCOL_VERSION,
      }),
    }
  }

  return { event: isSweechUiEvent(payload) ? payload : null }
}
/** @deprecated Use parseSweechUiMessage */
export const parseOmnaiUIMessage = parseSweechUiMessage

function makeUnsupportedUiEvent(input: Pick<SweechUnsupportedStreamEvent, 'reason' | 'raw' | 'streamKind' | 'version'>): SweechUIEvent {
  return makeSweechUnsupportedStreamEvent(input)
}

function getToolHint(input: Record<string, unknown>): string {
  return String(
    input['file_path'] ?? input['command'] ?? input['path'] ??
    input['url'] ?? input['pattern'] ?? input['query'] ?? ''
  )
}

// ── ANSI / terminal noise ─────────────────────────────────────────────────────

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, '')
}

function isNoiseLine(raw: string): boolean {
  const s = stripAnsi(raw).trim()
  if (!s || s.length <= 2) return true
  if (/^\[[\w-]+\]/.test(s)) return true
  if (/^(Planning with|Conversation\d*\s*$)/.test(s)) return true
  if (/^\s*[|\-\\\/]\s*$/.test(s)) return true
  if (/^[◆◇●○◉◎•└│]\s*/.test(s)) return true
  if (/^[.◎○◉oO]+$/.test(s)) return true
  if (/^☁\s+cloudy\s+scope\s+/.test(s)) return true
  return false
}

export function filterTextBlock(raw: string): string {
  return raw
    .split('\n')
    .filter(l => !isNoiseLine(l))
    .map(l => stripAnsi(l).trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Convert a normalized sweech AgentEvent into Message(s) for the UI.
 * taskId is optional — pass it for multi-task orchestrator contexts.
 */
export function agentEventToMessages(taskId: string | undefined, event: AgentEvent): Message[] {
  switch (event.type) {
    case 'text': {
      const clean = filterTextBlock(event.content)
      if (!clean) return []
      return [{ id: nextId(), type: 'text', taskId, content: clean, timestamp: Date.now() }]
    }
    case 'tool_use': {
      const input = (event.input as Record<string, unknown>) ?? {}
      return [{
        id: nextId(),
        type: 'tool_call',
        taskId,
        content: JSON.stringify(input, null, 2),
        toolName: event.name,
        toolHint: getToolHint(input),
        collapsed: true,
        timestamp: Date.now(),
      }]
    }
    case 'tool_result':
      return [{
        id: nextId(),
        type: 'tool_result',
        taskId,
        toolName: event.name,
        content: event.content.slice(0, 2000),
        isError: event.isError,
        collapsed: true,
        timestamp: Date.now(),
      }]
    case 'result':
      if (!event.output?.trim()) return []
      return [{
        id: nextId(),
        type: 'success',
        taskId,
        content: event.output,
        timestamp: Date.now(),
      }]
    case 'error':
      return [{ id: nextId(), type: 'error', taskId, content: event.message, timestamp: Date.now() }]
    case 'hook_error':
      return [{ id: nextId(), type: 'event', taskId, content: `Hook ${event.hookEvent} failed: ${event.message}`, timestamp: Date.now() }]
    default:
      return []
  }
}

// ── Legacy WS path: parse raw claude-code JSON text lines ────────────────────
// Used when an orchestrator (cloudy/keel) sends task_output events over WS
// containing raw claude stream text rather than normalized AgentEvents.

interface RawClaudeBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  name?: string
  input?: Record<string, unknown>
  content?: string | unknown[]
}
interface RawClaudeMsg {
  type: 'system' | 'assistant' | 'tool_result' | 'result'
  message?: { content?: RawClaudeBlock[] }
  content?: RawClaudeBlock[] | string | unknown[]
  result?: string
  is_error?: boolean
}

export function parseStreamLine(taskId: string | undefined, text: string): Message[] {
  const messages: Message[] = []
  const trimmed = text.trim()
  if (!trimmed) return messages

  let ev: RawClaudeMsg | null = null
  try {
    ev = JSON.parse(trimmed) as RawClaudeMsg
  } catch {
    const clean = filterTextBlock(text)
    if (!clean) return messages
    messages.push({ id: nextId(), type: 'event', content: clean })
    return messages
  }

  if (!ev || ev.type === 'system') return messages

  if (ev.type === 'assistant') {
    const content = ev.message?.content ?? (ev.content as RawClaudeBlock[] | undefined) ?? []
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) {
        const clean = filterTextBlock(block.text)
        if (!clean) continue
        messages.push({ id: nextId(), type: 'text', taskId, content: clean, timestamp: Date.now() })
      } else if (block.type === 'tool_use') {
        const input = block.input ?? {}
        messages.push({
          id: nextId(), type: 'tool_call', taskId,
          content: JSON.stringify(input, null, 2),
          toolName: block.name ?? '',
          toolHint: getToolHint(input),
          collapsed: true, timestamp: Date.now(),
        })
      }
    }
    return messages
  }

  if (ev.type === 'tool_result') {
    const raw = ev.content
    const resultText = typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map(b => (typeof b === 'object' && b !== null && 'text' in b ? (b as { text: string }).text : '')).join('')
        : ''
    const clean = stripAnsi(resultText).trim()
    if (clean) messages.push({ id: nextId(), type: 'tool_result', taskId, content: clean.slice(0, 2000), collapsed: true, timestamp: Date.now() })
    return messages
  }

  if (ev.type === 'result' && ev.result?.trim()) {
    messages.push({ id: nextId(), type: ev.is_error ? 'error' : 'success', taskId, content: ev.result, timestamp: Date.now() })
  }

  return messages
}

export function makeMessage(
  content: string,
  type: MessageType = 'event',
  taskId?: string,
  options: Pick<Message, 'pinned'> = {},
): Message {
  return {
    id: nextId(),
    type,
    taskId,
    content,
    timestamp: Date.now(),
    ...(options.pinned ? { pinned: true } : {}),
  }
}
