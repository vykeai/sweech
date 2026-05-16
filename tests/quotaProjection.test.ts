/**
 * Tests for quota projection — short-window burn-rate forecasting (src/quotaProjection.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  recordProjectionSamples,
  computeProjection,
  getAccountProjection,
  formatEta,
  _setSamplesFilePath,
  _resetSamplesFilePath,
  type ProjectionSample,
  type ProjectionSamplesFile,
} from '../src/quotaProjection';
import type { AccountInfo } from '../src/subscriptions';

let tmpDir: string;
let samplesFile: string;

function makeAccount(commandName: string, u5h: number, u7d: number): AccountInfo {
  return {
    name: commandName,
    commandName,
    cliType: 'claude',
    configDir: `/mock/.${commandName}`,
    meta: {},
    messages5h: 10,
    messages7d: 50,
    totalMessages: 200,
    live: {
      buckets: [
        {
          label: 'All models',
          session: { utilization: u5h },
          weekly: { utilization: u7d },
        },
      ],
      capturedAt: Date.now(),
    },
  };
}

function readSamples(): ProjectionSamplesFile {
  return JSON.parse(fs.readFileSync(samplesFile, 'utf-8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-qp-'));
  samplesFile = path.join(tmpDir, 'quota-samples.json');
  _setSamplesFilePath(samplesFile);
});

afterEach(() => {
  _resetSamplesFilePath();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('recordProjectionSamples', () => {
  it('appends a sample per account with live data', () => {
    const accounts = [makeAccount('claude', 0.2, 0.5), makeAccount('codex', 0.0, 0.1)];
    recordProjectionSamples(accounts, 1_000_000);

    const file = readSamples();
    expect(file.version).toBe(1);
    expect(file.accounts['claude']).toHaveLength(1);
    expect(file.accounts['claude'][0]).toEqual({ ts: 1_000_000, u5h: 0.2, u7d: 0.5 });
    expect(file.accounts['codex'][0]).toEqual({ ts: 1_000_000, u5h: 0.0, u7d: 0.1 });
  });

  it('skips accounts with no live utilization', () => {
    const acc: AccountInfo = {
      name: 'empty',
      commandName: 'empty',
      cliType: 'claude',
      configDir: '/x',
      meta: {},
      messages5h: 0,
      messages7d: 0,
      totalMessages: 0,
      // no live block
    };
    recordProjectionSamples([acc]);
    expect(fs.existsSync(samplesFile)).toBe(false);
  });

  it('caps the ring buffer at MAX_SAMPLES_PER_ACCOUNT (24)', () => {
    // Pre-seed with 24 samples
    const seeded: ProjectionSample[] = Array.from({ length: 24 }, (_, i) => ({
      ts: 1_000_000 + i * 60_000,
      u5h: i / 100,
      u7d: i / 100,
    }));
    fs.writeFileSync(
      samplesFile,
      JSON.stringify({ version: 1, accounts: { claude: seeded } }),
    );
    recordProjectionSamples([makeAccount('claude', 0.99, 0.99)], 2_000_000);

    const file = readSamples();
    expect(file.accounts['claude']).toHaveLength(24);
    // Oldest (i=0) dropped, newest appended
    expect(file.accounts['claude'][0].ts).toBe(1_000_000 + 60_000);
    expect(file.accounts['claude'][23].ts).toBe(2_000_000);
    expect(file.accounts['claude'][23].u5h).toBe(0.99);
  });

  it('survives a corrupt samples file (resets to empty)', () => {
    fs.writeFileSync(samplesFile, 'not json{{{');
    recordProjectionSamples([makeAccount('claude', 0.3, 0.6)], 1_000_000);
    const file = readSamples();
    expect(file.accounts['claude']).toHaveLength(1);
  });

  it('discards poisoned samples (NaN/Infinity/out-of-range) on read', () => {
    const poisoned = {
      version: 1,
      accounts: {
        claude: [
          { ts: 1, u5h: 0.5, u7d: 0.5 },         // valid
          { ts: 'oops', u5h: 0.5, u7d: 0.5 },     // ts NaN
          { ts: 2, u5h: NaN, u7d: 0.5 },          // NaN
          { ts: 3, u5h: Infinity, u7d: 0.5 },     // Infinity
          { ts: 4, u5h: 1.5, u7d: 0.5 },          // out of range
          { ts: 5, u5h: -0.1, u7d: 0.5 },         // negative
          { ts: 6, u5h: 0.3, u7d: 0.3 },          // valid
        ],
      },
    };
    fs.writeFileSync(samplesFile, JSON.stringify(poisoned));
    recordProjectionSamples([makeAccount('claude', 0.4, 0.4)], 7);
    const file = readSamples();
    // Only the two valid pre-existing samples + new one = 3
    expect(file.accounts['claude']).toHaveLength(3);
    expect(file.accounts['claude'].every((s: ProjectionSample) =>
      Number.isFinite(s.ts) && s.u5h >= 0 && s.u5h <= 1
    )).toBe(true);
  });

  it('chmods 0o600 on write (POSIX only — skip on win32)', () => {
    if (process.platform === 'win32') return;
    recordProjectionSamples([makeAccount('claude', 0.2, 0.5)], 1_000_000);
    const mode = fs.statSync(samplesFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('computeProjection', () => {
  it('returns null with fewer than 3 samples', () => {
    expect(computeProjection([], 'u7d')).toBeNull();
    expect(computeProjection([{ ts: 0, u5h: 0, u7d: 0 }], 'u7d')).toBeNull();
    expect(
      computeProjection(
        [
          { ts: 0, u5h: 0, u7d: 0 },
          { ts: 60_000, u5h: 0.1, u7d: 0.1 },
        ],
        'u7d',
      ),
    ).toBeNull();
  });

  it('returns null when all samples are older than the 60-minute window', () => {
    const now = 10_000_000;
    const samples: ProjectionSample[] = [
      { ts: now - 4 * 60 * 60_000, u5h: 0.1, u7d: 0.1 },
      { ts: now - 3.5 * 60 * 60_000, u5h: 0.2, u7d: 0.2 },
      { ts: now - 3 * 60 * 60_000, u5h: 0.3, u7d: 0.3 },
    ];
    expect(computeProjection(samples, 'u7d', now)).toBeNull();
  });

  it('linear rate: 0%→50% over 30min ⇒ rate=0.0166/min, ETA to 100% ~30min', () => {
    const now = 10_000_000;
    const samples: ProjectionSample[] = [
      { ts: now - 30 * 60_000, u5h: 0.0, u7d: 0.0 },
      { ts: now - 15 * 60_000, u5h: 0.25, u7d: 0.25 },
      { ts: now,               u5h: 0.5, u7d: 0.5 },
    ];
    const p = computeProjection(samples, 'u7d', now);
    expect(p).not.toBeNull();
    expect(p!.rateUtilPerMinute).toBeCloseTo(0.5 / 30, 4);
    expect(p!.etaToFullMinutes).toBeCloseTo(30, 0);
    expect(p!.sampleCount).toBe(3);
  });

  it('flat rate: utilization not changing ⇒ etaToFullMinutes is null', () => {
    const now = 10_000_000;
    const samples: ProjectionSample[] = [
      { ts: now - 20 * 60_000, u5h: 0.3, u7d: 0.3 },
      { ts: now - 10 * 60_000, u5h: 0.3, u7d: 0.3 },
      { ts: now,               u5h: 0.3, u7d: 0.3 },
    ];
    const p = computeProjection(samples, 'u7d', now)!;
    expect(p.rateUtilPerMinute).toBe(0);
    expect(p.etaToFullMinutes).toBeNull();
  });

  it('falling rate (negative) ⇒ etaToFullMinutes is null, rate negative', () => {
    const now = 10_000_000;
    const samples: ProjectionSample[] = [
      { ts: now - 20 * 60_000, u5h: 0.6, u7d: 0.6 },
      { ts: now - 10 * 60_000, u5h: 0.5, u7d: 0.5 },
      { ts: now,               u5h: 0.4, u7d: 0.4 },
    ];
    const p = computeProjection(samples, 'u7d', now)!;
    expect(p.rateUtilPerMinute).toBeLessThan(0);
    expect(p.etaToFullMinutes).toBeNull();
  });

  it('already saturated ⇒ etaToFullMinutes is null (canonical "no projection")', () => {
    const now = 10_000_000;
    const samples: ProjectionSample[] = [
      { ts: now - 20 * 60_000, u5h: 0.9, u7d: 0.9 },
      { ts: now - 10 * 60_000, u5h: 0.95, u7d: 0.95 },
      { ts: now,               u5h: 1.0, u7d: 1.0 },
    ];
    const p = computeProjection(samples, 'u7d', now)!;
    expect(p.etaToFullMinutes).toBeNull();
    expect(p.rateUtilPerMinute).toBeGreaterThan(0);
  });

  it('drops samples outside the 60-minute window when counting', () => {
    const now = 10_000_000;
    const samples: ProjectionSample[] = [
      { ts: now - 120 * 60_000, u5h: 0.0, u7d: 0.0 },   // outside
      { ts: now - 90 * 60_000, u5h: 0.1, u7d: 0.1 },    // outside
      { ts: now - 30 * 60_000, u5h: 0.2, u7d: 0.2 },    // inside
      { ts: now - 15 * 60_000, u5h: 0.3, u7d: 0.3 },    // inside
      { ts: now,                u5h: 0.4, u7d: 0.4 },   // inside
    ];
    const p = computeProjection(samples, 'u7d', now)!;
    expect(p.sampleCount).toBe(3);
    // rate = (0.4 - 0.2) / 30 min = 0.00667/min
    expect(p.rateUtilPerMinute).toBeCloseTo(0.2 / 30, 4);
  });
});

describe('getAccountProjection', () => {
  it('returns null projections when no samples for that account', () => {
    const p = getAccountProjection('claude');
    expect(p.projection5h).toBeNull();
    expect(p.projection7d).toBeNull();
  });

  it('returns 5h and 7d projections independently', () => {
    const now = 10_000_000;
    fs.writeFileSync(
      samplesFile,
      JSON.stringify({
        version: 1,
        accounts: {
          claude: [
            { ts: now - 30 * 60_000, u5h: 0.5, u7d: 0.1 },
            { ts: now - 15 * 60_000, u5h: 0.7, u7d: 0.1 },
            { ts: now,                u5h: 0.9, u7d: 0.1 },
          ],
        },
      }),
    );
    const p = getAccountProjection('claude', now);
    expect(p.projection5h).not.toBeNull();
    expect(p.projection5h!.rateUtilPerMinute).toBeGreaterThan(0);
    expect(p.projection7d).not.toBeNull();
    expect(p.projection7d!.rateUtilPerMinute).toBe(0);
    expect(p.projection7d!.etaToFullMinutes).toBeNull();
  });
});

describe('formatEta', () => {
  it('null → empty string', () => {
    expect(formatEta(null)).toBe('');
  });
  it('0 minutes → "full"', () => {
    expect(formatEta(0)).toBe('full');
  });
  it('<60 minutes → "Nm"', () => {
    expect(formatEta(47)).toBe('47m');
    expect(formatEta(1)).toBe('1m');
  });
  it('clamps 59.6m to "59m" (no "60m" boundary glitch)', () => {
    expect(formatEta(59.6)).toBe('59m');
  });
  it('<24 hours → "Nh"', () => {
    expect(formatEta(60)).toBe('1h');
    expect(formatEta(180)).toBe('3h');
  });
  it('clamps 23.6h to "23h" (no "24h" boundary glitch)', () => {
    expect(formatEta(60 * 23 + 36)).toBe('23h');
  });
  it('≥24 hours → "Nd"', () => {
    expect(formatEta(60 * 24)).toBe('1d');
    expect(formatEta(60 * 24 * 3)).toBe('3d');
  });
  it('non-finite (NaN/Infinity) → empty string', () => {
    expect(formatEta(NaN)).toBe('');
    expect(formatEta(Infinity)).toBe('');
  });
});
