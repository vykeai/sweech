/**
 * Token / credential expiry formatter.
 *
 * Single source of truth for "expires in Nm/Nh/Nd" countdown rendering.
 * Returns bare countdown text + a color hint — callers decide whether to
 * attach a 🔑 glyph, dim/yellow/red chalk, brackets, etc.
 *
 * Buckets:
 *   undefined  → { text: '',           short: '',        color: null   }
 *   past       → { text: 'expired',    short: 'expired', color: 'red'  }
 *   < 1 hour   → { text: 'expires in 42m', short: '42m', color: 'yellow' }
 *   < 24 hours → { text: 'expires in 2h',  short: '2h',  color: 'dim'    }
 *   < 30 days  → { text: 'expires in 3d',  short: '3d',  color: 'dim'    }
 *   ≥ 30 days  → { text: 'expires in Nd',  short: 'Nd',  color: 'dim'    }
 *
 * We intentionally keep "Nd" for anything ≥ 30 days rather than switching to
 * "Nmo" — months are ambiguous (28/29/30/31 days) and a 60d countdown reads
 * the same way as a 5d countdown; consistency beats brevity at this range.
 * If the duration exceeds 999 days we clamp to '999d' so the column width
 * stays bounded (shouldn't happen for OAuth tokens but cheap to guard).
 *
 * `short` form omits the "expires in " prefix for compact contexts like
 * vault account lines where a 🔑 glyph already conveys "this is an expiry".
 */

export type ExpiryColor = 'red' | 'yellow' | 'dim' | null;

export interface ExpiryFormat {
  /** Full text: "expired" | "expires in 42m" | "expires in 2h" | "expires in 3d" | "" */
  text: string;
  /** Compact form without "expires in " prefix: "expired" | "42m" | "2h" | "3d" | "" */
  short: string;
  /** Suggested chalk color hint; callers may override. */
  color: ExpiryColor;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function formatExpiry(
  expiresAtMs: number | undefined,
  now: number = Date.now()
): ExpiryFormat {
  if (expiresAtMs === undefined || expiresAtMs === null || !Number.isFinite(expiresAtMs)) {
    return { text: '', short: '', color: null };
  }

  const remaining = expiresAtMs - now;

  if (remaining <= 0) {
    return { text: 'expired', short: 'expired', color: 'red' };
  }

  // < 1 hour → minutes (rounded). At the boundary (exactly 60min) we fall
  // through to the hours bucket so we never render "expires in 60m". If
  // rounding from 59.5min pushes us up to 60 we clamp to 59 for the same
  // reason.
  if (remaining < HOUR_MS) {
    const raw = Math.max(1, Math.round(remaining / 60_000));
    const minutes = raw >= 60 ? 59 : raw;
    return {
      text: `expires in ${minutes}m`,
      short: `${minutes}m`,
      color: 'yellow',
    };
  }

  // < 24 hours → hours (rounded). At the boundary (exactly 24h) we fall
  // through to the days bucket.
  if (remaining < DAY_MS) {
    const hours = Math.max(1, Math.round(remaining / HOUR_MS));
    // Guard against rounding pushing us up to 24h when we're really at 23.5h.
    const clamped = hours >= 24 ? 23 : hours;
    return {
      text: `expires in ${clamped}h`,
      short: `${clamped}h`,
      color: 'dim',
    };
  }

  // ≥ 24 hours → days (rounded, clamped to 999 to bound column width).
  const days = Math.min(999, Math.max(1, Math.round(remaining / DAY_MS)));
  return {
    text: `expires in ${days}d`,
    short: `${days}d`,
    color: 'dim',
  };
}
