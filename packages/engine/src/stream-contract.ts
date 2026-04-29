import type { AgentEvent } from './types.js';

export const STREAM_PROTOCOL = 'omnai.stream' as const;
export const STREAM_PROTOCOL_VERSION = 1 as const;
export const STREAM_KIND_DAEMON = 'agent_event' as const;
export const STREAM_KIND_UI = 'ui_event' as const;
export const STREAM_KIND_UNSUPPORTED = 'unsupported_event' as const;

export type OmnaiStreamProtocol = typeof STREAM_PROTOCOL;
export type OmnaiStreamVersion = typeof STREAM_PROTOCOL_VERSION;
export type OmnaiEnvelopeKind = typeof STREAM_KIND_DAEMON | typeof STREAM_KIND_UI;
export type OmnaiStreamKind = OmnaiEnvelopeKind | typeof STREAM_KIND_UNSUPPORTED;
export type OmnaiStreamSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface OmnaiStreamEnvelope<TEvent extends { type: string }, TKind extends OmnaiEnvelopeKind = OmnaiEnvelopeKind> {
  schema: OmnaiStreamProtocol;
  version: OmnaiStreamVersion;
  kind: TKind;
  streamId: string;
  requestId?: string;
  sequence?: number;
  traceId?: string;
  severity?: OmnaiStreamSeverity;
  componentId?: string;
  correlationId?: string;
  ts: string;
  event: TEvent;
}

export type OmnaiDaemonStreamEnvelope = OmnaiStreamEnvelope<AgentEvent, typeof STREAM_KIND_DAEMON> & {
  requestId: string;
  sequence: number;
  traceId: string;
  severity: OmnaiStreamSeverity;
  componentId: string;
  correlationId: string;
};

export type ApprovalStage = 'pre_task' | 'failure_escalation';
export type ApprovalAction = 'approved' | 'skipped' | 'halt' | 'retry_with_hint';

export interface QuestionOption {
  value: string;
  label: string;
}

export interface OmnaiUnsupportedStreamEvent {
  type: typeof STREAM_KIND_UNSUPPORTED;
  kind: typeof STREAM_KIND_UNSUPPORTED;
  streamKind: string;
  version: number;
  reason: string;
  raw: string;
  taskId?: string;
}

export type OmnaiUiEvent =
  | { type: 'session_started'; sessionId?: string }
  | { type: 'task_started'; taskId: string; title: string; attempt: number; maxAttempts: number }
  | { type: 'task_output'; taskId: string; text: string }
  | { type: 'task_thinking'; taskId: string; text: string }
  | { type: 'task_tool_call'; taskId: string; toolName: string; toolInput: unknown }
  | { type: 'task_tool_result'; taskId: string; toolName: string; content: string; isError: boolean }
  | { type: 'task_completed'; taskId: string; title: string; durationMs: number; resultSummary?: string }
  | { type: 'task_failed'; taskId: string; title: string; error: string; willRetry: boolean }
  | { type: 'approval_requested'; taskId: string; title: string; stage: ApprovalStage; context?: string; timeoutSec: number }
  | { type: 'approval_resolved'; taskId: string; action: ApprovalAction; autoTriggered: boolean }
  | { type: 'question_asked'; id: string; question: string; options?: QuestionOption[] }
  | { type: 'question_answered'; id: string; answer: string }
  | { type: 'cost_update'; totalUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; byModel: Record<string, number> }
  | { type: 'progress'; taskId?: string; current: number; total: number; label?: string }
  | { type: 'session_completed'; durationMs: number; totalUsd?: number }
  | { type: 'session_failed'; error: string }
  | { type: 'connection_lost' }
  | { type: 'connection_restored' }
  | OmnaiUnsupportedStreamEvent;

export type OmnaiUiStreamEnvelope = OmnaiStreamEnvelope<OmnaiUiEvent, typeof STREAM_KIND_UI>;

