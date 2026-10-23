/**
 * Which months a set of annual financial statements covers.
 *
 * This is the most consequential date calculation in the product: it decides
 * what a customer signs and files with CIPC under their own name. It used to
 * be a constant (`${year}-01-01` .. `${year}-12-31`), then a derivation from
 * the company's CURRENT `financial_year_start`. Both are gone: a financial year
 * is a stored record (`fiscal_years`) and its range is read from the registry
 * (gl/fiscalYearRegistry), so a company that changed its year end still gets
 * every past year with the dates it actually had, and a 14-month transition
 * year reports 14 months.
 *
 * CONVENTION: fiscal year N is the year that ENDS in calendar year N. That is
 * what an accountant means by "the 2026 annual financial statements", it is
 * what `afs_documents.fiscal_year` holds, and it is the registry's label.
 *
 * Dates are 'YYYY-MM-DD' strings, never `new Date()` round-tripped through
 * `.toISOString()`: on this UTC+2 host that reports the previous day and shifts
 * a year boundary. See src/lib/pgTypes.ts.
 */

import {
  dayBefore,
  fiscalYearForDate,
  assertDeclaredBasis,
  priorFiscalYear,
  requireFiscalYear,
} from '@/modules/accounting/services/gl/fiscalYearRegistry';

export interface FiscalRange {
  /** Inclusive first day, 'YYYY-MM-DD'. */
  start: string;
  /** Inclusive last day, 'YYYY-MM-DD'. */
  end: string;
}

/** A financial year expressed in 'YYYYMM' ledger periods rather than dates. */
export interface FiscalPeriodWindow {
  /** First period of the financial year containing the requested period. */
  start: string;
  /** The requested period itself — the window's inclusive last period. */
  end: string;
  /** The period immediately before `start`: the prior year's closing period. */
  priorEnd: string;
}

/** 'YYYY-MM-DD' to the 'YYYYMM' ledger period holding it. */
function yyyymmOf(date: string): string {
  return `${date.slice(0, 4)}${date.slice(5, 7)}`;
}

/**
 * The financial year containing `period`, as `asset_period_ledger.yyyymm`
 * periods.
 *
 * The date-keyed helpers below cannot serve a caller that compares `yyyymm`
 * strings: it needs the boundaries in the same shape as the column. Deliberately
 * period-keyed and unlabelled by fiscal year.
 *
 * @param period 'YYYYMM'.
 */
export async function fiscalWindowForPeriod(
  companyId: string,
  period: string,
): Promise<FiscalPeriodWindow> {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(period)) {
    throw new Error(`fiscalWindowForPeriod: period must be YYYYMM with a month 01-12, got '${period}'.`);
  }
  const year = assertDeclaredBasis(companyId, await fiscalYearForDate(companyId, `${period.slice(0, 4)}-${period.slice(4, 6)}-01`));
  return {
    start: yyyymmOf(year.startDate),
    end: period,
    priorEnd: yyyymmOf(dayBefore(year.startDate)),
  };
}

/**
 * The date range of `fiscalYear` for a specific company: the stored year with
 * that label, else the year the template would create.
 *
 * @throws when the company has no year carrying that label.
 */
export async function getFiscalRange(
  companyId: string,
  fiscalYear: number,
): Promise<FiscalRange> {
  const year = assertDeclaredBasis(companyId, await requireFiscalYear(companyId, fiscalYear));
  return { start: year.startDate, end: year.endDate };
}

/**
 * A year and, when `withPrior`, its comparative: the year immediately before
 * it, whatever its length or label.
 *
 * After a change of year end the year before FY2027 is the year holding the day
 * before FY2027 starts, which is not "FY2026 with the same start month" and may
 * not even carry the label 2026, so the caller says only THAT a comparative is
 * wanted, never which label.
 */
export async function getFiscalRangeWithPrior(
  companyId: string,
  fiscalYear: number,
  withPrior = false,
): Promise<{ current: FiscalRange; prior: FiscalRange | null }> {
  const year = assertDeclaredBasis(companyId, await requireFiscalYear(companyId, fiscalYear));
  const current = { start: year.startDate, end: year.endDate };
  if (!withPrior) return { current, prior: null };

  const before = assertDeclaredBasis(companyId, await priorFiscalYear(companyId, year));
  return { current, prior: { start: before.startDate, end: before.endDate } };
}

/** The prior comparative year: the registry year immediately before `fiscalYear`. */
export async function getPriorFiscalRange(
  companyId: string,
  fiscalYear: number,
): Promise<FiscalRange> {
  const year = assertDeclaredBasis(companyId, await requireFiscalYear(companyId, fiscalYear));
  const before = assertDeclaredBasis(companyId, await priorFiscalYear(companyId, year));
  return { start: before.startDate, end: before.endDate };
}
