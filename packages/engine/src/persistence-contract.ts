import type { EngineId } from './types.js'
import type { CredentialProfile } from './middleware/types.js'

export const OMNAI_RUNTIME_DOCUMENT_SCHEMA = 'omnai.runtime' as const
export const OMNAI_RUNTIME_DOCUMENT_VERSION = 2 as const
export const OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION = 2 as const

export type OmnaiMigrationCode = 'invalid_shape' | 'unknown_version'

export class OmnaiMigrationError extends Error {
  readonly code: OmnaiMigrationCode
  readonly remediation: string
  readonly source: string

  constructor(code: OmnaiMigrationCode, source: string, detail: string, remediation: string) {
    super(`${detail} ${remediation}`)
    this.name = 'OmnaiMigrationError'
    this.code = code
    this.remediation = remediation
    this.source = source
  }
}

export function isOmnaiMigrationError(value: unknown): value is OmnaiMigrationError {
  return value instanceof OmnaiMigrationError
}

export interface OmnaiRuntimeConfigBlock {
  defaults?: Partial<Record<EngineId, string>>
  failoverOrder?: string[]
}

export interface OmnaiLegacyRuntimeConfig {
  _config?: OmnaiRuntimeConfigBlock
  [name: string]: CredentialProfile | OmnaiRuntimeConfigBlock | undefined
}

export interface OmnaiRuntimeDocumentV1 {
  schema: typeof OMNAI_RUNTIME_DOCUMENT_SCHEMA
  version: 1
  defaults?: Partial<Record<EngineId, string>>
  failoverOrder?: string[]
  profiles: Record<string, CredentialProfile>
}

export interface OmnaiRuntimeDocumentV2 {
  schema: typeof OMNAI_RUNTIME_DOCUMENT_SCHEMA
  version: typeof OMNAI_RUNTIME_DOCUMENT_VERSION
  runtime: OmnaiRuntimeConfigBlock
  profiles: Record<string, CredentialProfile>
}

export type OmnaiRuntimeStoreData =
  | OmnaiLegacyRuntimeConfig
  | OmnaiRuntimeDocumentV1
  | OmnaiRuntimeDocumentV2

export type OmnaiSessionArchiveMessageType =
  | 'text'
  | 'prompt'
  | 'tool_call'
  | 'tool_result'
  | 'event'
  | 'error'
  | 'success'
  | 'thinking'

export interface OmnaiSessionArchiveMessage {
  id: string
  type: OmnaiSessionArchiveMessageType
  taskId?: string
  content: string
  toolName?: string
  toolHint?: string
  isError?: boolean
  pinned?: boolean
  collapsed?: boolean
  timestamp?: number
}

export interface OmnaiLegacySessionArchiveSnapshot<TMessage = OmnaiSessionArchiveMessage> {
  createdAt: number
  messages: TMessage[]
}

export interface OmnaiSessionArchiveSnapshotV1<TMessage = OmnaiSessionArchiveMessage> {
  schemaVersion: 1
  createdAt: number | string
  messages: TMessage[]
}

export interface OmnaiSessionArchiveSnapshotV2<TMessage = OmnaiSessionArchiveMessage> {
  schemaVersion: typeof OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION
  createdAt: number
  messages: TMessage[]
}

export type OmnaiSessionArchiveSnapshot<TMessage = OmnaiSessionArchiveMessage> =
  OmnaiSessionArchiveSnapshotV2<TMessage>

export type OmnaiSessionArchiveStoreData<TMessage = OmnaiSessionArchiveMessage> = Array<
  | OmnaiLegacySessionArchiveSnapshot<TMessage>
  | OmnaiSessionArchiveSnapshotV1<TMessage>
  | OmnaiSessionArchiveSnapshotV2<TMessage>
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failInvalidShape(source: string, detail: string): never {
  throw new OmnaiMigrationError(
    'invalid_shape',
    source,
    `Invalid persisted data in ${source}: ${detail}.`,
    'Repair or remove the stored file before retrying.',
  )
}

function failUnknownVersion(source: string, version: unknown, target: number): never {
  throw new OmnaiMigrationError(
    'unknown_version',
    source,
    `Unsupported schema version ${String(version)} in ${source}.`,
    `Upgrade omnai to a build that understands version ${String(version)} or reset the stored data. Current version: ${target}.`,
  )
}

function cloneStringRecord(value: Record<string, unknown> | undefined, source: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      failInvalidShape(source, `expected "${key}" to be a string`)
    }
    out[key] = entry
  }
  return out
}

