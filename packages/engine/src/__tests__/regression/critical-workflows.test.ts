import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OmnaiClient } from '../../client.js'
import { createApp, clearEstateCache, setDaemonLifecycleState } from '../../daemon/server.js'
import { QuotaTracker } from '../../daemon/quota.js'
import type { Estate } from '../../estate.js'
import {
  budgetMiddleware,
  toolTimingMiddleware,
  wrapRunner,
} from '../../middleware/index.js'
import * as selectModule from '../../select.js'
import type { AgentEvent, ModelRunner } from '../../types.js'

vi.mock('@vykeai/fed', () => ({
  FedEventClient: class { publish() { return Promise.resolve({}) } },
}))

vi.mock('../../detect.js', () => ({
  detectEngines: vi.fn().mockResolvedValue([
    { engine: 'claude-code', available: true, binaryPath: '/usr/bin/claude', providers: ['claude'] },
    { engine: 'copilot', available: true, binaryPath: '/usr/bin/copilot', providers: ['github'] },
    { engine: 'pi-mono', available: true, binaryPath: '/usr/bin/pi', providers: ['openai'] },
  ]),
}))

vi.mock('../../select.js', async () => {
  const actual = await vi.importActual<typeof import('../../select.js')>('../../select.js')
  return {
    ...actual,
    makeRunner: vi.fn(),
  }
})

function createMockRunner(
  engine: 'claude-code' | 'copilot' | 'pi-mono',
  events: AgentEvent[],
): ModelRunner {
  return {
    engine,
    async isAvailable() {
      return true
    },
    async *run() {
      for (const event of events) {
        yield event
      }
    },
  }
}

function createStreamResponse(text: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream)
}

function createFallbackEstate(): Estate {
  return {
    version: 1,
    accounts: {
      'claude-main': {
        provider: 'claude',
        engine: 'claude-code',
        type: 'free-tier',
        quota: { period: 'daily', limit: 1 },
      },
      'copilot-backup': {
        provider: 'github',
        engine: 'copilot',
        type: 'free-tier',
        quota: { period: 'daily', limit: 2 },
      },
    },
    failoverOrder: ['claude-main', 'copilot-backup'],
  }
}

