import { useReducer, useCallback, useRef, useEffect } from 'react'
import type { SweechUIEvent, SweechUICommand, SessionState } from '../types/index.js'
import { parseSweechUiMessage } from '../utils/parse.js'
import { initialWebSessionState, reduceWebSessionState } from './web-session-state.js'
import {
  getEnvelopeReplayKey,
  getReconnectDelayMs,
  isTerminalSessionEvent,
  registerReplayKey,
  resolveReconnectPolicy,
  type WebSessionReconnectInput,
} from './transport-state.js'

export interface UseSweechWebSessionOptions {
  wsUrl?: string
  onCommand?: (cmd: SweechUICommand) => void
  reconnect?: WebSessionReconnectInput
}

export interface UseSweechWebSessionReturn {
  session: SessionState
  send: (cmd: SweechUICommand) => void
  clear: () => void
  dispatch: (event: SweechUIEvent) => void
}

export function useSweechWebSession(options: UseSweechWebSessionOptions = {}): UseSweechWebSessionReturn {
  const [state, dispatch] = useReducer(reduceWebSessionState, initialWebSessionState)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const replayKeysRef = useRef<string[]>([])
  const manuallyClosedRef = useRef(false)
  const terminalEventSeenRef = useRef(false)
  const hasConnectedRef = useRef(false)
  const reconnectPendingRef = useRef(false)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const send = useCallback((cmd: SweechUICommand) => {
    if (optionsRef.current.onCommand) { optionsRef.current.onCommand(cmd); return }
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(cmd))
  }, [])

  const clear = useCallback(() => dispatch({ type: 'CLEAR' }), [])
  const dispatchEvent = useCallback((event: SweechUIEvent) => dispatch({ type: 'EVENT', event }), [])

  useEffect(() => {
    if (options.onCommand) return

    let disposed = false

    function clearReconnectTimer() {
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current)
        reconnectRef.current = null
      }
    }

    function scheduleReconnect() {
      const reconnectPolicy = resolveReconnectPolicy(optionsRef.current.reconnect)
      if (disposed || manuallyClosedRef.current || terminalEventSeenRef.current || !reconnectPolicy.enabled) return
      if (reconnectRef.current) return

      const nextAttempt = reconnectAttemptRef.current + 1
      if (nextAttempt > reconnectPolicy.maxAttempts) return

      reconnectAttemptRef.current = nextAttempt
      reconnectPendingRef.current = true
      const delay = getReconnectDelayMs(nextAttempt, reconnectPolicy)
      reconnectRef.current = setTimeout(() => {
        reconnectRef.current = null
        connect()
      }, delay)
    }

    function connect() {
      if (disposed || manuallyClosedRef.current) return
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return

      const url = optionsRef.current.wsUrl ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        clearReconnectTimer()
        reconnectAttemptRef.current = 0
        dispatch({ type: 'CONNECTED', connected: true })

        const restored = hasConnectedRef.current && reconnectPendingRef.current
        hasConnectedRef.current = true
        reconnectPendingRef.current = false

        if (restored) {
          dispatch({ type: 'EVENT', event: { type: 'connection_restored' } })
        }
      }

      ws.onclose = () => {
        dispatch({ type: 'CONNECTED', connected: false })
        wsRef.current = null

        if (disposed || manuallyClosedRef.current || terminalEventSeenRef.current) return

        if (hasConnectedRef.current && !reconnectPendingRef.current) {
          dispatch({ type: 'EVENT', event: { type: 'connection_lost' } })
        }

        scheduleReconnect()
      }

      ws.onerror = () => ws.close()

      ws.onmessage = (ev) => {
        const parsed = parseSweechUiMessage(String(ev.data))
        if (!parsed.event) return

        const reconnectPolicy = resolveReconnectPolicy(optionsRef.current.reconnect)
        const replayKey = getEnvelopeReplayKey(parsed.envelope)
        if (replayKey) {
          const registration = registerReplayKey(replayKeysRef.current, replayKey, reconnectPolicy.replayWindowSize)
          replayKeysRef.current = registration.next
          if (registration.duplicate) return
        }

        if (isTerminalSessionEvent(parsed.event)) {
          terminalEventSeenRef.current = true
          clearReconnectTimer()
        }

        dispatch({ type: 'EVENT', event: parsed.event })
      }
    }

    manuallyClosedRef.current = false
    terminalEventSeenRef.current = false
    hasConnectedRef.current = false
    reconnectPendingRef.current = false
    reconnectAttemptRef.current = 0
    replayKeysRef.current = []

    connect()

    return () => {
      disposed = true
      manuallyClosedRef.current = true
      clearReconnectTimer()
      wsRef.current?.close()
      wsRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { session: state, send, clear, dispatch: dispatchEvent }
}
