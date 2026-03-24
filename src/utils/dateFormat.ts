/**
 * Centralized Date Formatting Utility
 *
 * ALL date formatting across the app should use these functions.
 * Locale: en-ZA (South Africa) for all user-facing dates.
 *
 * Display formats:
 *   formatDisplayDate()       → "25 Feb 2026"
 *   formatDisplayDateTime()   → "25 Feb 2026, 14:30"
 *   formatDisplayDateLong()   → "25 February 2026"
 *   formatDisplayDateShort()  → "25 Feb"
 *   formatDisplayMonthYear()  → "Feb 2026"
 *
 * Internal/API formats:
 *   formatDateISO()           → "2026-02-25"
 *   formatDateTimeISO()       → "2026-02-25 14:30"
 */

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

/**
 * "25 Feb 2026" — Standard display date
 */
export function formatDisplayDate(date: DateInput, fallback = 'N/A'): string {
  const d = toDate(date);
  if (!d) return fallback;
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * "25 Feb 2026, 14:30" — Display date with time
 */
export function formatDisplayDateTime(date: DateInput, fallback = 'N/A'): string {
  const d = toDate(date);
  if (!d) return fallback;
  const datePart = d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
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
  const d = toDate(date);
  if (!d) return '';
  return d.toISOString().split('T')[0] ?? '';
}

/**
 * "2026-02-25 14:30" — ISO datetime for APIs, exports
 */
export function formatDateTimeISO(date: DateInput): string {
  const d = toDate(date);
  if (!d) return '';
  const datePart = d.toISOString().split('T')[0];
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
