/**
 * The financial years a budget can be set for, with the months each spans.
 * A budget screen builds one column per month, so a 14-month transition year
 * shows 14 columns and its label may be followed by a gap (after a change of
 * year end the next label can skip one): the years are listed, never inferred
 * as label + 1.
 */

import { fiscalYearForDate, listFiscalYears, type FiscalYearKind, type FiscalYearRecord } from '../gl/fiscalYearRegistry';
import { addMonthsToKey, budgetMonthKeysInWindow, monthKeyToDate } from '../reports/budgetPeriodWindow';

export interface BudgetYearInfo {
  /** The label. */
  fiscalYear: number;
  startDate: string;
  endDate: string;
  kind: FiscalYearKind;
  /** The 'YYYY-MM' months of the year, in order. */
  monthKeys: string[];
}

export function toBudgetYearInfo(year: FiscalYearRecord): BudgetYearInfo {
  return {
    fiscalYear: year.fiscalYear,
    startDate: year.startDate,
    endDate: year.endDate,
    kind: year.kind,
    monthKeys: budgetMonthKeysInWindow(year.startDate, year.endDate),
  };
}

/** Every stored year, the one holding `today`, and the one after the last of those, oldest first. */
export async function listBudgetYears(companyId: string, today: string): Promise<BudgetYearInfo[]> {
  const byLabel = new Map<number, FiscalYearRecord>();
  for (const y of await listFiscalYears(companyId)) byLabel.set(y.fiscalYear, y);
  const current = await fiscalYearForDate(companyId, today);
  if (!byLabel.has(current.fiscalYear)) byLabel.set(current.fiscalYear, current);

  const last = [...byLabel.values()].reduce((a, b) => (b.endDate > a.endDate ? b : a));
  const lastMonth = budgetMonthKeysInWindow(last.startDate, last.endDate).pop()!;
  const next = await fiscalYearForDate(companyId, monthKeyToDate(addMonthsToKey(lastMonth, 1)));
  if (!byLabel.has(next.fiscalYear)) byLabel.set(next.fiscalYear, next);

  return [...byLabel.values()].sort((a, b) => (a.startDate < b.startDate ? -1 : 1)).map(toBudgetYearInfo);
}
