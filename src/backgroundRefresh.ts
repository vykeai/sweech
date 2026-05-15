/**
 * Stale-while-revalidate helper for the on-disk quota cache.
 *
 * When a CLI command returns cached data, it can call `kickBackgroundRefresh()`
 * to spawn a detached `sweech usage --refresh` subprocess that updates the
 * cache file for the next invocation. The caller never blocks on the result.
 *
 * Two safeguards:
 *  - Throttle: a marker file at ~/.sweech/.last-bg-refresh prevents more than
 *    one kick per minute, no matter how often the CLI is invoked.
 *  - Recursion guard: the SWEECH_BG_REFRESH env var prevents the background
 *    subprocess from kicking *its own* background refresh.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const MARKER_FILE = path.join(os.homedir(), '.sweech', '.last-bg-refresh');
// Cache TTL in liveUsage.ts is 5 min; refreshing every 60s keeps the
// cache age between 0 and ~1 min. Costs ~12% CPU only while SweechBar (30s
// poll) or the user is actively triggering reads — refresh is detached so
// no foreground latency. Idle = no refresh.
const THROTTLE_MS = 60 * 1000;

export function kickBackgroundRefresh(): void {
  // Recursion guard: the background subprocess sets this env var.
  if (process.env.SWEECH_BG_REFRESH === '1') return;

  // Throttle: only kick if the marker is missing or older than 60s.
  try {
    const stat = fs.statSync(MARKER_FILE);
    if (Date.now() - stat.mtimeMs < THROTTLE_MS) return;
  } catch { /* marker missing — first run, proceed */ }

  // Touch the marker now (before spawn) so concurrent invocations don't race.
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
    fs.writeFileSync(MARKER_FILE, String(Date.now()));
  } catch { return; }

  try {
    const { spawn } = require('child_process');
    const child = spawn(process.argv[0], [process.argv[1], 'usage', '--refresh'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SWEECH_BG_REFRESH: '1' },
    });
    child.unref();
  } catch { /* spawn failed — best-effort */ }
}
