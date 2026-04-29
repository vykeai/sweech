import { describe, expect, it } from 'vitest'
import type { CredentialProfile } from '../middleware/types.js'
import {
  OMNAI_RUNTIME_DOCUMENT_SCHEMA,
  OMNAI_RUNTIME_DOCUMENT_VERSION,
  OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION,
  isOmnaiSessionArchiveMessage,
  migrateRuntimeDocument,
  migrateSessionArchiveSnapshots,
  serializeRuntimeDocument,
  serializeSessionArchiveSnapshots,
  toLegacyRuntimeConfig,
} from '../persistence-contract.js'

const profile: CredentialProfile = {
  name: 'claude-rai',
  provider: 'claude',
  claudeConfigDir: '/Users/test/.claude-rai',
}

describe('persistence-contract', () => {
  it('migrates legacy runtime config documents to the current schema and round-trips them', () => {
    const migrated = migrateRuntimeDocument({
      _config: {
        defaults: { 'claude-code': 'claude-rai' },
        failoverOrder: ['claude-rai'],
      },
      'claude-rai': profile,
    }, 'profiles.json')

    expect(migrated).toEqual({
      schema: OMNAI_RUNTIME_DOCUMENT_SCHEMA,
      version: OMNAI_RUNTIME_DOCUMENT_VERSION,
      runtime: {
        defaults: { 'claude-code': 'claude-rai' },
        failoverOrder: ['claude-rai'],
      },
      profiles: {
        'claude-rai': profile,
      },
    })

    expect(toLegacyRuntimeConfig(migrated)).toEqual({
      _config: {
        defaults: { 'claude-code': 'claude-rai' },
        failoverOrder: ['claude-rai'],
      },
      'claude-rai': profile,
    })
    expect(JSON.parse(serializeRuntimeDocument(toLegacyRuntimeConfig(migrated)))).toEqual(migrated)
  })

  it('migrates v1 runtime config documents and rejects future versions', () => {
    expect(migrateRuntimeDocument({
      schema: OMNAI_RUNTIME_DOCUMENT_SCHEMA,
      version: 1,
      defaults: { 'claude-code': 'claude-rai' },
      failoverOrder: ['claude-rai'],
      profiles: { 'claude-rai': profile },
    }, 'profiles.json')).toMatchObject({
      version: OMNAI_RUNTIME_DOCUMENT_VERSION,
      runtime: {
        defaults: { 'claude-code': 'claude-rai' },
        failoverOrder: ['claude-rai'],
      },
    })

    expect(() => migrateRuntimeDocument({
      schema: OMNAI_RUNTIME_DOCUMENT_SCHEMA,
      version: 99,
      profiles: {},
    }, 'profiles.json')).toThrow('Upgrade omnai')
  })

  it('migrates legacy and v1 session archive snapshots and rejects unknown versions', () => {
    const migrated = migrateSessionArchiveSnapshots([
      {
        createdAt: 1,
        messages: [{ id: 'msg-1', type: 'text', content: 'hello' }],
      },
      {
        schemaVersion: 1,
        createdAt: '1970-01-01T00:00:00.002Z',
        messages: [{ id: 'msg-2', type: 'event', content: 'world' }],
      },
    ], isOmnaiSessionArchiveMessage, 'session-archive')

    expect(migrated).toEqual([
      {
        schemaVersion: OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION,
        createdAt: 1,
        messages: [{ id: 'msg-1', type: 'text', content: 'hello' }],
      },
      {
        schemaVersion: OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION,
        createdAt: 2,
        messages: [{ id: 'msg-2', type: 'event', content: 'world' }],
      },
    ])

    expect(serializeSessionArchiveSnapshots(migrated)).toEqual(migrated)

    expect(() => migrateSessionArchiveSnapshots([
      {
        schemaVersion: 99,
        createdAt: 1,
        messages: [{ id: 'msg-3', type: 'text', content: 'future' }],
      },
    ], isOmnaiSessionArchiveMessage, 'session-archive')).toThrow('Upgrade omnai')
  })
})
