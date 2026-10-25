/**
 * Centralized Date Formatting Utility
 *
 * ALL date formatting across the app should use these functions. Month names are fixed English
 * strings, not ICU, so the output is identical on every machine and Node build.
 *
 * Display formats:
 *   formatDisplayDate()        → "25 Feb 2026" (zero-padded day: "05 Feb 2026")
 *   formatDisplayDateTime()    → "25 Feb 2026, 14:30"
 *   formatDisplayDateLong()    → "25 February 2026"
 *   formatDisplayDateWeekday() → "Wednesday, 25 February 2026"
 *   formatDisplayDateShort()   → "25 Feb"
 *   formatDisplayMonthYear()   → "Feb 2026" (also from "2026-02")
 *
 * Internal/API formats:
 *   formatDateISO()            → "2026-02-25"
 *   formatDateTimeISO()        → "2026-02-25 14:30"
 *
 * WHAT THESE ACCEPT. Only `Date | string | null | undefined`: a number is not a date here (a count, a
 * quantity or a total passed in by mistake used to render as "01 Jan 1970"; epoch milliseconds go in
 * as `new Date(ms)`). A string is read ONLY when it is strict ISO: `YYYY-MM-DD`, or an ISO timestamp.
 * Any other string is not a date and comes back unchanged ("INV-001", a hash, "Period 3", "123"),
 * so a mis-wired argument shows as itself instead of as a wrong date.
 *
 * WHICH ZONE. A zoned ISO timestamp ("...Z", "...+02:00") is an instant and shows the SAST day and
 * time (Africa/Johannesburg: 22:00Z is already tomorrow). A plain date or a zone-less timestamp names
 * its own day. A `Date` is read from its own local calendar fields (a Date built as
 * `new Date(y, m - 1, d)` is that day on any device); it is never converted through UTC.
 */
import { localISODate } from '@/lib/dateUtils';

type DateInput = Date | string | null | undefined;

const NO_DATE = '—';
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

interface Parts { y: number; m: number; d: number; hh: number; mm: number; ss: number }

const SAST = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Africa/Johannesburg', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

function sastParts(instant: Date): Parts | null {
  if (Number.isNaN(instant.getTime())) return null;
  const got: Record<string, number> = {};
  for (const part of SAST.formatToParts(instant)) got[part.type] = Number(part.value);
  return { y: got.year ?? 0, m: got.month ?? 0, d: got.day ?? 0, hh: got.hour ?? 0, mm: got.minute ?? 0, ss: got.second ?? 0 };
}

function localParts(d: Date): Parts | null {
  if (Number.isNaN(d.getTime())) return null;
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: d.getHours(), mm: d.getMinutes(), ss: d.getSeconds() };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 0 = Sunday, from the calendar date alone (Sakamoto), so no Date or timezone is involved. */
function weekdayOf(year: number, month: number, day: number): number {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = month < 3 ? year - 1 : year;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + (offsets[month - 1] ?? 0) + day) % 7;
}

/** Parts of a strict ISO date (it names its own day); null for 2026-02-30. */
function isoParts(iso: string, time = ''): Parts | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const [hh = 0, mm = 0, ss = 0] = time.split(':').map((n) => Number.parseInt(n, 10) || 0);
  return { y, m: mo, d, hh, mm, ss };
}

/** The day (and time) a date input names, or null when it is not a date. */
function partsOf(date: DateInput): Parts | null {
  if (date instanceof Date) return localParts(date);
  if (typeof date !== 'string') return null;
  const text = date.trim();
  if (ISO_DATE.test(text)) return isoParts(text);
  const stamp = TIMESTAMP.exec(text);
  if (!stamp || !isoParts(text.slice(0, 10))) return null;
  if (stamp[1]) return sastParts(new Date(text.replace(' ', 'T')));
  return isoParts(text.slice(0, 10), text.slice(11));
}