export interface OmnaiStreamErrorEvent {
  type: 'stream_error';
  kind: OmnaiStreamKind;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isStreamSeverity(value: unknown): value is OmnaiStreamSeverity {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function isQuestionOptions(value: unknown): value is QuestionOption[] {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((option) => (
    isRecord(option)
    && typeof option.value === 'string'
    && typeof option.label === 'string'
  ));
}

export function makeOmnaiUnsupportedStreamEvent(
  input: Pick<OmnaiUnsupportedStreamEvent, 'reason' | 'raw' | 'streamKind' | 'version' | 'taskId'>,
): OmnaiUnsupportedStreamEvent {
  return {
    type: STREAM_KIND_UNSUPPORTED,
    kind: STREAM_KIND_UNSUPPORTED,
    streamKind: input.streamKind,
    version: input.version,
    reason: input.reason,
    raw: input.raw,
    ...(input.taskId ? { taskId: input.taskId } : {}),
  };
}

export function getOmnaiStreamSeverity(event: { type: string }): OmnaiStreamSeverity {
  switch (event.type) {
    case 'error':
    case 'session_failed':
    case 'task_failed':
      return 'error';
    case 'connection_lost':
    case STREAM_KIND_UNSUPPORTED:
      return 'warn';
    default:
      return 'info';
  }
}

export function isOmnaiUnsupportedStreamEvent(value: unknown): value is OmnaiUnsupportedStreamEvent {
  return isRecord(value)
    && value.type === STREAM_KIND_UNSUPPORTED
    && value.kind === STREAM_KIND_UNSUPPORTED
    && typeof value.streamKind === 'string'
    && isFiniteNumber(value.version)
    && typeof value.reason === 'string'
    && typeof value.raw === 'string'
    && isOptionalString(value.taskId);
}

export function isOmnaiUiEvent(value: unknown): value is OmnaiUiEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'session_started':
      return isOptionalString(value.sessionId);
    case 'task_started':
      return typeof value.taskId === 'string'
        && typeof value.title === 'string'
        && isFiniteNumber(value.attempt)
        && isFiniteNumber(value.maxAttempts);
    case 'task_output':
    case 'task_thinking':
      return typeof value.taskId === 'string' && typeof value.text === 'string';
    case 'task_tool_call':
      return typeof value.taskId === 'string' && typeof value.toolName === 'string' && 'toolInput' in value;
    case 'task_tool_result':
      return typeof value.taskId === 'string'
        && typeof value.toolName === 'string'
        && typeof value.content === 'string'
        && typeof value.isError === 'boolean';
    case 'task_completed':
      return typeof value.taskId === 'string'
        && typeof value.title === 'string'
        && isFiniteNumber(value.durationMs)
        && isOptionalString(value.resultSummary);
    case 'task_failed':
      return typeof value.taskId === 'string'
        && typeof value.title === 'string'
        && typeof value.error === 'string'
        && typeof value.willRetry === 'boolean';
    case 'approval_requested':
      return typeof value.taskId === 'string'
        && typeof value.title === 'string'
        && (value.stage === 'pre_task' || value.stage === 'failure_escalation')
        && isOptionalString(value.context)
        && isFiniteNumber(value.timeoutSec);
    case 'approval_resolved':
      return typeof value.taskId === 'string'
        && (value.action === 'approved' || value.action === 'skipped' || value.action === 'halt' || value.action === 'retry_with_hint')
        && typeof value.autoTriggered === 'boolean';
    case 'question_asked':
      return typeof value.id === 'string'
        && typeof value.question === 'string'
        && isQuestionOptions(value.options);
    case 'question_answered':
      return typeof value.id === 'string' && typeof value.answer === 'string';
    case 'cost_update':
      return isFiniteNumber(value.totalUsd)
        && isFiniteNumber(value.inputTokens)
        && isFiniteNumber(value.outputTokens)
        && isFiniteNumber(value.cacheReadTokens)
        && isRecord(value.byModel)
        && Object.values(value.byModel).every(isFiniteNumber);
    case 'progress':
      return isOptionalString(value.taskId)
        && isFiniteNumber(value.current)
        && isFiniteNumber(value.total)
        && isOptionalString(value.label);
    case 'session_completed':
      return isFiniteNumber(value.durationMs) && isOptionalFiniteNumber(value.totalUsd);
    case 'session_failed':
      return typeof value.error === 'string';
    case 'connection_lost':
    case 'connection_restored':
      return true;
    case STREAM_KIND_UNSUPPORTED:
      return isOmnaiUnsupportedStreamEvent(value);
    default:
      return false;
  }
}

export function isOmnaiDaemonStreamEnvelope(value: unknown): value is OmnaiDaemonStreamEnvelope {
  return isRecord(value)
    && value.schema === STREAM_PROTOCOL
    && value.version === STREAM_PROTOCOL_VERSION
    && value.kind === STREAM_KIND_DAEMON
    && typeof value.streamId === 'string'
    && typeof value.requestId === 'string'
    && isFiniteNumber(value.sequence)
    && typeof value.traceId === 'string'
    && isStreamSeverity(value.severity)
    && typeof value.componentId === 'string'
    && typeof value.correlationId === 'string'
    && typeof value.ts === 'string'
    && isRecord(value.event)
    && typeof value.event.type === 'string';
}

export function isOmnaiUiStreamEnvelope(value: unknown): value is OmnaiUiStreamEnvelope {
  return isRecord(value)
    && value.schema === STREAM_PROTOCOL
    && value.version === STREAM_PROTOCOL_VERSION
    && value.kind === STREAM_KIND_UI
    && typeof value.streamId === 'string'
    && isOptionalString(value.requestId)
    && isOptionalFiniteNumber(value.sequence)
    && isOptionalString(value.traceId)
    && (value.severity === undefined || isStreamSeverity(value.severity))
    && isOptionalString(value.componentId)
    && isOptionalString(value.correlationId)
    && typeof value.ts === 'string'
    && isOmnaiUiEvent(value.event);
}
