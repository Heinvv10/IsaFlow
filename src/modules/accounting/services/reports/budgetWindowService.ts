/**
 * What the Budget vs Actual report and its CSV export both need: the window a
 * `period` names, and each account's budget over that window.
 *
 * The window comes from the fiscal-year registry, never from the declared
 * `financial_year_start`. Budgets are whole calendar months
 * (`budget_month_amounts`), so every window covers whole months on both sides
 * (budgets P0, D8; contract decision 17): `current` is the fiscal period holding
 * today widened to the whole calendar months it touches (the calendar month when
 * no period row exists), so a period of 27 Sep - 31 Oct sets September and
 * October's budgets against September and October's actuals, `ytd` runs from
 * the start of the financial year holding today to the end of today's month,
 * capped at the year end, and `full_year` is that year's whole range (14 months
 * for a transition year). Any other `period` is refused (D12).
 * Each year's months come from its primary version (migration 947).
 *
 * The old `app_settings.accounting_budgets` fallback is gone: nothing in the
 * repo or its migrations writes it, it is one flat figure per account that no
 * window can scale, and the export read it without a company filter.
 */

import { sql } from '@/lib/neon';
import { localISODate } from '@/lib/dateUtils';
import { dayBefore, fiscalYearForDate, periodForDate, type FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { round2 } from '../core/budgetMonths';
import { namedVersionScope, primaryVersionScope } from '../budgets/budgetVersionScope';
import { budgetMonthBounds, currentMonthWindow, monthEnd, type BudgetWindow } from './budgetPeriodWindow';

export type BudgetPeriod = 'current' | 'ytd' | 'full_year';

/** A `period` the caller got wrong: a 400. */
export class BudgetPeriodError extends Error {
  constructor() {
    super('period must be current, ytd or full_year');
    this.name = 'BudgetPeriodError';
  }
}

/** The request's `period`: absent or empty is `ytd`; anything but the three periods is refused. */
export function assertBudgetPeriod(raw: unknown): BudgetPeriod {
  if (raw === undefined || raw === '') return 'ytd';
  if (raw === 'current' || raw === 'ytd' || raw === 'full_year') return raw;
  throw new BudgetPeriodError();
}

export interface ResolvedBudgetWindow extends BudgetWindow {
  /** The financial year holding the window's start. */
  fiscalYear: FiscalYearRecord;
  /** Year to date of a chosen year that has not started: the window is EMPTY (ends the day before it starts). */
  notStarted: boolean;
}

/**
 * `current` = the fiscal period holding today, widened to whole calendar months; `full_year` = the registry year in full;
 * `ytd` = the year's start to the end of today's month, capped at the year end.
 * A `chosen` year (budgetReportYear) replaces the year holding today: `full_year` is its whole
 * range, year to date runs from its start to the end of today's month, held inside the year; of
 * a year that has not started it is empty (`notStarted`), not a day or a month of it.
 */
export async function resolveBudgetWindow(
  companyId: string,
  rawPeriod: string,
  now: Date = new Date(),
  chosen: FiscalYearRecord | null = null,
): Promise<ResolvedBudgetWindow> {
  const period = assertBudgetPeriod(rawPeriod);
  const today = localISODate(now);
  const upToMonthEnd = (yearEnd: string) => (monthEnd(today) > yearEnd ? yearEnd : monthEnd(today));
  if (chosen) {
    if (period !== 'full_year' && today < chosen.startDate) {
      return { startDate: chosen.startDate, endDate: dayBefore(chosen.startDate), fiscalYear: chosen, notStarted: true };
    }
    return { startDate: chosen.startDate, endDate: period === 'full_year' ? chosen.endDate : upToMonthEnd(chosen.endDate), fiscalYear: chosen, notStarted: false };
  }
  if (period === 'current') {
    const fiscalPeriod = await periodForDate(companyId, today);
    // Budgets are summed by whole calendar month, so the actuals must be too:
    // a period that starts or ends mid-month is widened to its months' edges.
    const window = fiscalPeriod
      ? { startDate: `${fiscalPeriod.startDate.slice(0, 7)}-01`, endDate: monthEnd(fiscalPeriod.endDate) }
      : currentMonthWindow(now);
    // The year label comes from the period's OWN start: widening a 15 Mar period
    // back to 1 Mar must not label it with the previous financial year.
    const labelDate = fiscalPeriod ? fiscalPeriod.startDate : window.startDate;
    return { ...window, fiscalYear: await fiscalYearForDate(companyId, labelDate), notStarted: false };
  }
  const fiscalYear = await fiscalYearForDate(companyId, today);
  return {
    startDate: fiscalYear.startDate,
    endDate: period === 'full_year' ? fiscalYear.endDate : upToMonthEnd(fiscalYear.endDate),
    fiscalYear,
    notStarted: false,
  };
}

/**
 * Budget per account over the window, keyed by account ID only (the line
 * builder looks up nothing else). Only accounts with a stored month INSIDE the
 * window are present; a present key, even at 0, is what makes a line budgeted.
 *
 * Versions (migration 947): each registry year in the window contributes its
 * PRIMARY version's months inside that year (a year with no primary contributes
 * nothing); a named `versionId` contributes only its own year's months. Every
 * grain is summed, so an account budgeted by dimension totals its members.
 */
export async function loadWindowBudgets(
  companyId: string,
  startDate: string,
  endDate: string,
  versionId?: string,
): Promise<Record<string, number>> {
  const bounds = budgetMonthBounds(startDate, endDate);
  if (!bounds) return {};
  const scope = (versionId
    ? await namedVersionScope(companyId, versionId, { startDate, endDate })
    : await primaryVersionScope(companyId, startDate, endDate)
  ).filter((s): s is typeof s & { versionId: string } => s.versionId !== null);
  if (scope.length === 0) return {};
  const rows = (await sql`
    SELECT bm.gl_account_id, SUM(bm.amount)::numeric AS total
    FROM budget_month_amounts bm
    JOIN unnest(${scope.map((s) => s.versionId)}::UUID[], ${scope.map((s) => s.first)}::DATE[], ${scope.map((s) => s.last)}::DATE[])
      AS sc(version_id, first_month, last_month)
      ON bm.version_id = sc.version_id AND bm.month >= sc.first_month AND bm.month <= sc.last_month
    JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE bm.company_id = ${companyId}::UUID
    GROUP BY bm.gl_account_id
  `) as Array<{ gl_account_id: string; total: string | number }>;

  const budgets: Record<string, number> = {};
  for (const row of rows) budgets[String(row.gl_account_id)] = round2(Number(row.total));
  return budgets;
}
