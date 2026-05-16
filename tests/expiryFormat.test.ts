/**
 * Tests for src/expiryFormat — unified token expiry countdown formatter.
 */

import { formatExpiry } from '../src/expiryFormat';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatExpiry', () => {
  const NOW = 1_700_000_000_000;

  describe('undefined / null / non-finite', () => {
    test('undefined → empty', () => {
      expect(formatExpiry(undefined, NOW)).toEqual({ text: '', short: '', color: null });
    });

    test('null → empty (defensive)', () => {
      // Some callers pass null when the property is missing.
      expect(formatExpiry(null as unknown as undefined, NOW)).toEqual({ text: '', short: '', color: null });
    });

    test('NaN → empty', () => {
      expect(formatExpiry(NaN, NOW)).toEqual({ text: '', short: '', color: null });
    });

    test('Infinity → empty', () => {
      expect(formatExpiry(Infinity, NOW)).toEqual({ text: '', short: '', color: null });
    });
  });

  describe('past / expired', () => {
    test('just past (1ms ago) → expired/red', () => {
      const r = formatExpiry(NOW - 1, NOW);
      expect(r).toEqual({ text: 'expired', short: 'expired', color: 'red' });
    });

    test('exactly now (remaining = 0) → expired/red', () => {
      const r = formatExpiry(NOW, NOW);
      expect(r).toEqual({ text: 'expired', short: 'expired', color: 'red' });
    });

    test('expired hours ago → expired/red', () => {
      const r = formatExpiry(NOW - 5 * HOUR, NOW);
      expect(r).toEqual({ text: 'expired', short: 'expired', color: 'red' });
    });
  });

  describe('< 1 hour (minutes, yellow)', () => {
    test('1 minute remaining', () => {
      const r = formatExpiry(NOW + MIN, NOW);
      expect(r).toEqual({ text: 'expires in 1m', short: '1m', color: 'yellow' });
    });

    test('30 seconds remaining → rounds up to 1m', () => {
      const r = formatExpiry(NOW + 30_000, NOW);
      expect(r).toEqual({ text: 'expires in 1m', short: '1m', color: 'yellow' });
    });

    test('42 minutes remaining', () => {
      const r = formatExpiry(NOW + 42 * MIN, NOW);
      expect(r).toEqual({ text: 'expires in 42m', short: '42m', color: 'yellow' });
    });

    test('59 minutes remaining', () => {
      const r = formatExpiry(NOW + 59 * MIN, NOW);
      expect(r).toEqual({ text: 'expires in 59m', short: '59m', color: 'yellow' });
    });

    test('59.4 minutes remaining → 59m', () => {
      const r = formatExpiry(NOW + 59.4 * MIN, NOW);
      expect(r).toEqual({ text: 'expires in 59m', short: '59m', color: 'yellow' });
    });

    test('59.5 minutes remaining → clamp to 59m (avoid "60m")', () => {
      const r = formatExpiry(NOW + 59.5 * MIN, NOW);
      expect(r).toEqual({ text: 'expires in 59m', short: '59m', color: 'yellow' });
    });
  });

  describe('boundary: 60 minutes = 1 hour', () => {
    test('exactly 60m → hours bucket (1h, dim)', () => {
      const r = formatExpiry(NOW + 60 * MIN, NOW);
      expect(r).toEqual({ text: 'expires in 1h', short: '1h', color: 'dim' });
    });
  });

  describe('< 24 hours (hours, dim)', () => {
    test('1 hour exactly', () => {
      const r = formatExpiry(NOW + HOUR, NOW);
      expect(r).toEqual({ text: 'expires in 1h', short: '1h', color: 'dim' });
    });

    test('2 hours', () => {
      const r = formatExpiry(NOW + 2 * HOUR, NOW);
      expect(r).toEqual({ text: 'expires in 2h', short: '2h', color: 'dim' });
    });

    test('23 hours', () => {
      const r = formatExpiry(NOW + 23 * HOUR, NOW);
      expect(r).toEqual({ text: 'expires in 23h', short: '23h', color: 'dim' });
    });

    test('23.4 hours → 23h', () => {
      const r = formatExpiry(NOW + 23.4 * HOUR, NOW);
      expect(r).toEqual({ text: 'expires in 23h', short: '23h', color: 'dim' });
    });

    test('23.9 hours → clamp to 23h (avoid "24h")', () => {
      const r = formatExpiry(NOW + 23.9 * HOUR, NOW);
      expect(r).toEqual({ text: 'expires in 23h', short: '23h', color: 'dim' });
    });
  });

  describe('boundary: 24 hours = 1 day', () => {
    test('exactly 24h → days bucket (1d, dim)', () => {
      const r = formatExpiry(NOW + 24 * HOUR, NOW);
      expect(r).toEqual({ text: 'expires in 1d', short: '1d', color: 'dim' });
    });
  });

  describe('days (dim)', () => {
    test('1 day exactly', () => {
      const r = formatExpiry(NOW + DAY, NOW);
      expect(r).toEqual({ text: 'expires in 1d', short: '1d', color: 'dim' });
    });

    test('3 days', () => {
      const r = formatExpiry(NOW + 3 * DAY, NOW);
      expect(r).toEqual({ text: 'expires in 3d', short: '3d', color: 'dim' });
    });

    test('29 days', () => {
      const r = formatExpiry(NOW + 29 * DAY, NOW);
      expect(r).toEqual({ text: 'expires in 29d', short: '29d', color: 'dim' });
    });

    test('30 days', () => {
      const r = formatExpiry(NOW + 30 * DAY, NOW);
      expect(r).toEqual({ text: 'expires in 30d', short: '30d', color: 'dim' });
    });

    test('90 days (stays in days, no months unit)', () => {
      const r = formatExpiry(NOW + 90 * DAY, NOW);
      expect(r).toEqual({ text: 'expires in 90d', short: '90d', color: 'dim' });
    });

    test('500 days', () => {
      const r = formatExpiry(NOW + 500 * DAY, NOW);
      expect(r).toEqual({ text: 'expires in 500d', short: '500d', color: 'dim' });
    });

    test('clamp at 999d for absurdly large values', () => {
      const r = formatExpiry(NOW + 5000 * DAY, NOW);
      expect(r).toEqual({ text: 'expires in 999d', short: '999d', color: 'dim' });
    });
  });

  describe('uses Date.now() when `now` omitted', () => {
    test('default now argument', () => {
      const r = formatExpiry(Date.now() + 5 * MIN);
      // Allow either 5m or (in case of very slow CI) 4m — but it must be a
      // minutes-bucket yellow result.
      expect(r.color).toBe('yellow');
      expect(r.text).toMatch(/^expires in [45]m$/);
      expect(r.short).toMatch(/^[45]m$/);
    });
  });
});
