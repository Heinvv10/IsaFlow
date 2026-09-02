export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidDate(s: string): boolean {
  return DATE_RE.test(s) && !isNaN(Date.parse(s));
}

export function isValidUUID(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Strict calendar-date check for a value about to be cast in SQL (`$n::DATE`).
 * Unlike `isValidDate` above, this REJECTS an overflowing date: Date.parse
 * accepts '2026-02-31' by rolling forward to 3 March, while Postgres throws
 * 22008 on the same literal. Read paths run with no savepoint, so that error
 * aborts the whole request transaction — hence the component round-trip.
 *
 * `new Date(0)` + `setUTCFullYear` rather than `Date.UTC(y, ...)`: the latter
 * maps years 0–99 to 1900+, so `Date.UTC(1, 0, 1)` is 1901 and a legitimate
 * '0001-01-01' would be rejected.
 *
 * Year 0 is rejected outright. JavaScript has one (it is 1 BC by ISO 8601's
 * astronomical numbering, and every component round-trips cleanly), but the
 * Postgres calendar goes 1 BC → 1 AD with no year 0 at all, so '0000-01-01'
 * is a 22008 there — the one case where a clean JS round-trip still fails the
 * cast. Verified against the dev database.
 */
export function isRealCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, mo, d] = value.split('-').map(Number) as [number, number, number];
  if (y < 1) return false;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const TIMESTAMPTZ_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

/**
 * Postgres's own text rendering of a TIMESTAMPTZ (or an ISO-8601 equivalent),
 * with every component range-checked, so the value survives `$N::TIMESTAMPTZ`.
 * Digit counts are not enough: '9999-99-99T99:99:99Z' has the right shape and
 * is a 22008 at the cast — on a read path with no savepoint that aborts the
 * whole request transaction. Same contract as isRealCalendarDate.
 */
export function isRealTimestamp(value: string): boolean {
  const m = TIMESTAMPTZ_RE.exec(value);
  if (!m) return false;
  const [, date, hh, mm, ss, , tzh, tzm] = m;
  if (!isRealCalendarDate(date!)) return false;
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) return false;
  if (tzh !== undefined && (Number(tzh) > 15 || Number(tzm ?? '0') > 59)) return false;
  return true;
}

export function safeInt(value: unknown, fallback: number, max = 1000): number {
  const n = parseInt(String(value), 10);
  return isNaN(n) ? fallback : Math.min(Math.max(n, 1), max);
}
