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
 */
export function isRealCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, mo, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function safeInt(value: unknown, fallback: number, max = 1000): number {
  const n = parseInt(String(value), 10);
  return isNaN(n) ? fallback : Math.min(Math.max(n, 1), max);
}
