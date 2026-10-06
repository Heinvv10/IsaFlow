/**
 * The dates a tenant may hand the ledger: a day from 1900-01-01 to 2199-12-31.
 *
 * Postgres accepts far more — 5- to 7-digit years ('100000-01-01'), BC dates, 'infinity' — and a journal dated in one
 * of them numbers under its own year's key (EXTRACT(YEAR FROM entry_date), migration 857). A GL import naming 2000 such
 * years held 2000+ advisory locks in the cluster-wide lock table (sec-numrace S2).
 *
 * The day checked is the day stored. A path that writes a tenant's date lets POSTGRES read it — `::date`, as its
 * INSERT would (gl/journalDateGuard) — checks the day that cast returns, and stores that day; a string Postgres cannot
 * cast fails exactly as it did before the window. Only the statement parsers, which have no database, check here in
 * JavaScript, and only their own YYYY-MM-DD output.
 */
export const JOURNAL_DATE_MIN = '1900-01-01';
export const JOURNAL_DATE_MAX = '2199-12-31';

/**
 * Why `day` — the text of a `::date` (YYYY-MM-DD, a 5+ digit year, '… BC', 'infinity') — is not a ledger date, or
 * null when it is one.
 */
export function journalDayWindowError(day: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= JOURNAL_DATE_MIN && day <= JOURNAL_DATE_MAX) return null;
  return `Date ${day} is outside ${JOURNAL_DATE_MIN} to ${JOURNAL_DATE_MAX}`;
}

/** A statement parser's own Y-M-D output (any year width): its window error. Other shapes are left to Postgres. */
export function parsedDayWindowError(date: string): string | null {
  return /^\d+-\d{2}-\d{2}$/.test(date) ? journalDayWindowError(date) : null;
}

/**
 * A journal dated outside the window, refused where it is created (gl/journalDateGuard, sec-numrace S4). `preWrite`:
 * the request transaction had written nothing when it was raised — only then is a 4xx safe (withAuth COMMITs below 500).
 */
export class JournalDateRefusedError extends Error {
  readonly code = 'JOURNAL_DATE_REFUSED';
  constructor(reason: string, readonly preWrite: boolean) {
    super(`This journal cannot be posted: ${reason}.`);
    this.name = 'JournalDateRefusedError';
  }
}

export function isJournalDateRefused(err: unknown): err is JournalDateRefusedError {
  return err instanceof Error && (err as { code?: unknown }).code === 'JOURNAL_DATE_REFUSED';
}
