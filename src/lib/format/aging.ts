/**
 * AR / AP / SARS aging formatters and bucket helpers.
 *
 * Used everywhere the app talks about "days overdue":
 *   - Debtors Manager (`/accounting/debtors-manager`)
 *   - AR/AP Aging reports (`/accounting/reports/ar-aging`, `ap-aging`)
 *   - SARS submissions index (`/accounting/sars`)
 *   - Suppliers / Missing Invoices
 *   - Dashboard TodoWidget
 *
 * The string output is the canonical format across the product. Adjust here,
 * everything updates.
 */

const DAYS_PER_YEAR  = 365;
const DAYS_PER_MONTH = 30;
const DAYS_PER_WEEK  = 7;

/**
 * Format a positive overdue duration (in days) as a short, scannable
 * "X overdue" string. Negative or zero values return `'Current'` so callers
 * can pass raw `daysOverdue` values without a conditional check.
 *
 * Buckets (chosen to keep the string ≤ 12 chars so it fits in a table cell):
 *   1–6 days       → "Nd overdue"
 *   7–29 days      → "Nw Md overdue"   (no extra-day part for exact weeks)
 *   30–364 days    → "Nm Md overdue"   (no extra-day part for exact months)
 *   365+ days      → "Ny Mm overdue"   (no extra-month part for exact years)
 *
 *   formatOverdueDays(0)    -> "Current"
 *   formatOverdueDays(3)    -> "3d overdue"
 *   formatOverdueDays(14)   -> "2w overdue"
 *   formatOverdueDays(45)   -> "1m 15d overdue"
 *   formatOverdueDays(180)  -> "6m overdue"
 *   formatOverdueDays(400)  -> "1y 1m overdue"
 *   formatOverdueDays(800)  -> "2y 2m overdue"
 */
export function formatOverdueDays(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return 'Current';
  const d = Math.floor(days);

  if (d < DAYS_PER_WEEK) return `${d}d overdue`;

  if (d < DAYS_PER_MONTH) {
    const weeks = Math.floor(d / DAYS_PER_WEEK);
    const rem   = d - weeks * DAYS_PER_WEEK;
    return rem > 0 ? `${weeks}w ${rem}d overdue` : `${weeks}w overdue`;
  }

  if (d < DAYS_PER_YEAR) {
    const months = Math.floor(d / DAYS_PER_MONTH);
    const rem    = d - months * DAYS_PER_MONTH;
    return rem > 0 ? `${months}m ${rem}d overdue` : `${months}m overdue`;
  }

  const years   = Math.floor(d / DAYS_PER_YEAR);
  const remDays = d - years * DAYS_PER_YEAR;
  const months  = Math.floor(remDays / DAYS_PER_MONTH);
  return months > 0 ? `${years}y ${months}m overdue` : `${years}y overdue`;
}

/**
 * Standard 30/60/90/120+ aging bucket keys. Returned as `'current'` for
 * non-overdue values so callers can use the result as a lookup key against
 * a colour/label map without branching.
 */
export type AgingBucketKey =
  | 'current'
  | 'days30'      // 1–30
  | 'days60'      // 31–60
  | 'days90'      // 61–90
  | 'days90Plus'; // 91+

/** Map a day count to its bucket key. */
export function bucketOverdueDays(days: number): AgingBucketKey {
  if (!Number.isFinite(days) || days <= 0) return 'current';
  const d = Math.floor(days);
  if (d <= 30) return 'days30';
  if (d <= 60) return 'days60';
  if (d <= 90) return 'days90';
  return 'days90Plus';
}

/**
 * Human-readable bucket labels — drop into table headers and tooltips.
 */
export const BUCKET_LABELS: Record<AgingBucketKey, string> = {
  current:    'Current',
  days30:     '1–30 days',
  days60:     '31–60 days',
  days90:     '61–90 days',
  days90Plus: '90+ days',
};

/**
 * Tailwind text colours used consistently for the bucket badges. Pages
 * (e.g. debtors-manager) used to inline an identical map; importing from
 * here keeps the colour ladder synchronised across the product.
 */
export const BUCKET_COLORS: Record<AgingBucketKey, string> = {
  current:    'text-teal-500',
  days30:     'text-amber-500',
  days60:     'text-orange-500',
  days90:     'text-red-400',
  days90Plus: 'text-red-600',
};

/**
 * Compact raw-day display for the "Days Overdue" table column.
 *
 * Unlike `formatOverdueDays` (which produces "2268d overdue"), this helper
 * returns a bare integer string so it doesn't duplicate the column header.
 * Values above 365 are capped at ">365" to avoid absurdly large numbers in
 * the demo data or edge-case stale invoices.
 *
 *   formatOverdueDaysCompact(-1)    → "—"
 *   formatOverdueDaysCompact(0)     → "—"
 *   formatOverdueDaysCompact(1)     → "1"
 *   formatOverdueDaysCompact(365)   → "365"
 *   formatOverdueDaysCompact(366)   → ">365"
 *   formatOverdueDaysCompact(2268)  → ">365"
 *   formatOverdueDaysCompact(NaN)   → "—"
 *   formatOverdueDaysCompact(Infinity) → "—"
 */
export function formatOverdueDaysCompact(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '—';
  const d = Math.floor(days);
  if (d > DAYS_PER_YEAR) return '>365';
  return String(d);
}
