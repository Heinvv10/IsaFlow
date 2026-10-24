/**
 * Centralized Date Formatting Utility
 *
 * ALL date formatting across the app should use these functions.
 * Locale: en-ZA (South Africa) for all user-facing dates.
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

import { localISODate } from '@/lib/dateUtils';

const LOCALE = 'en-ZA';

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

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const HAS_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** "05 Oct 2026" from a strict ISO date; '' when it is not a real calendar date (2026-02-30). */
function fromISODate(iso: string): string {
  const m = ISO_DATE.exec(iso);
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const real = new Date(y, mo - 1, d);
  if (real.getFullYear() !== y || real.getMonth() !== mo - 1 || real.getDate() !== d) return '';
  return `${String(d).padStart(2, '0')} ${SHORT_MONTHS[mo - 1]} ${y}`;
}

/** The display date of a Date, read in LOCAL time (never via toISOString, which is UTC and can be a day early east of UTC). */
function fromDate(d: Date): string {
  return Number.isNaN(d.getTime()) ? '' : fromISODate(localISODate(d));
}

/**
 * "05 Oct 2026" — THE one way a date is shown on screen (zero-padded day, month name, year).
 *
 * Takes whatever a date column or an API body holds: a plain ISO date (no timezone shift), a
 * timestamp, a Date, epoch milliseconds, or a Timestamp-like with toDate(). A timestamp WITH a zone
 * is read in local time (22:00Z is already the next day in SAST); one without names its own calendar
 * day. `fallback` is returned for nothing and for anything that is not a date. Display only: ISO
 * values in APIs and inputs are unchanged (use formatDateISO for those).
 */
export function formatDisplayDate(date: DateInput, fallback = 'N/A'): string {
  if (date === null || date === undefined || date === '') return fallback;
  if (typeof date === 'object' && 'toDate' in date && typeof date.toDate === 'function') {
    return fromDate(date.toDate()) || fallback;
  }
  if (date instanceof Date) return fromDate(date) || fallback;
  if (typeof date === 'number') return fromDate(new Date(date)) || fallback;
  const text = String(date).trim();
  if (ISO_DATE.test(text)) return fromISODate(text) || fallback;
  if (TIMESTAMP.test(text)) {
    return (HAS_ZONE.test(text) ? fromDate(new Date(text)) : fromISODate(text.slice(0, 10))) || fallback;
  }
  return fromDate(new Date(text)) || fallback;
}

/**
 * "25 Feb 2026, 14:30" — Display date with time
 */
export function formatDisplayDateTime(date: DateInput, fallback = 'N/A'): string {
  const d = toDate(date);
  if (!d) return fallback;
  const datePart = formatDisplayDate(d);
  const timePart = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${datePart}, ${timePart}`;
}

/**
 * "25 February 2026" — Formal display (agreements, documents)
 */
export function formatDisplayDateLong(date: DateInput, fallback = 'N/A'): string {
  const d = toDate(date);
  if (!d) return fallback;
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * "25 Feb" — Compact display (alerts, timeline markers)
 */
export function formatDisplayDateShort(date: DateInput, fallback = 'N/A'): string {
  const d = toDate(date);
  if (!d) return fallback;
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
}

/**
 * "Feb 2026" — Month/year display (charts, reports)
 */
export function formatDisplayMonthYear(date: DateInput, fallback = 'N/A'): string {
  const d = toDate(date);
  if (!d) return fallback;
  return d.toLocaleDateString(LOCALE, { month: 'short', year: 'numeric' });
}

/**
 * "14:30" — Time only display
 */
export function formatDisplayTime(date: DateInput, fallback = 'N/A'): string {
  const d = toDate(date);
  if (!d) return fallback;
  return d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ─── Internal / API / Export Formats ────────────────────────────

/**
 * "2026-02-25" — ISO date for APIs, exports, form values
 */
export function formatDateISO(date: DateInput): string {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = toDate(date);
  if (!d) return '';
  return localISODate(d);
}

/**
 * "2026-02-25 14:30" — ISO datetime for APIs, exports
 */
export function formatDateTimeISO(date: DateInput): string {
  const d = toDate(date);
  if (!d) return '';
  const datePart = localISODate(d);
  const timePart = d.toTimeString().slice(0, 5);
  return `${datePart} ${timePart}`;
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
export function formatDate(date: DateInput, fallback = 'N/A'): string {
  return formatDisplayDate(date, fallback);
}

/** @deprecated Use formatDisplayDateTime() */
export function formatDateTime(date: DateInput, fallback = 'N/A'): string {
  return formatDisplayDateTime(date, fallback);
}

/** @deprecated Use parseDateSafe() */
export const parseDateStandard = parseDateSafe;

/** @deprecated Use getTodayISO() */
export const getTodayStandard = getTodayISO;

/** @deprecated Use formatDateISO() */
export const formatDateForExport = formatDateISO;
