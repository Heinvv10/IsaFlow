/**
 * Which twelve months a set of annual financial statements covers.
 *
 * This is the most consequential date calculation in the product: it decides
 * what a customer signs and files with CIPC under their own name. It used to
 * be a constant:
 *
 *     export function fiscalRange(year: number) {
 *       return { start: `${year}-01-01`, end: `${year}-12-31` };
 *     }
 *
 * — no company, no configuration, January to December for everyone. A company
 * on a February year end had a whole quarter of the wrong trading in its
 * statements, and nothing on screen said so.
 *
 * CONVENTION: fiscal year N is the year that ENDS in calendar year N. That is
 * what an accountant means by "the 2026 annual financial statements", it is
 * what `afs_documents.fiscal_year` holds, and for a January year start it
 * collapses to calendar year N.
 *
 * This is the OPPOSITE labelling to `gl/fiscalYearBasis.fiscalYearStart`,
 * which names a fiscal year by the year it starts in. Both are defensible;
 * two unlabelled conventions in one codebase are not, so each states its own
 * and neither is inferred.
 *
 * Dates are 'YYYY-MM-DD' strings built by arithmetic on numbers, never via
 * `new Date()` and never formatted with `.toISOString()`: on this UTC+2 host a
 * Date round-trip reports the previous day and shifts a year boundary. See
 * src/lib/pgTypes.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { resolveFiscalYearStartMonth } from '@/modules/accounting/services/gl/fiscalYearBasis';

export interface FiscalRange {
  /** Inclusive first day, 'YYYY-MM-DD'. */
  start: string;
  /** Inclusive last day, 'YYYY-MM-DD'. */
  end: string;
}

/** Days in `month` (1-12) of `year`, Gregorian leap rules included. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The date range of fiscal year `fiscalYear` for a company whose financial
 * year begins in month `fyStartMonth`.
 *
 * @throws when `fyStartMonth` is not a month. Deliberately not clamped: a
 *   silent fallback to March is how a misconfigured tenant gets a year end a
 *   quarter out with nothing flagging it.
 */
export function fiscalRangeFor(fiscalYear: number, fyStartMonth: number): FiscalRange {
  const month = Math.trunc(Number(fyStartMonth));
  if (!Number.isFinite(month) || month < 1 || month > 12) {
    throw new Error(
      `fiscalRangeFor: fyStartMonth must be a month 1-12, got ${String(fyStartMonth)}. ` +
      `Resolve it with resolveFiscalYearStartMonth() first — never assume March.`,
    );
  }

  const year = Math.trunc(Number(fiscalYear));
  if (!Number.isFinite(year)) {
    throw new Error(`fiscalRangeFor: fiscalYear must be a year, got ${String(fiscalYear)}.`);
  }

  if (month === 1) {
    return { start: iso(year, 1, 1), end: iso(year, 12, 31) };
  }

  // Starts in the PRIOR calendar year, because the year is named for its end.
  const startYear = year - 1;
  const endMonth = month - 1;
  return {
    start: iso(startYear, month, 1),
    end: iso(year, endMonth, daysInMonth(year, endMonth)),
  };
}

/**
 * The date range of `fiscalYear` for a specific company, resolved from the
 * financial year start configured in its settings.
 *
 * REFUSES when `companies.financial_year_start` is unusable rather than
 * defaulting. The column is nullable and its default is 3; a read path that
 * quietly assumes March reports a December-year-end tenant a quarter out. The
 * caller that genuinely may proceed on an assumption passes `fallback`
 * explicitly, so the assumption is visible at the call site.
 */
export async function getFiscalRange(
  companyId: string,
  fiscalYear: number,
  options: { fallback?: number } = {},
): Promise<FiscalRange> {
  const rows = (await sql`
    SELECT financial_year_start
    FROM companies
    WHERE id = ${companyId}::UUID
    LIMIT 1
  `) as DbRow[];

  if (rows.length === 0) {
    throw new Error(`getFiscalRange: company ${companyId} not found.`);
  }

  const month = resolveFiscalYearStartMonth(
    rows[0]!.financial_year_start,
    companyId,
    options,
  );
  return fiscalRangeFor(fiscalYear, month);
}

/**
 * The prior comparative year — the twelve months immediately before
 * `fiscalYear`, on the same calendar.
 */
export async function getPriorFiscalRange(
  companyId: string,
  fiscalYear: number,
  options: { fallback?: number } = {},
): Promise<FiscalRange> {
  return getFiscalRange(companyId, fiscalYear - 1, options);
}
