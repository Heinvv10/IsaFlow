/**
 * Centralized Date Formatting Utility
 *
 * ALL date formatting across the app should use these functions.
 * Dates are read in Africa/Johannesburg (SAST); month names are fixed English strings, not ICU,
 * so the output is identical on every machine and Node build.
 *
 * Display formats:
 *   formatDisplayDate()       → "25 Feb 2026" (zero-padded day: "05 Feb 2026")
 *   formatDisplayDateTime()   → "25 Feb 2026, 14:30"
 *   formatDisplayDateLong()   → "25 February 2026"
 *   formatDisplayDateShort()  → "25 Feb"
 *   formatDisplayMonthYear()  → "Feb 2026"
 *
 * Internal/API formats:
 *   formatDateISO()           → "2026-02-25"
 *   formatDateTimeISO()       → "2026-02-25 14:30"
 */

type DateInput = Date | string | number | null | undefined | { toDate: () => Date };

/**
 * Safely convert any date input to a Date object.
 * Handles: Date, ISO string, timestamp number, Firebase Timestamp, null/undefined.
 */
function toDate(date: DateInput): Date | null {
  if (!date) return null;

  try {
    // Firebase Timestamp
    if (typeof date === 'object' && 'toDate' in date && typeof date.toDate === 'function') {
      const d = date.toDate();
      return isNaN(d.getTime()) ? null : d;
    }

    if (date instanceof Date) {
      return isNaN(date.getTime()) ? null : date;
    }

    if (typeof date === 'string' || typeof date === 'number') {
      const d = new Date(date);
      return isNaN(d.getTime()) ? null : d;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Display Formats (user-facing) ──────────────────────────────

const NO_DATE = '—';
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const HAS_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

interface Parts { y: number; m: number; d: number; hh: number; mm: number; ss: number }

const SAST = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Africa/Johannesburg', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

/**
 * The calendar day and clock time of an instant in Africa/Johannesburg: the one rule the app's
 * "today" follows. Not the device's zone (a phone abroad would show another day), and never
 * toISOString (UTC: a day early after 22:00Z, which is already tomorrow in SAST).
 */
function sastParts(instant: Date): Parts | null {
  if (Number.isNaN(instant.getTime())) return null;
  const got: Record<string, number> = {};
  for (const part of SAST.formatToParts(instant)) got[part.type] = Number(part.value);
  return { y: got.year ?? 0, m: got.month ?? 0, d: got.day ?? 0, hh: got.hour ?? 0, mm: got.minute ?? 0, ss: got.second ?? 0 };
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

/** Parts of a strict ISO date (no timezone shift: it names its own calendar day); null for 2026-02-30. */
function isoParts(iso: string): Parts | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d, hh: 0, mm: 0, ss: 0 };
}

/** The calendar day of any date input, or null when it is not a date. */
function partsOf(date: DateInput): Parts | null {
  if (date === null || date === undefined || date === '') return null;
  if (typeof date === 'object' && 'toDate' in date && typeof date.toDate === 'function') return sastParts(date.toDate());
  if (date instanceof Date) return sastParts(date);
  if (typeof date === 'number') return sastParts(new Date(date));
  const text = String(date).trim();
  if (ISO_DATE.test(text)) return isoParts(text);
  if (TIMESTAMP.test(text)) {
    // A zoned timestamp is an instant (SAST day); a zone-less one names its own day.
    return HAS_ZONE.test(text) ? sastParts(new Date(text)) : isoParts(text.slice(0, 10));
  }
  return sastParts(new Date(text));
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * "05 Oct 2026" — THE one way a date is shown on screen (zero-padded day, month name, year).
 *
 * Takes whatever a date column or an API body holds: a plain ISO date, a timestamp, a Date, epoch
 * milliseconds, or a Timestamp-like with toDate(). Instants are read in Africa/Johannesburg; a plain
 * date or a zone-less timestamp names its own day. Nothing, or an invalid Date, shows `fallback` ('—',
 * the one "no date" mark). Text that is not a date is shown as it came, so a bad value stays visible.
 * Display only: files, API bodies and inputs keep ISO (formatDateISO).
 */
export function formatDisplayDate(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  if (p) return `${pad(p.d)} ${SHORT_MONTHS[p.m - 1]} ${p.y}`;
  return typeof date === 'string' && date.trim() !== '' ? date.trim() : fallback;
}

/**
 * "25 Feb 2026, 14:30" — Display date with time (SAST)
 */
export function formatDisplayDateTime(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  if (!p) return typeof date === 'string' && date.trim() !== '' ? date.trim() : fallback;
  return `${pad(p.d)} ${SHORT_MONTHS[p.m - 1]} ${p.y}, ${pad(p.hh)}:${pad(p.mm)}`;
}

/**
 * "25 February 2026" — Formal display (agreements, documents)
 */
export function formatDisplayDateLong(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${p.d} ${LONG_MONTHS[p.m - 1]} ${p.y}` : fallback;
}

/**
 * "25 Feb" — Compact display (alerts, timeline markers)
 */
export function formatDisplayDateShort(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${p.d} ${SHORT_MONTHS[p.m - 1]}` : fallback;
}

/**
 * "Feb 2026" — Month/year display (charts, reports)
 */
export function formatDisplayMonthYear(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${SHORT_MONTHS[p.m - 1]} ${p.y}` : fallback;
}

/**
 * "October 2026" — Month heading (workbenches, period pickers)
 */
export function formatDisplayMonthYearLong(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${LONG_MONTHS[p.m - 1]} ${p.y}` : fallback;
}

/**
 * "Wed, 21 Oct 2026" — Day with its weekday (timesheets, diaries)
 */
export function formatDisplayDateWeekday(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  if (!p) return fallback;
  const weekday = WEEKDAYS[weekdayOf(p.y, p.m, p.d)];
  return `${weekday}, ${pad(p.d)} ${SHORT_MONTHS[p.m - 1]} ${p.y}`;
}

/**
 * "14:30" — Time only display (SAST)
 */
export function formatDisplayTime(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${pad(p.hh)}:${pad(p.mm)}` : fallback;
}

/**
 * "14:30:05" — Time with seconds (SAST), for "last checked" / "refreshed" stamps
 */
export function formatDisplayTimeSeconds(date: DateInput, fallback = NO_DATE): string {
  const p = partsOf(date);
  return p ? `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}` : fallback;
}

// ─── Internal / API / Export Formats ────────────────────────────

/**
 * "2026-02-25" — ISO date for APIs, exports, form values
 */
export function formatDateISO(date: DateInput): string {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const p = partsOf(date);
  return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : '';
}

/**
 * "2026-02-25 14:30" — ISO datetime for APIs, exports
 */
export function formatDateTimeISO(date: DateInput): string {
  const p = partsOf(date);
  return p ? `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}` : '';
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