function cloneRuntimeConfigBlock(value: unknown, source: string): OmnaiRuntimeConfigBlock {
  if (value === undefined) return {}
  if (!isRecord(value)) failInvalidShape(source, 'expected runtime config block to be an object')

  const defaults = value.defaults
  if (defaults !== undefined && !isRecord(defaults)) {
    failInvalidShape(source, 'expected defaults to be an object map')
  }

  const failoverOrder = value.failoverOrder
  if (failoverOrder !== undefined && (!Array.isArray(failoverOrder) || failoverOrder.some((entry) => typeof entry !== 'string'))) {
    failInvalidShape(source, 'expected failoverOrder to be a string array')
  }

  return {
    ...(defaults !== undefined ? { defaults: cloneStringRecord(defaults, `${source}.defaults`) as Partial<Record<EngineId, string>> } : {}),
    ...(failoverOrder !== undefined ? { failoverOrder: [...failoverOrder] } : {}),
  }
}

function cloneCredentialProfile(value: unknown, source: string): CredentialProfile {
  if (!isRecord(value)) failInvalidShape(source, 'expected profile to be an object')
  if (typeof value.name !== 'string' || value.name.length === 0) {
    failInvalidShape(source, 'expected profile.name to be a non-empty string')
  }
  if (typeof value.provider !== 'string' || value.provider.length === 0) {
    failInvalidShape(source, 'expected profile.provider to be a non-empty string')
  }

  const env = value.env
  if (env !== undefined && !isRecord(env)) {
    failInvalidShape(source, 'expected profile.env to be a string map')
  }

  for (const [field, entry] of Object.entries({
    apiKey: value.apiKey,
    baseUrl: value.baseUrl,
    claudeConfigDir: value.claudeConfigDir,
  })) {
    if (entry !== undefined && typeof entry !== 'string') {
      failInvalidShape(source, `expected profile.${field} to be a string`)
    }
  }

  return {
    name: value.name,
    provider: value.provider,
    ...(env !== undefined ? { env: cloneStringRecord(env, `${source}.env`) } : {}),
    ...(typeof value.apiKey === 'string' ? { apiKey: value.apiKey } : {}),
    ...(typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {}),
    ...(typeof value.claudeConfigDir === 'string' ? { claudeConfigDir: value.claudeConfigDir } : {}),
  }
}

function cloneProfilesMap(value: unknown, source: string): Record<string, CredentialProfile> {
  if (!isRecord(value)) failInvalidShape(source, 'expected profiles to be an object')
  const profiles: Record<string, CredentialProfile> = {}
  for (const [name, profile] of Object.entries(value)) {
    profiles[name] = cloneCredentialProfile(profile, `${source}.${name}`)
  }
  return profiles
}

export function createEmptyRuntimeDocument(): OmnaiRuntimeDocumentV2 {
  return {
    schema: OMNAI_RUNTIME_DOCUMENT_SCHEMA,
    version: OMNAI_RUNTIME_DOCUMENT_VERSION,
    runtime: {},
    profiles: {},
  }
}

export function migrateRuntimeDocument(value: unknown, source = 'runtime document'): OmnaiRuntimeDocumentV2 {
  if (!isRecord(value)) failInvalidShape(source, 'expected a JSON object')

  if (value.schema === undefined && value.version === undefined) {
    const runtime = cloneRuntimeConfigBlock(value._config, `${source}._config`)
    const profiles: Record<string, CredentialProfile> = {}
    for (const [name, profile] of Object.entries(value)) {
      if (name === '_config') continue
      profiles[name] = cloneCredentialProfile(profile, `${source}.${name}`)
    }
    return {
      schema: OMNAI_RUNTIME_DOCUMENT_SCHEMA,
      version: OMNAI_RUNTIME_DOCUMENT_VERSION,
      runtime,
      profiles,
    }
  }

  if (value.schema !== OMNAI_RUNTIME_DOCUMENT_SCHEMA) {
    failInvalidShape(source, `expected schema "${OMNAI_RUNTIME_DOCUMENT_SCHEMA}"`)
  }

  if (value.version === 1) {
    return {
      schema: OMNAI_RUNTIME_DOCUMENT_SCHEMA,
      version: OMNAI_RUNTIME_DOCUMENT_VERSION,
      runtime: {
        ...cloneRuntimeConfigBlock({ defaults: value.defaults, failoverOrder: value.failoverOrder }, `${source}.version1`),
      },
      profiles: cloneProfilesMap(value.profiles, `${source}.profiles`),
    }
  }

  if (value.version === OMNAI_RUNTIME_DOCUMENT_VERSION) {
    return {
      schema: OMNAI_RUNTIME_DOCUMENT_SCHEMA,
      version: OMNAI_RUNTIME_DOCUMENT_VERSION,
      runtime: cloneRuntimeConfigBlock(value.runtime, `${source}.runtime`),
      profiles: cloneProfilesMap(value.profiles, `${source}.profiles`),
    }
  }

  failUnknownVersion(source, value.version, OMNAI_RUNTIME_DOCUMENT_VERSION)
}

