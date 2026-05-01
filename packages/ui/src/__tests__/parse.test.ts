import { describe, expect, it } from 'vitest'
import type { SweechUIEventEnvelope } from '../types/index.js'
import { parseSweechUIEvent, parseSweechUiMessage } from '../utils/parse.js'

describe('parseSweechUIEvent', () => {
  it('parses canonical ui envelopes', () => {
    const envelope: SweechUIEventEnvelope = {
      schema: 'sweech.stream',
      version: 1,
      kind: 'ui_event',
      streamId: 'stream-1',
      ts: '2026-01-01T00:00:00.000Z',
      event: {
        type: 'task_started',
        taskId: 'task-1',
        title: 'Review',
        attempt: 1,
        maxAttempts: 1,
      },
    }

    expect(parseSweechUIEvent(JSON.stringify(envelope))).toEqual(envelope.event)
  })

  it('normalizes malformed envelopes to unsupported_event', () => {
    const parsed = parseSweechUIEvent(JSON.stringify({
      schema: 'sweech.stream',
      version: 1,
      kind: 'ui_event',
      streamId: 'stream-1',
      ts: '2026-01-01T00:00:00.000Z',
      event: {
        type: 'legacy_event',
      },
    }))

    expect(parsed).toMatchObject({
      type: 'unsupported_event',
      kind: 'unsupported_event',
      streamKind: 'ui_event',
      reason: 'unsupported_envelope',
    })
  })

  it('normalizes malformed json to unsupported_event', () => {
    expect(parseSweechUIEvent('{not-json')).toMatchObject({
      type: 'unsupported_event',
      kind: 'unsupported_event',
      reason: 'malformed_json',
    })
  })

  it('extracts envelope metadata for replay-safe clients', () => {
    const parsed = parseSweechUiMessage(JSON.stringify({
      schema: 'sweech.stream',
      version: 1,
      kind: 'ui_event',
      streamId: 'stream-2',
      requestId: 'request-2',
      sequence: 7,
      traceId: 'trace-2',
      severity: 'warn',
      componentId: 'ui.bridge.sse',
      correlationId: 'corr-2',
      ts: '2026-01-01T00:00:00.000Z',
      event: { type: 'connection_lost' },
    }))

    expect(parsed.event).toEqual({ type: 'connection_lost' })
    expect(parsed.envelope).toEqual({
      streamId: 'stream-2',
      requestId: 'request-2',
      sequence: 7,
      traceId: 'trace-2',
      severity: 'warn',
      componentId: 'ui.bridge.sse',
      correlationId: 'corr-2',
    })
  })
})
