import type { SweechUIEvent, SessionState, ApprovalRequest, QuestionRequest } from '../types/index.js'
import { parseStreamLine, makeMessage } from '../utils/parse.js'

export type WebSessionAction =
  | { type: 'EVENT'; event: SweechUIEvent }
  | { type: 'CLEAR' }
  | { type: 'CONNECTED'; connected: boolean }

export const initialWebSessionState: SessionState = {
  status: 'idle',
  messages: [],
  approval: null,
  question: null,
  cost: null,
  startedAt: null,
  error: null,
  connected: false,
}

export function reduceWebSessionState(state: SessionState, action: WebSessionAction): SessionState {
  if (action.type === 'CONNECTED') return { ...state, connected: action.connected }
  if (action.type === 'CLEAR') return { ...initialWebSessionState }

  const ev = action.event

  switch (ev.type) {
    case 'session_started':
      return { ...state, status: 'running', startedAt: Date.now(), error: null }
    case 'task_started':
      return {
        ...state,
        status: 'running',
        startedAt: state.startedAt ?? Date.now(),
        messages: [...state.messages, makeMessage(`Task started: ${ev.title}`, 'event', ev.taskId)],
      }
    case 'task_output':
      return { ...state, messages: [...state.messages, ...parseStreamLine(ev.taskId, ev.text)] }
    case 'task_tool_call':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `msg-${Date.now()}`,
            type: 'tool_call' as const,
            taskId: ev.taskId,
            toolName: ev.toolName,
            content: JSON.stringify(ev.toolInput, null, 2),
            collapsed: true,
            timestamp: Date.now(),
          },
        ],
      }
    case 'task_tool_result':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `msg-${Date.now()}`,
            type: 'tool_result' as const,
            taskId: ev.taskId,
            toolName: ev.toolName,
            content: ev.content.slice(0, 2000),
            isError: ev.isError,
            collapsed: true,
            timestamp: Date.now(),
          },
        ],
      }
    case 'task_completed':
      return {
        ...state,
        messages: [
          ...state.messages,
          makeMessage(ev.resultSummary ?? `✓ ${ev.title} completed in ${(ev.durationMs / 1000).toFixed(1)}s`, 'success', ev.taskId),
        ],
      }
    case 'task_failed':
      return {
        ...state,
        messages: [
          ...state.messages,
          makeMessage(`✗ ${ev.title}: ${ev.error}${ev.willRetry ? ' (retrying…)' : ''}`, 'error', ev.taskId),
        ],
      }
    case 'approval_requested': {
      const req: ApprovalRequest = {
        taskId: ev.taskId,
        title: ev.title,
        stage: ev.stage,
        context: ev.context,
        timeoutSec: ev.timeoutSec,
      }
      return { ...state, approval: req }
    }
    case 'approval_resolved':
      return { ...state, approval: null }
    case 'question_asked': {
      const req: QuestionRequest = { id: ev.id, question: ev.question, options: ev.options }
      return { ...state, question: req }
    }
    case 'question_answered':
      return { ...state, question: null }
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
    case 'session_completed':
      return { ...state, status: 'completed' }
    case 'session_failed':
      return { ...state, status: 'failed', error: ev.error }
    case 'connection_lost':
      return { ...state, connected: false }
    case 'connection_restored':
      return { ...state, connected: true }
    default:
      return state
  }
}
