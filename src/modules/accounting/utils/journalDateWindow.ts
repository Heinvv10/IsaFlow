/**
 * The dates a tenant may hand the ledger: an ISO calendar day from 1900-01-01 to 2199-12-31.
 *
 * Postgres accepts far more — 5- to 7-digit years ('100000-01-01') and BC dates — and a journal dated in one of them
 * numbers under its own year's key (EXTRACT(YEAR FROM entry_date)). A GL import naming 2000 such years held 2021
 * advisory locks (sec-numrace S2). Refused where a tenant supplies the date: GL import, statement imports, the manual
 * and classified bank-line routes, a reclassification's posting_date.
 */
export const JOURNAL_DATE_MIN = '1900-01-01';
export const JOURNAL_DATE_MAX = '2199-12-31';

/** Why `date` cannot be a ledger date, or null when it can. */
export function journalDateWindowError(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `Invalid date "${date}" — expected YYYY-MM-DD`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return `Invalid date "${date}" — not a calendar day`;
  }
  if (date < JOURNAL_DATE_MIN || date > JOURNAL_DATE_MAX) {
    return `Date ${date} is outside ${JOURNAL_DATE_MIN} to ${JOURNAL_DATE_MAX}`;
  }
  return null;
}
