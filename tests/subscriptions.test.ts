import { getAccountInfo, getKnownAccounts } from '../src/subscriptions'
import * as liveUsage from '../src/liveUsage'

jest.mock('../src/liveUsage', () => ({
  getLiveUsage: jest.fn(async () => ({ capturedAt: 1, buckets: [] })),
  refreshLiveUsage: jest.fn(async () => ({ capturedAt: 2, buckets: [] })),
}))

describe('subscriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('getKnownAccounts includes default claude and codex accounts and deduplicates profiles', () => {
    const accounts = getKnownAccounts([
      { name: 'claude-pole', commandName: 'claude-pole', cliType: 'claude' },
      { name: 'codex-pole', commandName: 'codex-pole', cliType: 'codex' },
      { name: 'codex', commandName: 'codex', cliType: 'codex' },
    ])

    expect(accounts.map(a => a.commandName)).toEqual([
      'claude',
      'codex',
      'cursor',
      'windsurf',
      'aider',
      'gemini',
      'amazonq',
      'claude-pole',
      'codex-pole',
    ])
    expect(accounts.find(a => a.commandName === 'claude')?.isDefault).toBe(true)
    expect(accounts.find(a => a.commandName === 'codex')?.isDefault).toBe(true)
  })

  test('getAccountInfo uses cached live usage by default', async () => {
    const accounts = await getAccountInfo([{ name: 'codex', commandName: 'codex', cliType: 'codex' }])

    expect(liveUsage.getLiveUsage).toHaveBeenCalledWith(expect.stringMatching(/\.codex$/), 'codex')
    expect(liveUsage.refreshLiveUsage).not.toHaveBeenCalled()
    expect(accounts[0].cliType).toBe('codex')
    expect(accounts[0].live?.capturedAt).toBe(1)
  })

  test('getAccountInfo forces refresh when requested', async () => {
    const accounts = await getAccountInfo(
      [{ name: 'claude-pole', commandName: 'claude-pole', cliType: 'claude' }],
      { refresh: true },
    )

    expect(liveUsage.refreshLiveUsage).toHaveBeenCalledWith(expect.stringMatching(/\.claude-pole$/), 'claude')
    expect(liveUsage.getLiveUsage).not.toHaveBeenCalled()
    expect(accounts[0].cliType).toBe('claude')
    expect(accounts[0].live?.capturedAt).toBe(2)
  })
})
