/**
 * Budget variance: what was planned against what the ledger actually carries.
 *
 * THE ACTUAL IS A RAW PER-ACCOUNT GL AGGREGATE, DELIBERATELY NOT THE INCOME
 * STATEMENT. `incomeStatementService` has open defects in exactly the layer a
 * variance would inherit — a rolling-window comparative, cost of sales bucketed
 * by account NAME rather than subtype, and no other-income / finance-cost / tax
 * layer at all. A variance computed against a net profit we already know is
 * wrong would be worse than no variance, because it would wear the authority of
 * a reconciliation. Summing posted journal lines per account borrows none of
 * that: it is the same figure the trial balance shows for the account.
 *
 * Signs are normalised so "more is more" on both sides: revenue is credit less
 * debit, expenses are debit less credit. The variance rules themselves live in
 * budgetVsActualLines so this and the Budget vs Actual report cannot drift.
 */

import { sql } from '@/lib/neon';
import { round2 } from '../core/budgetMonths';
import { budgetMonthKeysInWindow } from './budgetPeriodWindow';
import { loadWindowBudgets } from './budgetWindowService';
import { loadWindowActuals } from './budgetWindowActuals';
import { buildBudgetVsActualLines, type BudgetVsActualLine } from './budgetVsActualLines';
import { buildBudgetVsActualSections, type BudgetVsActualSections } from './budgetVsActualSections';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { fiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearRegistry';

export interface BudgetVarianceResult {
  /** The financial year (registry label) holding the window's start. */
  fiscalYear: number;
  /** The 'YYYY-MM' calendar months the budget was summed over, in window order. */
  monthKeys: string[];
  /** Every line the report prints: budgeted, or carrying movement. */
  lines: BudgetVsActualLine[];
  /** Accounts that carry a budget for this window, a deliberate zero included. */
  rows: BudgetVsActualLine[];
  /** Accounts with real posted movement and no budget at all. */
  unbudgeted: BudgetVsActualLine[];
  /** Revenue / Expenses / Net profit over `lines`. */
  sections: BudgetVsActualSections;
  /** Budgeted + unbudgeted — every account this report had to classify. */
  universeTotal: number;
  /** Net profit (budget, actual, favourably signed variance) — not revenue + expense, which means nothing. */
  totals: { budget: number; actual: number; variance: number };
  /** Absolute value of movement on accounts nobody budgeted. */
  unbudgetedMovement: number;
  /** Latest posted entry date inside the window, or null when nothing posted. */
  postedThrough: string | null;
}

export async function getBudgetVariance(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<BudgetVarianceResult> {
  const monthKeys = budgetMonthKeysInWindow(periodStart, periodEnd);
  // The financial year holding the window's start: a label for the reader to
  // re-derive against, not a key the budget is looked up by (budgets are per
  // calendar month, so a window spanning two years sums both).
  const fiscalYear = (await fiscalYearForDate(companyId, periodStart)).fiscalYear;
  const budgets = await loadWindowBudgets(companyId, periodStart, periodEnd);
  const actuals = await loadWindowActuals(companyId, periodStart, periodEnd);

  const postedRows = (await sql`
    SELECT MAX(je.entry_date)::text AS posted_through
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
  `) as Array<{ posted_through: string | null }>;

  const lines = buildBudgetVsActualLines(actuals, budgets);
  // Split on the budgeted BIT, never on the amount: a deliberate zero budget is a budget (D5).
  const rows = lines.filter((l) => l.budgeted);
  const unbudgeted = lines.filter((l) => !l.budgeted);
  const sections = buildBudgetVsActualSections(lines);

  return {
    fiscalYear,
    monthKeys,
    lines,
    rows,
    unbudgeted,
    sections,
    // Every account the report prints (budgeted, or carrying movement): the
    // two halves are a partition of it, so it always equals rows + unbudgeted.
    universeTotal: lines.length,
    totals: {
      budget: sections.net_profit.budget,
      actual: sections.net_profit.actual,
      variance: sections.net_profit.variance,
    },
    unbudgetedMovement: round2(
      unbudgeted.reduce((s, l) => s + Math.abs(l.actual_amount), 0),
    ),
    postedThrough: postedRows[0]?.posted_through ?? null,
  };
}