export function toLegacyRuntimeConfig(document: OmnaiRuntimeDocumentV2): OmnaiLegacyRuntimeConfig {
  const config: OmnaiLegacyRuntimeConfig = {}
  const runtime = cloneRuntimeConfigBlock(document.runtime, 'runtime')
  if (Object.keys(runtime).length > 0) {
    config._config = runtime
  }

  for (const [name, profile] of Object.entries(document.profiles)) {
    config[name] = cloneCredentialProfile(profile, `runtime.profiles.${name}`)
  }

  return config
}

export function serializeRuntimeDocument(config: OmnaiLegacyRuntimeConfig | OmnaiRuntimeDocumentV2): string {
  const document = 'schema' in config && config.schema === OMNAI_RUNTIME_DOCUMENT_SCHEMA
    ? migrateRuntimeDocument(config, 'runtime document')
    : migrateRuntimeDocument(config, 'legacy runtime document')
  return `${JSON.stringify(document, null, 2)}\n`
}

function isSessionArchiveMessageType(value: unknown): value is OmnaiSessionArchiveMessageType {
  return value === 'text'
    || value === 'prompt'
    || value === 'tool_call'
    || value === 'tool_result'
    || value === 'event'
    || value === 'error'
    || value === 'success'
    || value === 'thinking'
}

export function isOmnaiSessionArchiveMessage(value: unknown): value is OmnaiSessionArchiveMessage {
  return isRecord(value)
    && typeof value.id === 'string'
    && isSessionArchiveMessageType(value.type)
    && typeof value.content === 'string'
    && (value.taskId === undefined || typeof value.taskId === 'string')
    && (value.toolName === undefined || typeof value.toolName === 'string')
    && (value.toolHint === undefined || typeof value.toolHint === 'string')
    && (value.isError === undefined || typeof value.isError === 'boolean')
    && (value.pinned === undefined || typeof value.pinned === 'boolean')
    && (value.collapsed === undefined || typeof value.collapsed === 'boolean')
    && (value.timestamp === undefined || (typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)))
}

function normalizeSessionArchiveTimestamp(value: unknown, source: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  failInvalidShape(source, 'expected createdAt to be a finite number or ISO timestamp')
}

export function migrateSessionArchiveSnapshots<TMessage>(
  value: unknown,
  isMessage: (value: unknown) => value is TMessage,
  source = 'session archive',
): OmnaiSessionArchiveSnapshot<TMessage>[] {
  if (!Array.isArray(value)) {
    failInvalidShape(source, 'expected an array of snapshots')
  }

  return value.map((snapshot, index) => {
    const scope = `${source}[${index}]`
    if (!isRecord(snapshot)) failInvalidShape(scope, 'expected snapshot to be an object')
    if (!Array.isArray(snapshot.messages)) failInvalidShape(scope, 'expected messages to be an array')
    if (snapshot.messages.some((message) => !isMessage(message))) {
      failInvalidShape(scope, 'expected every archived message to match the current session message contract')
    }

    if (snapshot.schemaVersion === undefined) {
      return {
        schemaVersion: OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION,
        createdAt: normalizeSessionArchiveTimestamp(snapshot.createdAt, scope),
        messages: [...snapshot.messages],
      }
    }

    if (snapshot.schemaVersion === 1) {
      return {
        schemaVersion: OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION,
        createdAt: normalizeSessionArchiveTimestamp(snapshot.createdAt, scope),
        messages: [...snapshot.messages],
      }
    }

    if (snapshot.schemaVersion === OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION) {
      return {
        schemaVersion: OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION,
        createdAt: normalizeSessionArchiveTimestamp(snapshot.createdAt, scope),
        messages: [...snapshot.messages],
      }
    }

    failUnknownVersion(scope, snapshot.schemaVersion, OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION)
  })
}

export function serializeSessionArchiveSnapshots<TMessage>(
  snapshots: readonly OmnaiSessionArchiveSnapshot<TMessage>[],
): OmnaiSessionArchiveSnapshot<TMessage>[] {
  return snapshots.map((snapshot) => ({
    schemaVersion: OMNAI_SESSION_ARCHIVE_SNAPSHOT_VERSION,
    createdAt: snapshot.createdAt,
    messages: [...snapshot.messages],
  }))
}
