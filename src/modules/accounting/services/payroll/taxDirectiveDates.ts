/**
 * A real calendar date written YYYY-MM-DD (rejects 2026-02-30) that SARS could
 * have issued a directive on: from 2000 to today (tomorrow in UTC, so a
 * South African "today" just after midnight passes).
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return false;
  const latest = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return value >= '2000-01-01' && value <= latest;
}