function tmpStatePath(): string {
  return `/tmp/omnai-regression-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
}

function postJson(app: ReturnType<typeof createApp>, path: string, body: Record<string, unknown> | string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function extractDaemonTrace(raw: string): string[] {
  return raw
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { event?: { type?: string } })
    .map((frame) => frame.event?.type ?? 'unknown')
}

function installFetchBridge(app: ReturnType<typeof createApp>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = typeof input === 'string' || input instanceof URL
      ? new Request(String(input), init)
      : input
    const url = new URL(request.url)
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.text()
    return app.request(url.pathname + url.search, {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      ...(body ? { body } : {}),
    })
  })
}

describe('critical regression workflows', () => {
  const quotaTrackers: QuotaTracker[] = []

  beforeEach(() => {
    clearEstateCache()
    setDaemonLifecycleState('ready')
    vi.restoreAllMocks()
    for (const tracker of quotaTrackers) tracker.destroy()
    quotaTrackers.length = 0
  })

  it('keeps readiness gate behavior stable across health, select, and run', async () => {
    const app = createApp()
    setDaemonLifecycleState('booting', 'warming')

    const health = await app.request('/healthz')
    const select = await postJson(app, '/select', { provider: 'claude' })
    const run = await postJson(app, '/run', { prompt: 'hello' })

    const trace = [
      `health:${health.status}:${(await health.json()).state}`,
      `select:${select.status}:${(await select.json()).state}`,
      `run:${run.status}:${(await run.json()).state}`,
    ]

    expect(trace, JSON.stringify(trace, null, 2)).toEqual([
      'health:503:booting',
      'select:503:booting',
      'run:503:booting',
    ])
  })

  it('keeps /select and /run converged for a happy-path client journey', async () => {
    const app = createApp({
      estate: {
        version: 1,
        accounts: {
          'claude-rai': {
            provider: 'claude',
            engine: 'claude-code',
            type: 'subscription',
          },
        },
        failoverOrder: ['claude-rai'],
      },
    })

    vi.spyOn(selectModule, 'makeRunner').mockReturnValueOnce(createMockRunner('claude-code', [
      { type: 'text', content: 'hello from regression' },
      {
        type: 'result',
        output: 'done',
        usage: { inputTokens: 5, outputTokens: 2 },
        costUsd: 0.02,
        durationMs: 40,
      },
    ]))

    const fetchBridge = installFetchBridge(app)
    const client = new OmnaiClient({ host: '127.0.0.1', port: 7845 })

    const selection = await client.select({ account: 'claude-rai' })
    const events: AgentEvent[] = []
    for await (const event of client.run('hello', { account: 'claude-rai' })) {
      events.push(event)
    }

    const trace = [
      `select:${selection.engine}:${selection.account}`,
      ...events.map((event) => event.type),
    ]

    expect(trace, JSON.stringify(trace, null, 2)).toEqual([
      'select:claude-code:claude-rai',
      'text',
      'result',
    ])
    expect(events[1]).toMatchObject({
      type: 'result',
      provider: 'claude',
      account: 'claude-rai',
    })

    fetchBridge.mockRestore()
  })

  it('surfaces malformed request and malformed daemon stream failures with replayable traces', async () => {
    const app = createApp()
    const invalidJson = await postJson(app, '/run', '{')

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(createStreamResponse('data: {not-json\n\n'))
    const clientEvents: AgentEvent[] = []
    for await (const event of new OmnaiClient({ host: '127.0.0.1', port: 7845 }).run('broken')) {
      clientEvents.push(event)
    }

    const invalidJsonBody = await invalidJson.json()
    const trace = [
      `request:${invalidJson.status}:${invalidJsonBody.code}`,
      `stream:${clientEvents[0]?.type}:${'message' in (clientEvents[0] ?? {}) ? clientEvents[0]?.message : ''}`,
    ]

    expect(trace, JSON.stringify(trace, null, 2)).toEqual([
      'request:400:invalid_json',
      'stream:error:daemon stream produced malformed JSON',
    ])
  })

  it('keeps quota fallback routing deterministic for exhausted primaries', async () => {
    const estate = createFallbackEstate()
    const tracker = new QuotaTracker(estate, tmpStatePath())
    quotaTrackers.push(tracker)
    tracker.recordUsage('claude-main', 100, 0.01)

    const app = createApp({ estate, quotaTracker: tracker })
    const response = await postJson(app, '/select', {})
    const body = await response.json()
    const trace = [
      `status:${response.status}`,
      `account:${body.account}`,
      `reason:${body.fallbackReason}`,
    ]

    expect(trace, JSON.stringify(trace, null, 2)).toEqual([
      'status:200',
      'account:copilot-backup',
      'reason:claude-main quota exceeded, fell back to copilot-backup',
    ])
  })

  it('records stable budget and tool-policy denial traces', async () => {
    const budgetRunner = createMockRunner('pi-mono', [
      {
        type: 'cost_update',
        costUsd: 0.06,
        tokensUsed: { inputTokens: 10, outputTokens: 6 },
      },
      {
        type: 'text',
        content: 'should never reach consumers',
      },
    ])

    const budgetWrapped = wrapRunner(
      budgetRunner,
      budgetMiddleware({ maxCostUsd: 0.05, action: 'abort' }),
    )

    const budgetTrace: string[] = []
    for await (const event of budgetWrapped.run('budget regression', {})) {
      budgetTrace.push(event.type === 'error' ? `${event.type}:${event.message}` : event.type)
    }

    expect(budgetTrace, JSON.stringify(budgetTrace, null, 2)).toEqual([
      'cost_update',
      'error:Budget exceeded: cumulative cost $0.0600 >= $0.05 limit. Aborting.',
    ])

    const toolRunner = createMockRunner('copilot', [
      {
        type: 'tool_use',
        name: 'bash',
        input: { command: 'rm -rf /' },
        toolCallId: 'tool-1',
      } as AgentEvent,
      {
        type: 'tool_result',
        name: 'bash',
        content: 'blocked',
        isError: false,
        toolCallId: 'tool-1',
      } as AgentEvent,
    ])

    const toolWrapped = wrapRunner(toolRunner, toolTimingMiddleware)
    const toolTrace: string[] = []
    for await (const event of toolWrapped.run('tool regression', {
      toolPolicy: {
        policyId: 'regression',
        actor: 'suite',
        denyTools: ['bash'],
      },
    })) {
      toolTrace.push(event.type === 'error' ? `${event.code}:${event.message}` : event.type)
    }

    expect(toolTrace, JSON.stringify(toolTrace, null, 2)).toEqual([
      'tool_policy_denied:Tool "bash" blocked by policy: tool_explicitly_denied',
    ])
  })

  it('preserves daemon stream ordering for replayable traces', async () => {
    const app = createApp({
      estate: {
        version: 1,
        accounts: {
          'claude-rai': {
            provider: 'claude',
            engine: 'claude-code',
            type: 'subscription',
          },
        },
        failoverOrder: ['claude-rai'],
      },
    })

    vi.spyOn(selectModule, 'makeRunner').mockReturnValueOnce(createMockRunner('claude-code', [
      { type: 'text', content: 'hello' },
      {
        type: 'result',
        output: 'done',
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0.01,
        durationMs: 12,
      },
    ]))

    const run = await postJson(app, '/run', { prompt: 'hello', account: 'claude-rai' })
    const trace = extractDaemonTrace(await run.text())

    expect(trace, JSON.stringify(trace, null, 2)).toEqual(['text', 'result'])
  })
})
