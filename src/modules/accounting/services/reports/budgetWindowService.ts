/**
 * What the Budget vs Actual report and its CSV export both need: the window a
 * `period` names, and each account's budget over that window.
 *
 * The window comes from the fiscal-year registry, never from the declared
 * `financial_year_start`: `ytd` runs from the start of the financial year
 * holding today to today, `full_year` is that year's whole range (14 months for
 * a transition year). The budget is the sum of the calendar months
 * (`budget_month_amounts`) inside the window.
 *
 * The old `app_settings.accounting_budgets` fallback is gone: nothing in the
 * repo or its migrations writes it, it is one flat figure per account that no
 * window can scale, and the export read it without a company filter.
 */

import { sql } from '@/lib/neon';
import { localISODate } from '@/lib/dateUtils';
import { dayBefore, fiscalYearForDate, type FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { round2 } from '../core/budgetMonths';
import { budgetMonthBounds, currentMonthWindow, type BudgetWindow } from './budgetPeriodWindow';

export interface ResolvedBudgetWindow extends BudgetWindow {
  /** The financial year holding the window's start. */
  fiscalYear: FiscalYearRecord;
  /** Year to date of a chosen year that has not started: the window is EMPTY (ends the day before it starts). */
  notStarted: boolean;
}

/**
 * `current` = this month to date; `full_year` = the registry year in full; anything else = year to date.
 * A `chosen` year (budgetReportYear) replaces the year holding today: `full_year` is its whole
 * range, year to date runs from its start to today, held inside the year; of a year that has not
 * started it is empty (`notStarted`), not a day or a month of it.
 */
export async function resolveBudgetWindow(
  companyId: string,
  period: string,
  now: Date = new Date(),
  chosen: FiscalYearRecord | null = null,
): Promise<ResolvedBudgetWindow> {
  const today = localISODate(now);
  if (chosen) {
    if (period !== 'full_year' && today < chosen.startDate) {
      return { startDate: chosen.startDate, endDate: dayBefore(chosen.startDate), fiscalYear: chosen, notStarted: true };
    }
    const upTo = today > chosen.endDate ? chosen.endDate : today;
    return { startDate: chosen.startDate, endDate: period === 'full_year' ? chosen.endDate : upTo, fiscalYear: chosen, notStarted: false };
  }
  if (period === 'current') {
    const window = currentMonthWindow(now);
    return { ...window, fiscalYear: await fiscalYearForDate(companyId, window.startDate), notStarted: false };
  }
  const fiscalYear = await fiscalYearForDate(companyId, today);
  return {
    startDate: fiscalYear.startDate,
    endDate: period === 'full_year' ? fiscalYear.endDate : today,
    fiscalYear,
    notStarted: false,
  };
}

/**
 * Budget per account over the window, keyed by account code AND account id (the
 * line builder looks up either). An account with stored months but none inside
 * the window is present at 0.
 */
export async function loadWindowBudgets(
  companyId: string,
  startDate: string,
  endDate: string,
): Promise<Record<string, number>> {
  const bounds = budgetMonthBounds(startDate, endDate);
  if (!bounds) return {};
  const rows = (await sql`
    SELECT bm.gl_account_id, ga.account_code, SUM(bm.amount)::numeric AS total
    FROM budget_month_amounts bm
    JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE bm.company_id = ${companyId}::UUID
      AND bm.month >= ${bounds.first}::DATE AND bm.month <= ${bounds.last}::DATE
    GROUP BY bm.gl_account_id, ga.account_code
  `) as Array<{ gl_account_id: string; account_code: string; total: string | number }>;

  const budgets: Record<string, number> = {};
  for (const row of rows) {
    const total = round2(Number(row.total));
    budgets[row.account_code] = total;
    budgets[row.gl_account_id] = total;
  }
  return budgets;
}
