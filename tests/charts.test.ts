/**
 * Tests for ASCII bar charts and sparklines (src/charts.ts).
 */

import { sparkline, asciiBar, usageChart } from '../src/charts';

// ---------------------------------------------------------------------------
// sparkline
// ---------------------------------------------------------------------------

describe('sparkline', () => {
  test('returns empty string for empty input', () => {
    expect(sparkline([])).toBe('');
  });

  test('single value uses middle block character', () => {
    const result = sparkline([42]);
    // All values identical → middle block char (index 4 of 8-char set)
    expect(result).toHaveLength(1);
    expect(result).toBe('\u2585'); // ▅ — SPARK_CHARS[4]
  });

  test('all same values use identical middle block characters', () => {
    const result = sparkline([5, 5, 5, 5]);
    expect(result).toHaveLength(4);
    // Every character should be identical
    const chars = result.split('');
    expect(new Set(chars).size).toBe(1);
  });

  test('increasing values produce ascending blocks', () => {
    const result = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    const chars = result.split('');
    // Each character should be >= the previous one
    for (let i = 1; i < chars.length; i++) {
      expect(chars[i].codePointAt(0)!).toBeGreaterThanOrEqual(chars[i - 1].codePointAt(0)!);
    }
    // First should be lowest block, last should be highest
    expect(chars[0]).toBe('\u2581'); // ▁
    expect(chars[chars.length - 1]).toBe('\u2588'); // █
  });

  test('decreasing values produce descending blocks', () => {
    const result = sparkline([7, 6, 5, 4, 3, 2, 1, 0]);
    const chars = result.split('');
    // Each character should be <= the previous one
    for (let i = 1; i < chars.length; i++) {
      expect(chars[i].codePointAt(0)!).toBeLessThanOrEqual(chars[i - 1].codePointAt(0)!);
    }
    expect(chars[0]).toBe('\u2588'); // █
    expect(chars[chars.length - 1]).toBe('\u2581'); // ▁
  });

  test('two values: min gets lowest block, max gets highest', () => {
    const result = sparkline([10, 100]);
    expect(result[0]).toBe('\u2581'); // ▁
    expect(result[1]).toBe('\u2588'); // █
  });

  test('handles negative values', () => {
    const result = sparkline([-10, 0, 10]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('\u2581'); // lowest
    expect(result[2]).toBe('\u2588'); // highest
  });
});

// ---------------------------------------------------------------------------
// asciiBar
// ---------------------------------------------------------------------------

describe('asciiBar', () => {
  test('0% renders all empty blocks', () => {
    const result = asciiBar({ label: 'test', value: 0, max: 100 });
    expect(result).toContain('test');
    expect(result).toContain('0%');
    // Default width is 30 — should have 30 empty blocks
    expect(result).toContain('\u2591'.repeat(30));
    expect(result).not.toContain('\u2588');
  });

  test('100% renders all filled blocks', () => {
    const result = asciiBar({ label: 'full', value: 100, max: 100 });
    expect(result).toContain('full');
    expect(result).toContain('100%');
    // Should have 30 filled blocks
    expect(result).toContain('\u2588'.repeat(30));
    expect(result).not.toContain('\u2591');
  });

  test('50% renders half filled, half empty', () => {
    const result = asciiBar({ label: 'half', value: 50, max: 100, width: 20 });
    expect(result).toContain('50%');
    expect(result).toContain('\u2588'.repeat(10));
    expect(result).toContain('\u2591'.repeat(10));
  });

  test('value exceeding max is clamped to 100%', () => {
    const result = asciiBar({ label: 'over', value: 200, max: 100, width: 10 });
    expect(result).toContain('100%');
    expect(result).toContain('\u2588'.repeat(10));
  });

  test('max of 0 renders 0% safely', () => {
    const result = asciiBar({ label: 'zero', value: 50, max: 0 });
    expect(result).toContain('0%');
  });

  test('custom width is respected', () => {
    const result = asciiBar({ label: 'w', value: 0, max: 100, width: 5 });
    expect(result).toContain('\u2591'.repeat(5));
  });

  test('color function is applied to filled portion', () => {
    const colorFn = (s: string) => `<<${s}>>`;
    const result = asciiBar({ label: 'c', value: 50, max: 100, width: 10, color: colorFn });
    expect(result).toContain('<<' + '\u2588'.repeat(5) + '>>');
  });

  test('output format: label [bar] pct%', () => {
    const result = asciiBar({ label: 'My Label', value: 75, max: 100, width: 4 });
    expect(result).toMatch(/^My Label \[.+\] 75%$/);
  });
});

// ---------------------------------------------------------------------------
// usageChart
// ---------------------------------------------------------------------------

describe('usageChart', () => {
  test('returns empty string for empty accounts', () => {
    expect(usageChart([])).toBe('');
  });

  test('renders two bars per account (5h and 7d)', () => {
    const result = usageChart([
      { name: 'acct1', utilization5h: 0.3, utilization7d: 0.6 },
    ]);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('5h');
    expect(lines[1]).toContain('7d');
  });

  test('multiple accounts are separated by blank lines', () => {
    const result = usageChart([
      { name: 'alpha', utilization5h: 0.1, utilization7d: 0.2 },
      { name: 'beta',  utilization5h: 0.3, utilization7d: 0.4 },
    ]);
    const lines = result.split('\n');
    // alpha: 2 lines, blank separator, beta: 2 lines = 5 total
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe('');
  });

  test('no trailing blank line after last account', () => {
    const result = usageChart([
      { name: 'only', utilization5h: 0.5, utilization7d: 0.5 },
    ]);
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    // No blank line at the end
    expect(lines[lines.length - 1]).not.toBe('');
  });

  test('account names are padded to align bars', () => {
    const result = usageChart([
      { name: 'ab',   utilization5h: 0.5, utilization7d: 0.5 },
      { name: 'abcdef', utilization5h: 0.5, utilization7d: 0.5 },
    ]);
    const lines = result.split('\n').filter(l => l !== '');
    // First account name should be padded to match 'abcdef' length (6)
    expect(lines[0]).toMatch(/^ab\s{4}/);
  });

  test('correct percentage values in output', () => {
    const result = usageChart([
      { name: 'x', utilization5h: 0.25, utilization7d: 0.75 },
    ]);
    const lines = result.split('\n');
    expect(lines[0]).toContain('25%');
    expect(lines[1]).toContain('75%');
  });
});
