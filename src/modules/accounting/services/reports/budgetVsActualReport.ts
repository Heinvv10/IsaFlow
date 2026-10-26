/**
 * The ONE path from a Budget vs Actual request to its figures, shared by the
 * report route and its CSV export so the two cannot disagree (budgets P0, D3):
 * period (400 when unknown, D12) → chosen year → window → getBudgetVariance.
 */

import { buildBudgetVsActualSections } from './budgetVsActualSections';
import { getBudgetVariance, type BudgetVarianceResult } from './budgetVarianceService';
import { assertBudgetPeriod, resolveBudgetWindow, type ResolvedBudgetWindow } from './budgetWindowService';
import { chosenReportYear } from './budgetReportYear';

export interface BudgetVsActualReport {
  window: ResolvedBudgetWindow;
  /** Only what the screen and the CSV print. */
  result: Pick<BudgetVarianceResult, 'lines' | 'sections' | 'postedThrough'>;
}

export async function loadBudgetVsActualReport(
  companyId: string,
  rawPeriod: unknown,
  rawFiscalYear: unknown,
  now: Date = new Date(),
): Promise<BudgetVsActualReport> {
  const period = assertBudgetPeriod(rawPeriod);
  const chosen = await chosenReportYear(companyId, rawFiscalYear, period);
  const window = await resolveBudgetWindow(companyId, period, now, chosen);
  // A year that has not started has no budget and no actuals, whatever dates its window happens to name.
  if (window.notStarted) {
    return { window, result: { lines: [], sections: buildBudgetVsActualSections([]), postedThrough: null } };
  }
  const { lines, sections, postedThrough } = await getBudgetVariance(companyId, window.startDate, window.endDate);
  return { window, result: { lines, sections, postedThrough } };
}
