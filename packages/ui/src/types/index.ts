// Re-export core engine types so consumers only need @sweech/ui
export type { AgentEvent, ModelRunner, AgentRunner, RunOptions, TokenUsage, Provider, EngineId } from '@sweech/engine'
import {
  STREAM_PROTOCOL,
  STREAM_PROTOCOL_VERSION,
  STREAM_KIND_UI,
} from '@sweech/engine'
import type {
  ApprovalAction,
  ApprovalStage,
  SweechUiEvent,
  SweechUiStreamEnvelope,
  SweechSessionArchiveMessage,
  SweechSessionArchiveMessageType,
  SweechSessionArchiveSnapshot,
  SweechUnsupportedStreamEvent,
  QuestionOption,
} from '@sweech/engine'
import type { SweechTheme } from '../themes/theme.js'

export {
  STREAM_PROTOCOL,
  STREAM_PROTOCOL_VERSION,
  STREAM_KIND_UI,
} from '@sweech/engine'
export type {
  ApprovalAction,
  ApprovalStage,
  SweechUiEvent,
  SweechUiStreamEnvelope,
  SweechSessionArchiveMessage,
  SweechSessionArchiveMessageType,
  SweechSessionArchiveSnapshot,
  SweechUnsupportedStreamEvent,
  QuestionOption,
} from '@sweech/engine'

// ── Execution events (orchestrator → UI) ─────────────────────────────────────

export type SweechUIEvent = SweechUiEvent

export type SweechUIEventEnvelope = SweechUiStreamEnvelope

// ── Commands (UI → orchestrator) ─────────────────────────────────────────────

export type SweechUICommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'approval_response'; taskId: string; action: ApprovalAction; hint?: string }
  | { type: 'question_response'; id: string; answer: string }
  | { type: 'user_message'; text: string }

// ── Approval ─────────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  taskId: string
  title: string
  stage: ApprovalStage
  context?: string
  timeoutSec: number
}

// ── Question ─────────────────────────────────────────────────────────────────

export interface QuestionRequest {
  id: string
  question: string
  options?: QuestionOption[]
}

// ── Normalized message line (internal render model) ───────────────────────────

export type MessageType = SweechSessionArchiveMessageType

export interface Message extends SweechSessionArchiveMessage {}

// ── Cost summary ─────────────────────────────────────────────────────────────

export interface CostSummary {
  totalUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  byModel: Record<string, number>
}

// ── Session state ─────────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed'

export interface SessionState {
  status: SessionStatus
  messages: Message[]
  approval: ApprovalRequest | null
  question: QuestionRequest | null
  cost: CostSummary | null
  startedAt: number | null
  error: string | null
  connected: boolean
}

export type SessionArchiveSnapshot = SweechSessionArchiveSnapshot<Message>

export interface SessionArchiveStore {
  save: (snapshots: SessionArchiveSnapshot[]) => void | Promise<void>
  load?: () => SessionArchiveSnapshot[] | Promise<SessionArchiveSnapshot[]>
  clear?: () => void | Promise<void>
}

export interface SessionRetentionPolicy {
  maxMessages?: number
  maxToolInvocations?: number
  maxContextSnapshots?: number
  preservePinnedMessages?: boolean
  archiveStore?: SessionArchiveStore
}

// ── Backward-compatible aliases (deprecated — use Sweech* names) ──────────────

/** @deprecated Use SweechUIEvent */
export type OmnaiUIEvent = SweechUIEvent
/** @deprecated Use SweechUIEventEnvelope */
export type OmnaiUIEventEnvelope = SweechUIEventEnvelope
/** @deprecated Use SweechUICommand */
export type OmnaiUICommand = SweechUICommand
/** @deprecated Use SweechUiEvent from @sweech/engine */
export type OmnaiUiEvent = SweechUiEvent
/** @deprecated Use SweechUiStreamEnvelope from @sweech/engine */
export type OmnaiUiStreamEnvelope = SweechUiStreamEnvelope
/** @deprecated Use SweechSessionArchiveMessage from @sweech/engine */
export type OmnaiSessionArchiveMessage = SweechSessionArchiveMessage
/** @deprecated Use SweechSessionArchiveMessageType from @sweech/engine */
export type OmnaiSessionArchiveMessageType = SweechSessionArchiveMessageType
/** @deprecated Use SweechSessionArchiveSnapshot from @sweech/engine */
export type OmnaiSessionArchiveSnapshot = SweechSessionArchiveSnapshot
/** @deprecated Use SweechUnsupportedStreamEvent from @sweech/engine */
export type OmnaiUnsupportedStreamEvent = SweechUnsupportedStreamEvent
/** @deprecated Use SweechTheme */
export type OmnaiTheme = SweechTheme
