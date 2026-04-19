import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

/**
 * Returns the `{year, month}` of the month that's n months before `period`.
 * e.g. prior of Mar 2025, 1 → Feb 2025; prior of Jan 2025, 1 → Dec 2024.
 */
function monthsAgo(
  period: { month: number; year: number },
  n: number,
): { month: number; year: number } {
  let m = period.month - n;
  let y = period.year;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return { month: m, year: y };
}

/**
 * Estimate the annual payroll (gross) for a company in a period.
 * Sums total_gross from payroll_run_headers for the rolling 12-month window
 * ending at `period` (inclusive). If fewer than 12 months have data,
 * extrapolate: (sum / months_with_data) * 12. Returns 0 for no history.
 *
 * Excludes cancelled runs. Excludes the target period itself if its own
 * run is still 'draft' (unreliable — might change when recalculated).
 * Includes 'calculated'/'approved'/'paid' rows.
 */
export async function getAnnualPayrollEstimate(
  companyId: string,
  period: { month: number; year: number },
): Promise<number> {
  const earliest = monthsAgo(period, 11);
  // Convert (year, month) to a comparable YYYYMM int on both sides
  const earliestKey = earliest.year * 100 + earliest.month;
  const latestKey = period.year * 100 + period.month;

  const rows = (await sql`
    SELECT total_gross
    FROM payroll_run_headers
    WHERE company_id = ${companyId}::uuid
      AND status IN ('calculated', 'approved', 'paid')
      AND (period_year * 100 + period_month) BETWEEN ${earliestKey} AND ${latestKey}
  `) as Row[];

  if (rows.length === 0) return 0;

  const sum = rows.reduce((acc, r) => acc + Number(r.total_gross), 0);
  // Extrapolate when fewer than 12 months have data
  const estimate = rows.length >= 12 ? sum : (sum / rows.length) * 12;
  return Math.round(estimate * 100) / 100;
}
