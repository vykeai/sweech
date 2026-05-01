import type {
  Message,
  SessionArchiveSnapshot,
  SessionRetentionPolicy,
  SessionState,
} from '../types/index.js'
import { retainSessionMessages } from './retention.js'

export interface SweechSessionStateInternal extends SessionState {
  pendingArchive: SessionArchiveSnapshot[]
}
/** @deprecated Use SweechSessionStateInternal */
export type OmnaiSessionStateInternal = SweechSessionStateInternal

export type SweechSessionStateAction =
  | { type: 'STARTED' }
  | { type: 'MESSAGES'; messages: Message[]; retention?: SessionRetentionPolicy }
  | { type: 'COST'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'COMPLETED' }
  | { type: 'FAILED'; error: string }
  | { type: 'CLEAR' }
  | { type: 'ARCHIVE_FLUSHED'; count: number }
  | { type: 'REHYDRATED'; messages: Message[]; retention?: SessionRetentionPolicy }
/** @deprecated Use SweechSessionStateAction */
export type OmnaiSessionStateAction = SweechSessionStateAction

export const initialSweechSessionStateInternal: SweechSessionStateInternal = {
  status: 'idle',
  messages: [],
  approval: null,
  question: null,
  cost: null,
  startedAt: null,
  error: null,
  connected: true,
  pendingArchive: [],
}
/** @deprecated Use initialSweechSessionStateInternal */
export const initialOmnaiSessionStateInternal = initialSweechSessionStateInternal

function appendMessages(
  state: SweechSessionStateInternal,
  nextMessages: Message[],
  retention?: SessionRetentionPolicy,
): SweechSessionStateInternal {
  if (nextMessages.length === 0) return state

  const retained = retainSessionMessages([...state.messages, ...nextMessages], retention)
  const nextPendingArchive = retained.pruned.length > 0
    ? [
        ...state.pendingArchive,
        {
          schemaVersion: 2 as const,
          createdAt: Date.now(),
          messages: retained.pruned,
        },
      ]
    : state.pendingArchive

  return {
    ...state,
    messages: retained.messages,
    pendingArchive: nextPendingArchive,
  }
}

function prependMessages(
  state: SweechSessionStateInternal,
  archivedMessages: Message[],
  retention?: SessionRetentionPolicy,
): SweechSessionStateInternal {
  if (archivedMessages.length === 0) return state

  const retained = retainSessionMessages([...archivedMessages, ...state.messages], retention)
  const nextPendingArchive = retained.pruned.length > 0
    ? [
        ...state.pendingArchive,
        {
          schemaVersion: 2 as const,
          createdAt: Date.now(),
          messages: retained.pruned,
        },
      ]
    : state.pendingArchive

  return {
    ...state,
    messages: retained.messages,
    pendingArchive: nextPendingArchive,
  }
}

export function reduceSweechSessionState(
  state: SweechSessionStateInternal,
  action: SweechSessionStateAction,
): SweechSessionStateInternal {
  switch (action.type) {
    case 'STARTED':
      return { ...state, status: 'running', startedAt: Date.now(), error: null }
    case 'MESSAGES':
      return appendMessages(state, action.messages, action.retention)
    case 'COST':
      return {
        ...state,
        cost: {
          totalUsd: action.costUsd,
          inputTokens: action.inputTokens,
          outputTokens: action.outputTokens,
          cacheReadTokens: state.cost?.cacheReadTokens ?? 0,
          byModel: state.cost?.byModel ?? {},
        },
      }
    case 'COMPLETED':
      return { ...state, status: 'completed' }
    case 'FAILED':
      return { ...state, status: 'failed', error: action.error }
    case 'CLEAR':
      return { ...initialSweechSessionStateInternal }
    case 'ARCHIVE_FLUSHED':
      if (action.count <= 0) return state
      return {
        ...state,
        pendingArchive: state.pendingArchive.slice(action.count),
      }
    case 'REHYDRATED':
      return prependMessages(state, action.messages, action.retention)
    default:
      return state
  }
}
/** @deprecated Use reduceSweechSessionState */
export const reduceOmnaiSessionState = reduceSweechSessionState

export function toPublicSessionState(state: SweechSessionStateInternal): SessionState {
  const { pendingArchive, ...session } = state
  return session
}
