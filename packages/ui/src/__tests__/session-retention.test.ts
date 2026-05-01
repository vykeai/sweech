import { describe, expect, it } from 'vitest'
import type { SessionRetentionPolicy } from '../types/index.js'
import { migrateSessionArchiveSnapshots } from '@sweech/engine'
import { createMessage, createMessages, MemorySessionArchiveStore } from './fixtures/session.js'
import {
  clearSessionArchive,
  persistSessionArchiveSnapshots,
  rehydrateSessionArchive,
  retainSessionMessages,
} from '../session/retention.js'
import {
  initialSweechSessionStateInternal,
  reduceSweechSessionState,
  toPublicSessionState,
} from '../session/state.js'

describe('session retention', () => {
  it('keeps pinned messages while trimming old history and tool invocations', () => {
    const retained = retainSessionMessages(
      [
        createMessage(0, { type: 'event', pinned: true, content: 'system-banner' }),
        createMessage(1, { type: 'tool_call' }),
        createMessage(2, { type: 'tool_result' }),
        createMessage(3),
        createMessage(4),
      ],
      {
        maxMessages: 2,
        maxToolInvocations: 1,
      },
    )

    expect(retained.messages.map((message) => message.id)).toEqual(['msg-0', 'msg-3', 'msg-4'])
    expect(retained.pruned.map((message) => message.id)).toEqual(['msg-1', 'msg-2'])
  })

  it('persists snapshots with a bounded archive and rehydrates them in order', async () => {
    const archiveStore = new MemorySessionArchiveStore()
    const retention: SessionRetentionPolicy = {
      archiveStore,
      maxContextSnapshots: 2,
    }

    await persistSessionArchiveSnapshots(retention, [
      { schemaVersion: 2, createdAt: 1, messages: [createMessage(0)] },
    ])
    await persistSessionArchiveSnapshots(retention, [
      { schemaVersion: 2, createdAt: 2, messages: [createMessage(1)] },
      { schemaVersion: 2, createdAt: 3, messages: [createMessage(2)] },
    ])

    const snapshots = migrateSessionArchiveSnapshots(archiveStore.load(), (message): message is ReturnType<typeof createMessage> => typeof message === 'object' && message !== null && 'id' in message)
    expect(snapshots).toHaveLength(2)
    expect(snapshots.every((snapshot) => snapshot.schemaVersion === 2)).toBe(true)
    expect(snapshots.map((snapshot) => snapshot.createdAt)).toEqual([2, 3])

    const rehydrated = await rehydrateSessionArchive(retention)
    expect(rehydrated.map((message) => message.id)).toEqual(['msg-1', 'msg-2'])

    await clearSessionArchive(retention)
    expect(archiveStore.load()).toEqual([])
  })

  it('bounds useSweechSession state under long sessions and can rehydrate archived history', () => {
    const archiveStore = new MemorySessionArchiveStore()
    const retention: SessionRetentionPolicy = {
      archiveStore,
      maxMessages: 50,
      maxToolInvocations: 10,
      maxContextSnapshots: 5,
    }

    const state = reduceSweechSessionState(initialSweechSessionStateInternal, {
      type: 'MESSAGES',
      messages: createMessages(1000),
      retention,
    })

    expect(state.messages).toHaveLength(50)
    expect(state.pendingArchive).toHaveLength(1)
    expect(state.pendingArchive[0]?.messages).toHaveLength(950)
    expect(toPublicSessionState(state).messages[0]?.id).toBe('msg-950')

    const rehydratedState = reduceSweechSessionState(
      {
        ...state,
        pendingArchive: [],
      },
      {
        type: 'REHYDRATED',
        messages: [createMessage(10), createMessage(11)],
        retention: {
          ...retention,
          maxMessages: 52,
        },
      },
    )

    expect(rehydratedState.messages[0]?.id).toBe('msg-10')
    expect(rehydratedState.messages[1]?.id).toBe('msg-11')
  })

  it('migrates legacy and v1 snapshots on load and rejects future schema versions', async () => {
    const archiveStore = new MemorySessionArchiveStore()
    const retention: SessionRetentionPolicy = { archiveStore }

    archiveStore.seed([
      { createdAt: 1, messages: [createMessage(0)] },
      { schemaVersion: 1, createdAt: '1970-01-01T00:00:00.002Z', messages: [createMessage(1)] },
    ])

    const rehydrated = await rehydrateSessionArchive(retention)
    expect(rehydrated.map((message) => message.id)).toEqual(['msg-0', 'msg-1'])

    archiveStore.seed([
      { schemaVersion: 99, createdAt: 3, messages: [createMessage(2)] },
    ])

    await expect(rehydrateSessionArchive(retention)).rejects.toThrow('Upgrade sweech')
  })
})
