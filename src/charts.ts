/**
 * ASCII bar charts and sparklines for terminal usage display.
 *
 * All rendering is pure string manipulation — no TTY escape codes beyond
 * optional chalk colour wrappers passed in by the caller.
 */

import chalk from 'chalk';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BAR_WIDTH = 30;
const FILLED_CHAR = '\u2588'; // █
const EMPTY_CHAR = '\u2591';  // ░
const SPARK_CHARS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
// ▁▂▃▄▅▆▇█

// ── asciiBar ─────────────────────────────────────────────────────────────────

export interface AsciiBarOptions {
  label: string;
  value: number;
  max: number;
  /** Number of characters for the bar body (default 30). */
  width?: number;
  /** Optional chalk colour function applied to the filled portion. */
  color?: (s: string) => string;
}

/**
 * Render a single labelled bar:
 *
 *   label [████████░░░░░░░░░░░░░░░░░░░░░░] 75%
 */
export function asciiBar(options: AsciiBarOptions): string {
  const { label, value, max, width = DEFAULT_BAR_WIDTH, color } = options;

  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);

  let filledStr = FILLED_CHAR.repeat(filled);
  const emptyStr = EMPTY_CHAR.repeat(empty);

  if (color) {
    filledStr = color(filledStr);
  }

  return `${label} [${filledStr}${emptyStr}] ${pct}%`;
}

// ── usageChart ───────────────────────────────────────────────────────────────

export interface UsageAccount {
  name: string;
  /** 0.0 – 1.0 */
  utilization5h: number;
  /** 0.0 – 1.0 */
  utilization7d: number;
}

/**
 * Render a multi-account comparison chart.
 *
 * Each account gets two bars (5h session and 7d weekly) with colour coding:
 *   green  <= 50%
 *   yellow <= 80%
 *   red    > 80%
 */
export function usageChart(accounts: UsageAccount[]): string {
  if (accounts.length === 0) return '';

  // Compute the widest account name so bars line up
  const maxNameLen = Math.max(...accounts.map(a => a.name.length));

  const lines: string[] = [];

  for (const acct of accounts) {
    const paddedName = acct.name.padEnd(maxNameLen);

    const color5h = barColor(acct.utilization5h);
    const color7d = barColor(acct.utilization7d);

    lines.push(
      asciiBar({ label: `${paddedName}  5h`, value: acct.utilization5h, max: 1, color: color5h }),
    );
    lines.push(
      asciiBar({ label: `${paddedName}  7d`, value: acct.utilization7d, max: 1, color: color7d }),
    );

    // Blank separator between accounts (except after the last one)
    if (acct !== accounts[accounts.length - 1]) {
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Pick a chalk colour function based on utilisation level.
 */
export function barColor(ratio: number): (s: string) => string {
  if (ratio <= 0.5) return chalk.green;
  if (ratio <= 0.8) return chalk.yellow;
  return chalk.red;
}

// ── sparkline ────────────────────────────────────────────────────────────────

/**
 * Render a sparkline from an array of numeric values using Unicode block
 * characters ▁▂▃▄▅▆▇█.
 *
 * Values are scaled relative to the min and max of the input array so the
 * full range of block heights is used.
 *
 * Returns an empty string for an empty input array.
 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  return values
    .map(v => {
      if (range === 0) {
        // All values are identical — use the middle block
        return SPARK_CHARS[Math.floor(SPARK_CHARS.length / 2)];
      }
      const normalised = (v - min) / range;
      const idx = Math.min(
        Math.floor(normalised * SPARK_CHARS.length),
        SPARK_CHARS.length - 1,
      );
      return SPARK_CHARS[idx];
    })
    .join('');
}
