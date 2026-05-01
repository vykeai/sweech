// Direct ModelRunner hook — no WebSocket needed.
// Pass a sweech ModelRunner + prompt and get live session state.

import { useReducer, useCallback, useEffect, useRef } from 'react'
import type { ModelRunner, RunOptions } from '@sweech/engine'
import type { Message, SessionRetentionPolicy, SessionState } from '../types/index.js'
import { agentEventToMessages } from '../utils/parse.js'
import { clearSessionArchive, persistSessionArchiveSnapshots, rehydrateSessionArchive } from '../session/retention.js'
import {
  initialSweechSessionStateInternal,
  reduceSweechSessionState,
  toPublicSessionState,
} from '../session/state.js'

export interface UseSweechSessionOptions {
  runner: ModelRunner
  runOptions?: Omit<RunOptions, 'abortSignal'>
  retention?: SessionRetentionPolicy
}
/** @deprecated Use UseSweechSessionOptions */
export type UseOmnaiSessionOptions = UseSweechSessionOptions

export interface UseSweechSessionReturn {
  session: SessionState
  run: (prompt: string) => Promise<void>
  stop: () => void
  clear: () => void
  rehydrateArchive: () => Promise<Message[]>
}
/** @deprecated Use UseSweechSessionReturn */
export type UseOmnaiSessionReturn = UseSweechSessionReturn

export function useSweechSession({ runner, runOptions = {}, retention }: UseSweechSessionOptions): UseSweechSessionReturn {
  const [state, dispatch] = useReducer(reduceSweechSessionState, initialSweechSessionStateInternal)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (state.pendingArchive.length === 0) return

    const snapshots = state.pendingArchive
    let cancelled = false

    void persistSessionArchiveSnapshots(retention, snapshots).finally(() => {
      if (!cancelled) {
        dispatch({ type: 'ARCHIVE_FLUSHED', count: snapshots.length })
      }
    })

    return () => {
      cancelled = true
    }
  }, [retention, state.pendingArchive])

  const run = useCallback(async (prompt: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    dispatch({ type: 'STARTED' })

    try {
      for await (const event of runner.run(prompt, { ...runOptions, abortSignal: ac.signal })) {
        if (ac.signal.aborted) break

        if (event.type === 'result') {
          dispatch({
            type: 'COST',
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            costUsd: event.costUsd,
          })
        }

        const msgs = agentEventToMessages(undefined, event)
        if (msgs.length > 0) {
          dispatch({ type: 'MESSAGES', messages: msgs, retention })
        }
      }
      dispatch({ type: 'COMPLETED' })
    } catch (err) {
      if (!ac.signal.aborted) {
        dispatch({ type: 'FAILED', error: (err as Error).message })
      }
    }
  }, [retention, runOptions, runner])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    dispatch({ type: 'COMPLETED' })
  }, [])

  const clear = useCallback(() => {
    dispatch({ type: 'CLEAR' })
    void clearSessionArchive(retention)
  }, [retention])

  const rehydrateArchive = useCallback(async () => {
    const archivedMessages = await rehydrateSessionArchive(retention)
    if (archivedMessages.length > 0) {
      dispatch({ type: 'REHYDRATED', messages: archivedMessages, retention })
    }
    return archivedMessages
  }, [retention])

  return {
    session: toPublicSessionState(state),
    run,
    stop,
    clear,
    rehydrateArchive,
  }
}