/** "YYYY-MM" as a month, for the month/year forms only (it is not a day, so it never renders as day 01). */
function monthOf(date: DateInput): { y: number; m: number } | null {
  if (typeof date === 'string') {
    const m = ISO_MONTH.exec(date.trim());
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { y: Number(m[1]), m: Number(m[2]) };
  }
  const p = partsOf(date);
  return p ? { y: p.y, m: p.m } : null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** What to show when `date` has no parts: a string that is not a date comes back as it came; nothing is `fallback`. */
const unparsed = (date: DateInput, fallback: string): string =>
  typeof date === 'string' && date.trim() !== '' ? date.trim() : fallback;

// ─── Display Formats (user-facing) ──────────────────────────────

/** "05 Oct 2026" — THE one way a date is shown on screen. Nothing shows `fallback` ('—', the one "no date" mark). */
export function formatDisplayDate(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${pad(p.d)} ${SHORT_MONTHS[p.m - 1]} ${p.y}` : unparsed(date, fallback);
}

/** "25 Feb 2026, 14:30" — Display date with time */
export function formatDisplayDateTime(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${pad(p.d)} ${SHORT_MONTHS[p.m - 1]} ${p.y}, ${pad(p.hh)}:${pad(p.mm)}` : unparsed(date, fallback);
}

/** "25 February 2026" — Formal display (agreements, documents) */
export function formatDisplayDateLong(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${p.d} ${LONG_MONTHS[p.m - 1]} ${p.y}` : unparsed(date, fallback);
}

/** "25 Feb" — Compact display (alerts, timeline markers) */
export function formatDisplayDateShort(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${p.d} ${SHORT_MONTHS[p.m - 1]}` : unparsed(date, fallback);
}

/** "Feb 2026" — Month/year display (charts, reports); also from "2026-02" */
export function formatDisplayMonthYear(date: DateInput, fallback = NO_DATE): string {
  const p = monthOf(date);
  return p ? `${SHORT_MONTHS[p.m - 1]} ${p.y}` : unparsed(date, fallback);
}

/** "October 2026" — Month heading (workbenches, period pickers); also from "2026-10" */
export function formatDisplayMonthYearLong(date: DateInput, fallback = NO_DATE): string {
  const p = monthOf(date);
  return p ? `${LONG_MONTHS[p.m - 1]} ${p.y}` : unparsed(date, fallback);
}

/** "Wed, 21 Oct 2026" — Day with its short weekday (timesheets, diaries) */
export function formatDisplayDateWeekdayShort(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  if (!p) return unparsed(date, fallback);
  return `${WEEKDAYS[weekdayOf(p.y, p.m, p.d)]}, ${pad(p.d)} ${SHORT_MONTHS[p.m - 1]} ${p.y}`;
}

/** "Wednesday, 25 February 2026" — Echo of a typed date (the weekday catches a wrong month or year) */
export function formatDisplayDateWeekday(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  if (!p) return unparsed(date, fallback);
  return `${LONG_WEEKDAYS[weekdayOf(p.y, p.m, p.d)]}, ${p.d} ${LONG_MONTHS[p.m - 1]} ${p.y}`;
}

/** "14:30" — Time only display */
export function formatDisplayTime(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${pad(p.hh)}:${pad(p.mm)}` : unparsed(date, fallback);
}

/** "14:30:05" — Time with seconds, for "last checked" / "refreshed" stamps */
export function formatDisplayTimeSeconds(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}` : unparsed(date, fallback);
}

// ─── Internal / API / Export Formats ────────────────────────────

/** A Date or ISO string as a Date, or null. The machine formats below keep this (device-local) reading. */
function toDate(date: DateInput): Date | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "2026-02-25" — ISO date for APIs, exports, form values
 */
export function formatDateISO(date: DateInput): string {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = toDate(date);
  return d ? localISODate(d) : '';
}

/**
 * "2026-02-25 14:30" — ISO datetime for APIs, exports
 */
export function formatDateTimeISO(date: DateInput): string {
  const d = toDate(date);
  return d ? `${localISODate(d)} ${d.toTimeString().slice(0, 5)}` : '';
}

// ─── Utility ────────────────────────────────────────────────────

/**
 * Parse a date string to Date object safely
 */
export function parseDateSafe(date: DateInput): Date | null {
  return toDate(date);
}

/**
 * Get today's date in ISO format (YYYY-MM-DD)
 */
export function getTodayISO(): string {
  return formatDateISO(new Date());
}

// ─── Legacy Aliases (backward compatibility) ────────────────────
// These maintain existing imports while pointing to the new functions.

/** @deprecated Use formatDateISO() */
export const formatDateStandard = formatDateISO;

/** @deprecated Use formatDateTimeISO() */
export const formatDateTimeStandard = formatDateTimeISO;

/** @deprecated Use formatDisplayDate() for display or formatDateISO() for API */
export function formatDate(date: DateInput, fallback = NO_DATE): string {
  return formatDisplayDate(date, fallback);
}

/** @deprecated Use formatDisplayDateTime() */
export function formatDateTime(date: DateInput, fallback = NO_DATE): string {
  return formatDisplayDateTime(date, fallback);
}

/** @deprecated Use parseDateSafe() */
export const parseDateStandard = parseDateSafe;

/** @deprecated Use getTodayISO() */
export const getTodayStandard = getTodayISO;

/** @deprecated Use formatDateISO() */
export const formatDateForExport = formatDateISO;
