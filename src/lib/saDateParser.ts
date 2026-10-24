/**
 * Parse a typed South African date to ISO 'YYYY-MM-DD', once, at the form boundary.
 *
 * Accepts "1 Oct 2026", "01 October 2026", "2026-10-01", "01/10/2026" (day first, never
 * month first), "1 Oct" (this year) and the shortcuts `t` / `today`, `+30` / `-7` (days from
 * today) and `eom` (end of this month). "Today" is the LOCAL calendar day: it comes from
 * `localISODate`, so there is no UTC off-by-one after local midnight (SAST is UTC+2).
 */
import { addDaysISO, localISODate, monthEndISO } from '@/lib/dateUtils';

export type DateParseCode = 'empty' | 'format' | 'invalid' | 'range';

export type DateParseResult =
  | { ok: true; iso: string }
  | { ok: false; code: DateParseCode; reason: string };

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const MAX_OFFSET_DAYS = 365 * 200;

const fail = (code: DateParseCode, reason: string): DateParseResult => ({ ok: false, code, reason });

/** Month number 1-12 from "oct", "Oct", "october", "sept"; null when not a month. */
function monthFromName(name: string): number | null {
  const n = name.toLowerCase();
  if (n.length < 3) return null;
  const idx = MONTHS.findIndex((m) => m.startsWith(n) || (m === 'september' && n === 'sept'));
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
  return { ok: true, iso: localISODate(d) };
}

const twoDigitYear = (y: string): number => (y.length === 2 ? 2000 + Number(y) : Number(y));

export function parseSaDate(input: string, now: Date = new Date()): DateParseResult {
  const shown = input.trim();
  const s = shown.toLowerCase().replace(/\s+/g, ' ');
  if (s === '') return fail('empty', 'Enter a date.');
  const formatHelp = `"${shown}" is not a date. Try 01 Oct 2026, 2026-10-01 or 01/10/2026 (day first).`;

  if (s === 't' || s === 'today') return { ok: true, iso: localISODate(now) };
  if (s === 'eom') return { ok: true, iso: monthEndISO(now) };

  const offset = /^([+-])(\d+)$/.exec(s);
  if (offset) {
    const days = Number(offset[2]) * (offset[1] === '-' ? -1 : 1);
    if (Math.abs(days) > MAX_OFFSET_DAYS) return fail('range', 'That is too many days from today.');
    return { ok: true, iso: addDaysISO(localISODate(now), days) };
  }

  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]), shown);

  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s);
  if (numeric) return build(twoDigitYear(numeric[3] ?? ''), Number(numeric[2]), Number(numeric[1]), shown);

  const dayFirst = /^(\d{1,2})[ -]([a-z]{3,9})(?:[ -](\d{4}|\d{2}))?$/.exec(s);
  if (dayFirst) {
    const month = monthFromName(dayFirst[2] ?? '');
    if (month === null) return fail('format', formatHelp);
    const year = dayFirst[3] ? twoDigitYear(dayFirst[3]) : now.getFullYear();
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

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Real local Date from a strict ISO string, or null (also for 2026-02-30). */
function fromISO(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** "01 Oct 2026"; '' when the input is not a real ISO date. */
export function formatSaDate(iso: string): string {
  const d = fromISO(iso);
  if (!d) return '';
  return `${String(d.getDate()).padStart(2, '0')} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Thursday, 1 October 2026": the echo under a date field. '' when not a real ISO date. */
export function formatSaDateLong(iso: string): string {
  const d = fromISO(iso);
  if (!d) return '';
  const month = MONTHS[d.getMonth()] ?? '';
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${month.charAt(0).toUpperCase()}${month.slice(1)} ${d.getFullYear()}`;
}
