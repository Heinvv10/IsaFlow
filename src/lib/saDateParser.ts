/**
 * Parse a typed South African date to ISO 'YYYY-MM-DD', once, at the form boundary. It only PARSES:
 * what the user sees comes from the canonical formatters in `@/utils/dateFormat`.
 *
 * Accepts "1 Oct 2026", "01 October 2026", "2026-10-01", "01/10/2026" (day first, never month first),
 * "1 Oct" (this year), Afrikaans month names ("1 Okt 2026", "Mei", "Maart") and the shortcuts `t` / `today`,
 * `+30` / `-7` (days from today) and `eom` (end of this month). A two-digit year is read in the window
 * [now - 79, now + 20]: "01/10/46" is 2046 and "01/10/47" is 1947 when it is 2026.
 *
 * "Today" is the calendar day in Africa/Johannesburg (`todayInSast`), not the device's: a laptop set to
 * another zone, or a server in UTC, still gets the South African date at 23:30 SAST.
 */
import { addDaysISO, localDateFromISO } from '@/lib/dateUtils';

export type DateParseCode = 'empty' | 'format' | 'invalid' | 'range';

export type DateParseResult =
  | { ok: true; iso: string }
  | { ok: false; code: DateParseCode; reason: string };

/** English then Afrikaans names per month; a typed name matches when it is 3+ letters of the start of one. */
const MONTH_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['january', 'januarie'], ['february', 'februarie'], ['march', 'maart'], ['april', 'april'],
  ['may', 'mei'], ['june', 'junie'], ['july', 'julie'], ['august', 'augustus'],
  ['september', 'september'], ['october', 'oktober'], ['november', 'november'], ['december', 'desember'],
];
const MONTH_EXTRA: Readonly<Record<string, number>> = { sept: 9, mrt: 3 };
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const MAX_OFFSET_DAYS = 365 * 200;
const SAST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
});

const fail = (code: DateParseCode, reason: string): DateParseResult => ({ ok: false, code, reason });

/** The calendar day in South Africa at instant `now`, as 'YYYY-MM-DD'. */
export function todayInSast(now: Date = new Date()): string {
  return SAST_DAY.format(now);
}

/** Month number 1-12 from "oct", "Okt", "october", "sept", "mrt"; null when not a month. */
function monthFromName(name: string): number | null {
  const n = name.toLowerCase();
  if (MONTH_EXTRA[n] !== undefined) return MONTH_EXTRA[n] ?? null;
  if (n.length < 3) return null;
  const idx = MONTH_NAMES.findIndex((names) => names.some((m) => m.startsWith(n)));
  return idx >= 0 ? idx + 1 : null;
}

function build(year: number, month: number, day: number, shown: string): DateParseResult {
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return fail('range', `The year must be between ${MIN_YEAR} and ${MAX_YEAR}.`);
  }
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return fail('invalid', `"${shown}" is not a real calendar date.`);
  }
  return { ok: true, iso: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

/** 2026 + "46" is 2046; "47" is 1947 (more than 20 years ahead reads as the last century). */
function expandYear(y: string, thisYear: number): number {
  if (y.length !== 2) return Number(y);
  const candidate = 2000 + Number(y);
  return candidate > thisYear + 20 ? candidate - 100 : candidate;
}

function endOfMonthISO(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return `${iso.slice(0, 8)}${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

export function parseSaDate(input: string, now: Date = new Date()): DateParseResult {
  const shown = input.trim();
  const s = shown.toLowerCase().replace(/\s+/g, ' ');
  if (s === '') return fail('empty', 'Enter a date.');
  const formatHelp = `"${shown}" is not a date. Try 01 Oct 2026, 2026-10-01 or 01/10/2026 (day first).`;
  const today = todayInSast(now);
  const thisYear = Number(today.slice(0, 4));

  if (s === 't' || s === 'today') return { ok: true, iso: today };
  if (s === 'eom') return { ok: true, iso: endOfMonthISO(today) };

  const offset = /^([+-])(\d+)$/.exec(s);
  if (offset) {
    const days = Number(offset[2]) * (offset[1] === '-' ? -1 : 1);
    if (Math.abs(days) > MAX_OFFSET_DAYS) return fail('range', 'That is too many days from today.');
    return { ok: true, iso: addDaysISO(today, days) };
  }

  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]), shown);

  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s);
  if (numeric) return build(expandYear(numeric[3] ?? '', thisYear), Number(numeric[2]), Number(numeric[1]), shown);

  const dayFirst = /^(\d{1,2})[ -]([a-z]{3,9})(?:[ -](\d{4}|\d{2}))?$/.exec(s);
  if (dayFirst) {
    const month = monthFromName(dayFirst[2] ?? '');
    if (month === null) return fail('format', formatHelp);
    const year = dayFirst[3] ? expandYear(dayFirst[3], thisYear) : thisYear;
    return build(year, month, Number(dayFirst[1]), shown);
  }

  const monthFirst = /^([a-z]{3,9}) (\d{1,2}),? (\d{4})$/.exec(s);
  if (monthFirst) {
    const month = monthFromName(monthFirst[1] ?? '');
    if (month === null) return fail('format', formatHelp);
    return build(Number(monthFirst[3]), month, Number(monthFirst[2]), shown);
  }

  return fail('format', formatHelp);
}

/** Throw a RangeError unless `iso` is a real 'YYYY-MM-DD' (a bound such as minDate must not be guessed at). */
export function assertISODate(iso: string, name: string): void {
  if (localDateFromISO(iso) === null) throw new RangeError(`${name} must be a real YYYY-MM-DD date, got "${iso}"`);
}
