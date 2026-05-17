/**
 * Tests for src/billing.ts — local billing-day storage.
 *
 * Post-refactor (manual-entry only, no email scanning): only
 * `billingDay` is durable; `nextBillingDate` and `daysUntilNextBill`
 * are projected against today at read time.
 *
 * Status/plan/lastPaidAt fields remain in the type definition as
 * optional legacy fields for backwards-compat with billing.json files
 * populated by earlier versions; they are NOT exercised by displays
 * and are intentionally minimally tested.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BILLING_SCHEMA_VERSION,
  billingKey,
  readBillingFile,
  writeBillingFile,
  upsertEntry,
  removeEntry,
  getEntry,
  compareByNextBilling,
  daysUntilNextBill,
  nextBillingDate,
  projectNextBillingDate,
  type BillingEntry,
  type BillingFile,
} from '../src/billing';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweech-billing-test-'));
  return path.join(dir, 'billing.json');
}

function entry(over: Partial<BillingEntry>): BillingEntry {
  return {
    vendor: 'anthropic',
    email: 'user@example.com',
    billingDay: 24,
    updatedAt: '2026-05-17T00:00:00.000Z',
    ...over,
  };
}

describe('billingKey', () => {
  test('normalises both inputs to lowercase', () => {
    expect(billingKey('Anthropic', 'User@Example.COM')).toBe('anthropic:user@example.com');
  });
});

describe('readBillingFile / writeBillingFile', () => {
  test('missing file → empty shape, no throw', () => {
    const file = readBillingFile('/tmp/sweech-billing-does-not-exist-xyz.json');
    expect(file.schemaVersion).toBe(BILLING_SCHEMA_VERSION);
    expect(file.entries).toEqual({});
  });

  test('round-trip preserves entries', () => {
    const filePath = tmpFile();
    const original: BillingFile = {
      schemaVersion: BILLING_SCHEMA_VERSION,
      entries: { 'anthropic:a@b.c': entry({ email: 'a@b.c' }) },
    };
    writeBillingFile(original, filePath);
    const read = readBillingFile(filePath);
    expect(read.entries).toEqual(original.entries);
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  test('written file is mode 0600 (owner-only)', () => {
    const filePath = tmpFile();
    writeBillingFile({ schemaVersion: BILLING_SCHEMA_VERSION, entries: {} }, filePath);
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  test('malformed JSON → empty shape, logged to stderr', () => {
    const filePath = tmpFile();
    fs.writeFileSync(filePath, '{ not valid json');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const file = readBillingFile(filePath);
    expect(file.entries).toEqual({});
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  test('legacy entries with status/plan/source fields still read cleanly (backwards-compat)', () => {
    const filePath = tmpFile();
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: BILLING_SCHEMA_VERSION,
      entries: {
        'anthropic:a@b.c': {
          vendor: 'anthropic', email: 'a@b.c', billingDay: 11,
          status: 'active', plan: 'Max', lastPaidAt: '2026-05-11T00:00:00Z',
          nextBillingAt: '2026-06-10', source: 'mailscan',
          updatedAt: '2026-05-17T00:00:00.000Z',
        },
      },
    }));
    const file = readBillingFile(filePath);
    const e = file.entries['anthropic:a@b.c'];
    expect(e.billingDay).toBe(11);
    expect(e.status).toBe('active');
    expect(e.source).toBe('mailscan');
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });
});

describe('upsertEntry / removeEntry', () => {
  test('insert + overwrite + remove', () => {
    let file: BillingFile = { schemaVersion: BILLING_SCHEMA_VERSION, entries: {} };
    file = upsertEntry(file, entry({ vendor: 'openai', email: 'x@y.z', billingDay: 15 }));
    expect(Object.keys(file.entries)).toEqual(['openai:x@y.z']);
    file = upsertEntry(file, entry({ vendor: 'openai', email: 'x@y.z', billingDay: 22 }));
    expect(file.entries['openai:x@y.z'].billingDay).toBe(22);
    file = removeEntry(file, 'openai', 'x@y.z');
    expect(file.entries).toEqual({});
  });

  test('removeEntry no-op when missing', () => {
    const file: BillingFile = { schemaVersion: BILLING_SCHEMA_VERSION, entries: {} };
    expect(removeEntry(file, 'foo', 'bar@baz.q')).toBe(file);
  });

  test('does not mutate input file', () => {
    const file: BillingFile = { schemaVersion: BILLING_SCHEMA_VERSION, entries: {} };
    const before = JSON.stringify(file);
    upsertEntry(file, entry({}));
    expect(JSON.stringify(file)).toBe(before);
  });
});

describe('projectNextBillingDate — day-of-month forward projection', () => {
  test('today === billingDay → returns today', () => {
    const now = Date.UTC(2026, 4, 24, 12, 0, 0); // May 24 noon UTC
    expect(projectNextBillingDate(24, now)).toBe('2026-05-24');
  });

  test('today < billingDay → returns this month', () => {
    const now = Date.UTC(2026, 4, 17); // May 17
    expect(projectNextBillingDate(24, now)).toBe('2026-05-24');
  });

  test('today > billingDay → returns next month', () => {
    const now = Date.UTC(2026, 4, 28); // May 28
    expect(projectNextBillingDate(24, now)).toBe('2026-06-24');
  });

  test('billingDay=31 in a 30-day month clamps to month-end', () => {
    const now = Date.UTC(2026, 3, 15); // April 15 (April has 30 days)
    expect(projectNextBillingDate(31, now)).toBe('2026-04-30');
  });

  test('billingDay=31 in February clamps to 28/29', () => {
    const now = Date.UTC(2026, 1, 1); // Feb 1, 2026 (not a leap year)
    expect(projectNextBillingDate(31, now)).toBe('2026-02-28');
  });

  test('crosses year boundary correctly', () => {
    const now = Date.UTC(2026, 11, 20); // Dec 20
    expect(projectNextBillingDate(15, now)).toBe('2027-01-15');
  });

  test('invalid billing day returns null', () => {
    expect(projectNextBillingDate(0)).toBeNull();
    expect(projectNextBillingDate(32)).toBeNull();
    expect(projectNextBillingDate(-1)).toBeNull();
    expect(projectNextBillingDate(1.5)).toBeNull();
  });
});

describe('daysUntilNextBill', () => {
  test('positive when next bill is in the future', () => {
    const days = daysUntilNextBill(entry({ billingDay: 24 }), Date.UTC(2026, 4, 17));
    expect(days).toBe(7);
  });

  test('zero on the billing day itself', () => {
    const days = daysUntilNextBill(entry({ billingDay: 24 }), Date.UTC(2026, 4, 24, 23, 0, 0));
    expect(days).toBe(0);
  });

  test("wraps to next month when today is past this month's billing day", () => {
    const days = daysUntilNextBill(entry({ billingDay: 24 }), Date.UTC(2026, 4, 28));
    expect(days).toBe(27); // May 28 → June 24
  });

  test('null when billingDay is null', () => {
    expect(daysUntilNextBill(entry({ billingDay: null }))).toBeNull();
  });

  test('null when billingDay is out of range', () => {
    expect(daysUntilNextBill(entry({ billingDay: 99 }))).toBeNull();
  });
});

describe('nextBillingDate convenience wrapper', () => {
  test("matches projectNextBillingDate for the entry's billingDay", () => {
    const now = Date.UTC(2026, 4, 17);
    const e = entry({ billingDay: 24 });
    expect(nextBillingDate(e, now)).toBe('2026-05-24');
  });

  test('null when no billingDay', () => {
    expect(nextBillingDate(entry({ billingDay: null }))).toBeNull();
  });
});

describe('compareByNextBilling', () => {
  test('sorts by next-bill date ascending', () => {
    const now = Date.UTC(2026, 4, 17); // May 17
    const arr = [
      entry({ vendor: 'a', billingDay: 28 }),
      entry({ vendor: 'b', billingDay: 20 }),
      entry({ vendor: 'c', billingDay: 24 }),
    ];
    arr.sort((x, y) => compareByNextBilling(x, y, now));
    expect(arr.map(e => e.vendor)).toEqual(['b', 'c', 'a']);
  });

  test('entries with no billingDay sink to the end', () => {
    const arr = [
      entry({ vendor: 'a', billingDay: null }),
      entry({ vendor: 'b', billingDay: 20 }),
    ];
    arr.sort((x, y) => compareByNextBilling(x, y));
    expect(arr.map(e => e.vendor)).toEqual(['b', 'a']);
  });
});

describe('getEntry', () => {
  test('returns the entry when present', () => {
    const e = entry({});
    const file: BillingFile = {
      schemaVersion: BILLING_SCHEMA_VERSION,
      entries: { [billingKey(e.vendor, e.email)]: e },
    };
    expect(getEntry(file, e.vendor, e.email)).toEqual(e);
  });

  test('returns null when missing', () => {
    const file: BillingFile = { schemaVersion: BILLING_SCHEMA_VERSION, entries: {} };
    expect(getEntry(file, 'a', 'b@c.d')).toBeNull();
  });

  test('case-insensitive on vendor and email', () => {
    const e = entry({ vendor: 'anthropic', email: 'A@B.C' });
    const file: BillingFile = {
      schemaVersion: BILLING_SCHEMA_VERSION,
      entries: { [billingKey(e.vendor, e.email)]: e },
    };
    expect(getEntry(file, 'ANTHROPIC', 'a@b.c')).not.toBeNull();
  });
});
