import { describe, expect, it } from 'vitest'
import { getEnvelopeReplayKey, isTerminalSessionEvent, registerReplayKey } from '../../hooks/transport-state.js'
import { parseSweechUiMessage } from '../../utils/parse.js'

function makeEnvelope(sequence: number, event: Record<string, unknown>) {
  return JSON.stringify({
    schema: 'sweech.stream',
    version: 1,
    kind: 'ui_event',
    streamId: 'stream-regression',
    requestId: 'request-regression',
    traceId: 'trace-regression',
    sequence,
    severity: 'info',
    componentId: 'ui.bridge.sse',
    correlationId: 'corr-regression',
    ts: `2026-01-01T00:00:0${sequence}.000Z`,
    event,
  })
}

describe('transport regression flow', () => {
  it('keeps reconnect recovery deterministic and suppresses replayed frames', () => {
    const rawFrames = [
      makeEnvelope(1, { type: 'task_output', taskId: 'task-1', text: 'hello' }),
      makeEnvelope(2, { type: 'connection_lost' }),
      makeEnvelope(3, { type: 'connection_restored' }),
      makeEnvelope(1, { type: 'task_output', taskId: 'task-1', text: 'hello' }),
      makeEnvelope(4, { type: 'session_completed', durationMs: 5 }),
    ]

    let replayKeys: string[] = []
    const trace: string[] = []

    for (const raw of rawFrames) {
      const parsed = parseSweechUiMessage(raw)
      if (!parsed.event) continue

      const replayKey = getEnvelopeReplayKey(parsed.envelope)
      if (replayKey) {
        const registration = registerReplayKey(replayKeys, replayKey, 8)
        replayKeys = registration.next
        if (registration.duplicate) continue
      }

      trace.push(parsed.event.type)
    }

    expect(trace, JSON.stringify(trace, null, 2)).toEqual([
      'task_output',
      'connection_lost',
      'connection_restored',
      'session_completed',
    ])
    expect(isTerminalSessionEvent({ type: 'session_completed', durationMs: 5 })).toBe(true)
  })
})
