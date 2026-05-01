/**
 * useAgentStream — browser-side SSE hook for agent sessions.
 *
 * Connects to an SSE endpoint that streams SweechUIEvents and returns
 * the same SessionState shape as useSweechSession.
 *
 * Use this instead of useSweechSession when your backend uses handleAgentSse.
 *
 * @example
 * const { session, start, stop } = useAgentStream('/api/agent/stream')
 *
 * // Trigger via POST, then connect SSE:
 * await start({ project: 'fitkind' })
 */

import { useReducer, useCallback, useRef } from 'react'
import type { SweechUIEvent, SessionState } from '../types/index.js'
import { parseStreamLine, makeMessage, parseSweechUIEvent } from '../utils/parse.js'

type Action =
  | { type: 'EVENT'; event: SweechUIEvent }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED'; error?: string }
  | { type: 'CLEAR' }

const initial: SessionState = {
  status: 'idle',
  messages: [],
  approval: null,
  question: null,
  cost: null,
  startedAt: null,
  error: null,
  connected: false,
}

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'CONNECTED':
      return { ...state, connected: true }
    case 'DISCONNECTED':
      return { ...state, connected: false, status: state.status === 'running' ? 'failed' : state.status, error: action.error ?? state.error }
    case 'CLEAR':
      return { ...initial }
    case 'EVENT': {
      const ev = action.event
      switch (ev.type) {
        case 'session_started':
          return { ...state, status: 'running', startedAt: Date.now(), error: null }
        case 'task_started':
          return { ...state, messages: [...state.messages, makeMessage(`${ev.title}`, 'event', ev.taskId)] }
        case 'task_output':
          return { ...state, messages: [...state.messages, ...parseStreamLine(ev.taskId, ev.text)] }
        case 'task_thinking':
          return {
            ...state,
            messages: [...state.messages, {
              id: `thinking-${Date.now()}-${Math.random()}`,
              type: 'thinking' as const,
              taskId: ev.taskId,
              content: ev.text,
              collapsed: true,
              timestamp: Date.now(),
            }],
          }
        case 'task_tool_call':
          return {
            ...state,
            messages: [...state.messages, {
              id: `msg-${Date.now()}-${Math.random()}`,
              type: 'tool_call' as const,
              taskId: ev.taskId,
              toolName: ev.toolName,
              content: JSON.stringify(ev.toolInput, null, 2),
              collapsed: true,
              timestamp: Date.now(),
            }],
          }
        case 'task_tool_result':
          return {
            ...state,
            messages: [...state.messages, {
              id: `msg-${Date.now()}-${Math.random()}`,
              type: 'tool_result' as const,
              taskId: ev.taskId,
              toolName: ev.toolName,
              content: ev.content.slice(0, 2000),
              isError: ev.isError,
              collapsed: true,
              timestamp: Date.now(),
            }],
          }
        case 'task_completed':
          return { ...state, messages: [...state.messages, makeMessage(`✓ ${ev.resultSummary ?? ev.title}`, 'success', ev.taskId)] }
        case 'task_failed':
          return { ...state, messages: [...state.messages, makeMessage(`✗ ${ev.title}: ${ev.error}`, 'error', ev.taskId)] }
        case 'unsupported_event':
          return {
            ...state,
            messages: [...state.messages, makeMessage(`⚠ Unsupported stream event (${ev.streamKind}): ${ev.reason}`, 'event', ev.taskId)],
          }
        case 'cost_update':
          return {
            ...state,
            cost: {
              totalUsd: ev.totalUsd,
              inputTokens: ev.inputTokens,
              outputTokens: ev.outputTokens,
              cacheReadTokens: ev.cacheReadTokens,
              byModel: ev.byModel,
            },
          }
        case 'approval_requested':
          return {
            ...state,
            approval: { taskId: ev.taskId, title: ev.title, stage: ev.stage, context: ev.context, timeoutSec: ev.timeoutSec },
          }
        case 'approval_resolved':
          return { ...state, approval: null }
        case 'question_asked':
          return { ...state, question: { id: ev.id, question: ev.question, options: ev.options } }
        case 'question_answered':
          return { ...state, question: null }
        case 'connection_lost':
          return { ...state, connected: false }
        case 'connection_restored':
          return { ...state, connected: true }
        case 'session_completed':
          return { ...state, status: 'completed', connected: false }
        case 'session_failed':
          return { ...state, status: 'failed', error: ev.error, connected: false }
        default:
          return state
      }
    }
    default:
      return state
  }
}

export interface UseAgentStreamOptions {
  /** Called with the body to POST to start an agent session. Return the SSE URL to connect to. */
  onStart?: (params: Record<string, unknown>) => Promise<string>
}

export interface UseAgentStreamReturn {
  session: SessionState
  /** Start a session. If sseUrl is provided directly, connect to it. Otherwise calls onStart. */
  start: (params?: Record<string, unknown>) => Promise<void>
  stop: () => void
  clear: () => void
}

export function useAgentStream(
  sseUrl: string,
  options: UseAgentStreamOptions = {},
): UseAgentStreamReturn {
  const [state, dispatch] = useReducer(reducer, initial)
  const esRef = useRef<EventSource | null>(null)

  const stop = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
    dispatch({ type: 'DISCONNECTED' })
  }, [])

  const clear = useCallback(() => {
    stop()
    dispatch({ type: 'CLEAR' })
  }, [stop])

  const start = useCallback(async (params: Record<string, unknown> = {}) => {
    stop()
    dispatch({ type: 'CLEAR' })

    let url = sseUrl
    if (options.onStart) {
      url = await options.onStart(params)
    } else if (Object.keys(params).length > 0) {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      url = `${sseUrl}?${qs}`
    }

    const es = new EventSource(url)
    esRef.current = es

    dispatch({ type: 'CONNECTED' })

    es.onmessage = (e) => {
      const event = parseSweechUIEvent(e.data)
      if (!event) return

      dispatch({ type: 'EVENT', event })
      if (event.type === 'session_completed' || event.type === 'session_failed') {
        es.close()
        esRef.current = null
      }
    }

    es.onerror = () => {
      dispatch({ type: 'DISCONNECTED', error: 'Connection lost' })
      es.close()
      esRef.current = null
    }
  }, [sseUrl, stop, options])

  return { session: state, start, stop, clear }
}
