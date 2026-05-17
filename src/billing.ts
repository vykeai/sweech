/**
 * Sweech billing data — per-account billing-day storage.
 *
 * Vendor APIs (Anthropic, OpenAI, …) do not expose subscription
 * expiry. Sweech tracks ONLY the day-of-month the user is billed —
 * a fact the user enters manually via `sweech billing set`.
 *
 * Sweech does NOT scan email, infer status (canceled / will_not_renew),
 * or pull billing data from any other source. The user is the source
 * of truth. If you want automatic email-scanning, run the standalone
 * `mailscan` CLI yourself and feed its output into `sweech billing set`.
 *
 * Display contract: every surface shows ONLY the projected next-bill
 * date (computed from billingDay against today). Status fields (kept
 * in storage for backwards-compat with billing.json files populated
 * by earlier versions) NEVER appear in CLI/SweechBar UI.
 *
 * The storage is intentionally a separate file from the vault
 * (`accounts.json`) so the vault stays auth-only.
 *
 * Schema: `sweech.billing.v1`. The only load-bearing field is
 * `billingDay` (1-31); everything else is diagnostic or legacy.
 * Key: `<vendor>:<email>` lowercased.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from './atomicWrite';

// ── Constants ────────────────────────────────────────────────────────

const SWEECH_DIR = path.join(os.homedir(), '.sweech');
const BILLING_FILE = path.join(SWEECH_DIR, 'billing.json');

/** Current schema version — bump on breaking shape changes. */
export const BILLING_SCHEMA_VERSION = 'sweech.billing.v1' as const;

// ── Types ────────────────────────────────────────────────────────────

export type BillingStatus =
  | 'active'
  | 'will_not_renew'
  | 'canceled'
  | 'unknown';

export interface BillingEntry {
  /** Lowercased vendor id (e.g. 'anthropic'). */
  vendor: string;
  /** Lowercased recipient email. */
  email: string;
  /**
   * Day-of-month (1-31) the user gets charged. **The single load-bearing
   * field** — every display projects the next-bill date from this against
   * today's calendar. Required for any meaningful display.
   */
  billingDay: number | null;
  /** ISO-8601 when this entry was last written. */
  updatedAt: string;
  /** Optional free-text note. */
  note?: string;

  // ── Legacy / diagnostic fields ───────────────────────────────────
  // Populated by the (now-removed) email scan integration. Kept in
  // storage for backwards-compat with older billing.json files but
  // NEVER displayed — see file header for the reasoning.
  /** @deprecated UI does not render status — user manages subscription state out-of-band. */
  status?: BillingStatus;
  /** @deprecated UI does not render plan from billing — vault carries plan label. */
  plan?: string | null;
  /** @deprecated UI computes next-bill from billingDay; lastPaidAt is informational only. */
  lastPaidAt?: string | null;
  /** @deprecated stored value can drift; UI computes from billingDay + today. */
  nextBillingAt?: string | null;
  /** @deprecated sweech only writes 'manual' now; old entries may carry 'mailscan'. */
  source?: 'mailscan' | 'manual' | 'merged';
}

export interface BillingFile {
  schemaVersion: typeof BILLING_SCHEMA_VERSION;
  /** Map keyed by `<vendor>:<email>`. */
  entries: Record<string, BillingEntry>;
  /** ISO-8601 of the last scan operation, when scan-derived. */
  lastScannedAt?: string;
}

// ── Storage I/O ──────────────────────────────────────────────────────

/** Compose the storage key. Both inputs are normalised to lowercase. */
export function billingKey(vendor: string, email: string): string {
  return `${vendor.toLowerCase()}:${email.toLowerCase()}`;
}

function emptyFile(): BillingFile {
  return { schemaVersion: BILLING_SCHEMA_VERSION, entries: {} };
}

/**
 * Read the billing file. Returns an empty shape when missing or
 * malformed — billing is non-critical data, never throw out of the
 * CLI path because a JSON parse failed. A malformed file is logged
 * to stderr once so the user can fix it.
 */
export function readBillingFile(filePath: string = BILLING_FILE): BillingFile {
  if (!fs.existsSync(filePath)) return emptyFile();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BillingFile>;
    if (!parsed || typeof parsed !== 'object') return emptyFile();
    if (parsed.schemaVersion !== BILLING_SCHEMA_VERSION) {
      // Future-proof: if we ever rev the schema, migrate here. For now
      // refuse to merge an unknown schema rather than corrupting data.
      // eslint-disable-next-line no-console
      console.error(`sweech: ${filePath} has unknown schemaVersion '${String(parsed.schemaVersion)}' — ignoring`);
      return emptyFile();
    }
    return {
      schemaVersion: BILLING_SCHEMA_VERSION,
      entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
      lastScannedAt: typeof parsed.lastScannedAt === 'string' ? parsed.lastScannedAt : undefined,
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`sweech: failed to read ${filePath} (${e instanceof Error ? e.message : String(e)}) — using empty`);
    return emptyFile();
  }
}

