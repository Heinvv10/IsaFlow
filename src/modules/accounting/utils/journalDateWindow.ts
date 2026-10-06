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
 * (the server's DateStyle is ISO, MDY) and a month name ('March 31, 2025', '31 March 2025'). Anything else is refused,
 * including forms Postgres takes ('epoch', 'today', 'J2460000', '20250331'): refusing a form Postgres accepts is safe,
 * accepting one it would read as another day is not (numrace-date-parse.int.test.ts holds the two parsers together).
 */
export const JOURNAL_DATE_MIN = '1900-01-01';
export const JOURNAL_DATE_MAX = '2199-12-31';

// Parsed field by field, never with `new Date(string)`: JavaScript rolls '2/30/2025' over to 2 March where Postgres
// refuses it, and a check that reads a different day than the one Postgres stores is no check (parser differential).
// The time part is what a ::DATE cast ignores, bounded to what it accepts (24:00 and a :60 second included).
const TIME = '(?:[T ](?:(?:[01]?\\d|2[0-3]):[0-5]\\d(?::(?:[0-5]\\d|60)(?:\\.\\d+)?)?|24:00(?::00)?)'
  + '(?:Z|[+-]\\d{2}(?::?\\d{2})?)?)?';
const ISO = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})${TIME}$`);
const YMD_SLASH = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const MDY_SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?'
  + '|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_DAY_YEAR = new RegExp(`^${MONTH} (\\d{1,2}),? (\\d{4})$`, 'i');
const DAY_MONTH_YEAR = new RegExp(`^(\\d{1,2}) ${MONTH},? (\\d{4})$`, 'i');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const day = (y: string, m: string | number, d: string) => `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}`;
const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

/**
 * The YYYY-MM-DD day `input` names — the day Postgres (DateStyle ISO, MDY) stores for it — or null when it is none of
 * the forms in the header. Not checked for being a real day or in the window: `journalDateWindowError` does that.
 */
export function ledgerDay(input: string): string | null {
  const s = input.trim();
  let m: RegExpExecArray | null;
  if ((m = ISO.exec(s))) return day(m[1]!, m[2]!, m[3]!);
  if ((m = YMD_SLASH.exec(s))) return day(m[1]!, m[2]!, m[3]!);
  if ((m = MDY_SLASH.exec(s))) return day(m[3]!, m[1]!, m[2]!);
  if ((m = MONTH_DAY_YEAR.exec(s))) return day(m[3]!, monthOf(m[1]!), m[2]!);
  if ((m = DAY_MONTH_YEAR.exec(s))) return day(m[3]!, monthOf(m[2]!), m[1]!);
  return null;
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
