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
import {
  budgetMonthKeysInWindow,
  sumBudgetForWindow,
} from './budgetPeriodWindow';
import {
  buildBudgetVsActualLines,
  type BudgetVsActualLine,
  type RawActualRow,
} from './budgetVsActualLines';

export interface BudgetVarianceRow extends BudgetVsActualLine {
  account_id: string;
}

export interface BudgetVarianceResult {
  /** The budget year the window was matched against — re-derivable, not guessed. */
  fiscalYear: number;
  /** Calendar month keys the budget was summed over, in window order. */
  monthKeys: string[];
  /** Accounts that carry a budget for this window. */
  rows: BudgetVarianceRow[];
  /** Accounts with real posted movement and no budget at all. */
  unbudgeted: BudgetVarianceRow[];
  /** Budgeted + unbudgeted — every account this report had to classify. */
  universeTotal: number;
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
  const fiscalYear = Number(periodStart.slice(0, 4));
  const monthKeys = budgetMonthKeysInWindow(periodStart, periodEnd);

  const budgetRows = (await sql`
    SELECT ab.gl_account_id, ga.account_code, ab.period_amounts, ab.annual_amount
    FROM accounting_budgets ab
    JOIN gl_accounts ga ON ga.id = ab.gl_account_id AND ga.company_id = ${companyId}::UUID
    WHERE ab.company_id = ${companyId}::UUID AND ab.fiscal_year = ${fiscalYear}
  `) as Array<{
    gl_account_id: string;
    account_code: string;
    period_amounts: Record<string, unknown> | null;
    annual_amount: string | number | null;
  }>;

  const budgets: Record<string, number> = {};
  for (const row of budgetRows) {
    const total = sumBudgetForWindow(
      row.period_amounts ?? {},
      Number(row.annual_amount ?? 0),
      monthKeys,
    );
    budgets[row.account_code] = total;
    budgets[row.gl_account_id] = total;
  }

  // is_active is absent on purpose: it is a picker flag, and an account
  // deactivated mid-year still spent what it spent.
  const actuals = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name, ga.account_type,
           COALESCE(
             CASE WHEN ga.account_type = 'revenue' THEN b.credit_less_debit
                  ELSE b.debit_less_credit END
           , 0)::numeric AS actual_amount
    FROM gl_accounts ga
    LEFT JOIN (
      SELECT jl.gl_account_id,
             SUM(jl.debit - jl.credit) AS debit_less_credit,
             SUM(jl.credit - jl.debit) AS credit_less_debit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
      GROUP BY jl.gl_account_id
    ) b ON b.gl_account_id = ga.id
    WHERE ga.company_id = ${companyId}::UUID
      AND ga.account_type IN ('expense', 'revenue')
    ORDER BY ga.account_code
  `) as Array<RawActualRow & { id: string }>;

  const postedRows = (await sql`
    SELECT MAX(je.entry_date)::text AS posted_through
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
  `) as Array<{ posted_through: string | null }>;

  const byId = new Map(actuals.map((a) => [a.account_code, a.id]));
  const lines = buildBudgetVsActualLines(actuals, budgets).map<BudgetVarianceRow>((l) => ({
    ...l,
    account_id: String(byId.get(l.account_code) ?? ''),
  }));

  const rows = lines.filter((l) => l.budget_amount !== 0);
  const unbudgeted = lines.filter((l) => l.budget_amount === 0);

  return {
    fiscalYear,
    monthKeys: [...monthKeys],
    rows,
    unbudgeted,
    // Every revenue and expense account the actuals query returned, before
    // the budgeted/unbudgeted split — the candidate set itself, not the sum of
    // the two halves buildEnvelope checks against. An account lost from BOTH
    // halves changes this number; it could not change the old one.
    universeTotal: lines.length,
    totals: {
      budget: round2(rows.reduce((s, l) => s + l.budget_amount, 0)),
      actual: round2(rows.reduce((s, l) => s + l.actual_amount, 0)),
      variance: round2(rows.reduce((s, l) => s + l.variance, 0)),
    },
    unbudgetedMovement: round2(
      unbudgeted.reduce((s, l) => s + Math.abs(l.actual_amount), 0),
    ),
    postedThrough: postedRows[0]?.posted_through ?? null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
