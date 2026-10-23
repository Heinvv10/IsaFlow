/**
 * The optional `fiscal_year` of the Budget vs Actual report and its CSV export:
 * a financial-year LABEL resolved through the registry, never inferred as a
 * calendar year, plus the list of years the page's selector offers.
 */

import { getFiscalYear, type FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { listBudgetYears } from '../core/budgetYears';

/** A `fiscal_year` the caller got wrong: `unknown` when it is well formed but no year carries it (a 404), else a 400. */
export class BudgetReportYearError extends Error {
  constructor(message: string, readonly unknown: boolean, readonly label?: number) {
    super(message);
    this.name = 'BudgetReportYearError';
  }
}

/**
 * The year a request chose, or null when it chose none (absent or empty: the
 * year holding today). A year applies to `ytd` and `full_year`; with `current`
 * (this month) it would be ignored, so it is refused instead.
 */
export async function chosenReportYear(companyId: string, raw: unknown, period: string): Promise<FiscalYearRecord | null> {
  if (raw === undefined || raw === '') return null;
  const label = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
  if (label < 1) throw new BudgetReportYearError('fiscal_year must be a year label such as 2027', false);
  if (period === 'current') throw new BudgetReportYearError('fiscal_year applies to ytd and full_year, not the current month', false);
  const year = await getFiscalYear(companyId, label);
  if (!year) throw new BudgetReportYearError(`No financial year is labelled ${label}`, true, label);
  return year;
}

export interface ReportYearOption { fiscalYear: number; startDate: string; endDate: string; kind: string }

/** The years the selector offers: every stored year, the one holding today, and the next. */
export async function reportYearOptions(companyId: string, today: string): Promise<ReportYearOption[]> {
  return (await listBudgetYears(companyId, today)).map(({ fiscalYear, startDate, endDate, kind }) =>
    ({ fiscalYear, startDate, endDate, kind }));
}