/**
 * Atomically write the billing file (no torn-write window). Uses 0o600
 * so the file is owner-readable only — same posture as the vault, even
 * though billing data is metadata not secrets. Belt and braces.
 */
export function writeBillingFile(file: BillingFile, filePath: string = BILLING_FILE): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(filePath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

// ── Mutators (pure-ish — return new file shape rather than mutating in place) ─

export interface UpsertOptions {
  /** When true, never overwrite a `source: 'manual'` entry — manual
   * inputs are authoritative against scan results. */
  preserveManual?: boolean;
}

export function upsertEntry(file: BillingFile, entry: BillingEntry, opts: UpsertOptions = {}): BillingFile {
  const key = billingKey(entry.vendor, entry.email);
  const existing = file.entries[key];
  if (opts.preserveManual && existing && existing.source === 'manual' && entry.source !== 'manual') {
    return file;
  }
  return {
    ...file,
    entries: {
      ...file.entries,
      [key]: { ...entry, updatedAt: entry.updatedAt || new Date().toISOString() },
    },
  };
}

export function removeEntry(file: BillingFile, vendor: string, email: string): BillingFile {
  const key = billingKey(vendor, email);
  if (!(key in file.entries)) return file;
  const next = { ...file.entries };
  delete next[key];
  return { ...file, entries: next };
}

// ── Date math (computed from billingDay) ─────────────────────────────

/**
 * Project the next occurrence of `billingDay` against the supplied
 * "now" timestamp. Returns YYYY-MM-DD UTC. Day 31 in months with fewer
 * days clamps to the last day of that month (Anthropic/OpenAI's
 * actual Stripe behavior).
 *
 * Always projects FORWARD: if today is the 25th and billingDay is the
 * 15th, returns the 15th of NEXT month. If today is the 15th and
 * billingDay is 15, returns today.
 */
export function projectNextBillingDate(billingDay: number, now: number = Date.now()): string | null {
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31) return null;
  const today = new Date(now);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const dom = today.getUTCDate();

  const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const clamp = (y: number, m: number) => Math.min(billingDay, daysInMonth(y, m));

  // Candidate 1: this month's billing day
  const thisMonthDay = clamp(year, month);
  if (dom <= thisMonthDay) {
    return `${year}-${String(month + 1).padStart(2, '0')}-${String(thisMonthDay).padStart(2, '0')}`;
  }
  // Candidate 2: next month's billing day (wrap year if December)
  const nextMonth = (month + 1) % 12;
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonthDay = clamp(nextYear, nextMonth);
  return `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(nextMonthDay).padStart(2, '0')}`;
}

// ── Convenience reads for display ────────────────────────────────────

/**
 * Look up a billing entry by vendor + email. Returns null when missing.
 */
export function getEntry(file: BillingFile, vendor: string, email: string): BillingEntry | null {
  return file.entries[billingKey(vendor, email)] ?? null;
}

/**
 * Sort key for "next bill" displays — entries with no billingDay go
 * to the end. Among entries with a billingDay, sort by the projected
 * next-bill date.
 */
export function compareByNextBilling(a: BillingEntry, b: BillingEntry, now: number = Date.now()): number {
  const av = a.billingDay ? projectNextBillingDate(a.billingDay, now) ?? '￿' : '￿';
  const bv = b.billingDay ? projectNextBillingDate(b.billingDay, now) ?? '￿' : '￿';
  return av.localeCompare(bv);
}

/**
 * Compute days-until-next-bill from today, projected freshly from
 * `billingDay`. Returns null when no billingDay is set. The stored
 * `nextBillingAt` field (if present from legacy entries) is ignored
 * — it can drift; this computation always reflects the current month.
 */
export function daysUntilNextBill(entry: BillingEntry, now: number = Date.now()): number | null {
  if (entry.billingDay == null) return null;
  const next = projectNextBillingDate(entry.billingDay, now);
  if (!next) return null;
  const target = Date.parse(next + 'T00:00:00Z');
  if (!Number.isFinite(target)) return null;
  const startOfToday = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  return Math.floor((target - startOfToday) / (24 * 60 * 60 * 1000));
}

/**
 * Compute the next-bill date as a YYYY-MM-DD string. Convenience
 * wrapper around `projectNextBillingDate` that takes the whole entry.
 */
export function nextBillingDate(entry: BillingEntry, now: number = Date.now()): string | null {
  if (entry.billingDay == null) return null;
  return projectNextBillingDate(entry.billingDay, now);
}
