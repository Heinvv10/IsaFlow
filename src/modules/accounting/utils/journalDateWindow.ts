/**
 * The dates a tenant may hand the ledger: a calendar day from 1900-01-01 to 2199-12-31.
 *
 * Postgres accepts far more — 5- to 7-digit years ('100000-01-01') and BC dates — and a journal dated in one of them
 * numbers under its own year's key (EXTRACT(YEAR FROM entry_date)). A GL import naming 2000 such years held 2021
 * advisory locks (sec-numrace S2). Refused where a tenant supplies the date: GL import, statement imports, the manual
 * and classified bank-line routes, a reclassification's posting_date.
 *
 * The forms those paths took before the window still pass, normalised to the day Postgres stores (`ledgerDay`): an ISO
 * day with an optional time ('2025-03-31T00:00:00' — the date part, as a date cast takes it), 'YYYY/M/D', 'M/D/YYYY'
 * (Postgres's MDY and JavaScript's reading) and a month name ('March 31, 2025', '31 March 2025').
 */
import { fmtDate } from '@/lib/fmtDate';

export const JOURNAL_DATE_MIN = '1900-01-01';
export const JOURNAL_DATE_MAX = '2199-12-31';

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?'
  + '|nov(?:ember)?|dec(?:ember)?)';
const OTHER_DAY = [
  /^\d{4}\/\d{1,2}\/\d{1,2}$/,
  /^\d{1,2}\/\d{1,2}\/\d{4}$/,
  new RegExp(`^${MONTH} \\d{1,2},? \\d{4}$`, 'i'),
  new RegExp(`^\\d{1,2} ${MONTH},? \\d{4}$`, 'i'),
];

/** The YYYY-MM-DD day `input` names (see the header), or null when it is none of those forms. Not range-checked. */
export function ledgerDay(input: string): string | null {
  const s = input.trim();
  const iso = ISO_DAY.exec(s);
  if (iso) return iso[1]!;
  if (!OTHER_DAY.some((re) => re.test(s))) return null;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : fmtDate(parsed);
}

/** Why `date` cannot be a ledger date, or null when its `ledgerDay` is a real day inside the window. */
export function journalDateWindowError(date: string): string | null {
  const day = ledgerDay(date);
  if (!day) return `Invalid date "${date}" — expected YYYY-MM-DD`;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    return `Invalid date "${date}" — not a calendar day`;
  }
  if (day < JOURNAL_DATE_MIN || day > JOURNAL_DATE_MAX) {
    return `Date ${day} is outside ${JOURNAL_DATE_MIN} to ${JOURNAL_DATE_MAX}`;
  }
  return null;
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
