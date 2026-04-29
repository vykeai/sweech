import type { Command } from 'commander'
import { getAllAccountInfo, getAccountInfo } from '../usage.js'

function pct(v?: number) {
  if (v === undefined) return '—'
  return `${Math.round(v * 100)}%`
}

function countdown(secs?: number) {
  if (!secs) return '—'
  const diff = secs - Math.floor(Date.now() / 1000)
  if (diff <= 0) return 'now'
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function bar(v?: number, width = 20): string {
  if (v === undefined) return ' '.repeat(width)
  const filled = Math.round(v * width)
  const color = v >= 0.9 ? '\x1b[31m' : v >= 0.7 ? '\x1b[33m' : '\x1b[32m'
  return `${color}${'█'.repeat(filled)}${'░'.repeat(width - filled)}\x1b[0m`
}

function statusBadge(status?: string): string {
  if (!status) return ''
  if (status === 'allowed') return '\x1b[32m● allowed\x1b[0m'
  if (status === 'allowed_warning') return '\x1b[33m● warning\x1b[0m'
  if (status === 'rejected') return '\x1b[31m● rejected\x1b[0m'
  return status
}

export function registerUsageCommand(program: Command) {
  program
    .command('usage')
    .description('Show Claude Code usage stats (5h/7d windows, reset times)')
    .option('--json', 'Output as JSON')
    .option('--profile <configDir>', 'Specific config dir (default: all detected profiles)')
    .option('--refresh', 'Force-refresh live data, bypassing cache')
    .action(async (opts: { json?: boolean; profile?: string; refresh?: boolean }) => {
      try {
        const accounts = opts.profile
          ? [await getAccountInfo(opts.profile)]
          : await getAllAccountInfo()

        if (opts.json) {
          console.log(JSON.stringify(accounts, null, 2))
          return
        }

        for (const a of accounts) {
          const label = a.displayName
            ? `${a.displayName} (${a.commandName})`
            : a.commandName
          console.log(`\n\x1b[1m${label}\x1b[0m`)
          if (a.emailAddress) console.log(`  ${a.emailAddress}`)
          if (a.billingType) console.log(`  Plan: ${a.billingType}`)
          console.log()

          // History-based stats
          console.log(`  Messages (history):`)
          console.log(`    5h window:  ${a.messages5h}`)
          console.log(`    7d window:  ${a.messages7d}`)
          console.log(`    Total:      ${a.totalMessages}`)
          if (a.minutesUntilFirstCapacity !== undefined) {
            console.log(`    Next 5h slot opens in: ${a.minutesUntilFirstCapacity}m`)
          }
          if (a.weeklyResetAt) {
            console.log(`    7d reset: ${a.weeklyResetAt} (in ${a.hoursUntilWeeklyReset}h)`)
          }

          // Live rate-limit data
          if (a.live) {
            const { utilization5h, utilization7d, reset5hAt, reset7dAt, status } = a.live
            console.log()
            console.log(`  Live quota: ${statusBadge(status)}`)
            console.log(`    5h: ${bar(utilization5h)} ${pct(utilization5h)}  resets in ${countdown(reset5hAt)}`)
            console.log(`    7d: ${bar(utilization7d)} ${pct(utilization7d)}  resets in ${countdown(reset7dAt)}`)
          } else {
            console.log()
            console.log('  Live quota: \x1b[2munavailable (macOS + Max plan required)\x1b[0m')
          }
        }

        if (accounts.length === 0) {
          console.log('No Claude profiles found in home directory.')
        }
      } catch (err) {
        console.error((err as Error).message)
        process.exit(1)
      }
    })
}
