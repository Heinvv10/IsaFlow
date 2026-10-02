/**
 * THE INCOME-STATEMENT LINES THE RATIO ENGINE NEEDS, FROM THE STATEMENT'S OWN
 * CLASSIFIER.
 *
 * Folds `GROUP BY account_type, account_subtype` movement — the rows
 * `aggregateFigures` folds — so a figure in a ratio is a sub-line of the line
 * the income statement prints, never a second opinion about an account.
 * ACCOUNT TYPE FIRST: a liability carrying the subtype `tax` is a VAT control
 * account, not income tax.
 *
 * INTEREST EXPENSE is the finance-cost band WITHOUT bank charges. The
 * vocabulary aliases `bank_charges` into `finance_cost` (so the AFS notes
 * print it once), and read whole, the band gave a debt-free company with bank
 * fees an interest cover in the hundreds. The generic `finance_cost` spelling
 * IS counted: the seeded chart's one finance-cost account is named "Interest
 * Expense" and carries it (21 of 21 companies in dev; their bank charges are
 * an operating expense), and finance cost that is not a bank fee is the cost
 * of borrowing. A new non-interest spelling aliased into the band belongs in
 * `NOT_INTEREST`.
 *
 * INTEREST INCOME is the raw spelling `interest_income` on a revenue account.
 * The vocabulary has no such band — the statement reports that account in
 * turnover — so this is a sub-line of a statement line that sits above the
 * operating line either way.
 *
 * EMPLOYEE COST is the `payroll_expense` band. `uif`, `medical_aid`,
 * `provident_fund`, `leave_pay` and `bonuses` were hand-added here and are
 * not in the vocabulary: the statement reports them as unclassified operating
 * expenses, so they are not employee cost until the vocabulary says so.
 *
 * THERE IS NO DIRECT-MATERIALS LINE. `raw_materials` is an inventory asset
 * subtype; summed, it was stock movement. Nothing supplies
 * `directMaterialCosts`, and the engine says the margin is not captured.
 */
import {
  canonicalSubtype, type ClassificationRow,
} from '@/modules/accounting/services/gl/accountClassification';

export interface LedgerRatioLines {
  interestExpense: number;
  interestIncome: number;
  employeeCosts: number;
  taxExpense: number;
}

/** Spellings the vocabulary bands as finance cost that are not a cost of borrowing. */
const NOT_INTEREST: ReadonlySet<string> = new Set(['bank_charges']);
const INTEREST_INCOME = 'interest_income';

/** The column's own normalisation (`canonicalSubtype`, migration 674). */
const spelling = (raw: string | null): string => (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n: number): number => Math.round(n * 100) / 100;

export function ledgerRatioLines(rows: readonly ClassificationRow[]): LedgerRatioLines {
  const lines: LedgerRatioLines = { interestExpense: 0, interestIncome: 0, employeeCosts: 0, taxExpense: 0 };

  for (const row of rows) {
    const debit = num(row.debit);
    const credit = num(row.credit);
    if (row.account_type === 'revenue') {
      if (spelling(row.account_subtype) === INTEREST_INCOME) lines.interestIncome += credit - debit;
      continue;
    }
    if (row.account_type !== 'expense') continue;
    const charge = debit - credit;
    switch (canonicalSubtype(row.account_subtype)) {
      case 'finance_cost':
        if (!NOT_INTEREST.has(spelling(row.account_subtype))) lines.interestExpense += charge;
        break;
      case 'tax_expense': lines.taxExpense += charge; break;
      case 'payroll_expense': lines.employeeCosts += charge; break;
      default: break;
    }
  }
  return {
    interestExpense: r2(lines.interestExpense), interestIncome: r2(lines.interestIncome),
    employeeCosts: r2(lines.employeeCosts), taxExpense: r2(lines.taxExpense),
  };
}
