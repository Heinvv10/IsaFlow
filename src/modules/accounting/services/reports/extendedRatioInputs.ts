/**
 * THE ONE READ BEHIND THE FINANCIAL ANALYSIS SCREEN'S RATIOS.
 *
 * The screen shows a KPI scorecard, a ratio list and ratio trends, served by
 * three endpoints. Each built its own engine input: the ratio list read
 * interest, tax, employee cost and direct materials off the ledger, and the
 * other two did not — so the scorecard said interest cover could not be
 * stated a few centimetres above a list printing it as a figure. All three
 * call this.
 *
 * WHAT IT SUPPLIES IS WHAT THE ENGINE MAY CALL "RECORDED". A figure read here
 * and found nil is supplied as 0, which the engine reports as "none recorded
 * in the period" — true, because this looked. A figure this does NOT read
 * (dividends, cash flows, capital expenditure) is left undefined, which the
 * engine reports as "not captured in this report". See `ratioBasis.ts`.
 *
 * One query after another: under `withAuth` the request holds one pg client.
 */
import { sql } from '@/lib/neon';
import { rawSubtypesFor } from '@/modules/accounting/services/gl/accountSubtypes';
import { TAX_EXPENSE_SUBTYPES } from '@/modules/accounting/services/gl/accountClassification';
import {
  getFinancialFigures, toFinancialData, type PeriodFigures,
} from '@/modules/accounting/services/gl/financialFiguresService';
import type { FinancialData } from './ratioTypes';

type Row = Record<string, unknown>;

const amount = (value: unknown): number => {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

export async function readExtendedRatioInputs(
  companyId: string,
  from: string,
  to: string,
): Promise<{ data: FinancialData; figures: PeriodFigures }> {
  // Balance sheet + P&L come from the shared classification resolver; the AFS
  // Master v15 amounts below are subtype-specific and stay a separate query.
  const figures = await getFinancialFigures(companyId, from, to);
  const [headCount] = (await sql`
    SELECT COUNT(*)::int AS count
    FROM payroll_employees
    WHERE company_id = ${companyId}::uuid AND (end_date IS NULL OR end_date > NOW())
  `) as Row[];
  // AFS Master v15: interest, employee costs, tax by account subtype
  const [subtypeTotals] = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_subtype = ANY(${rawSubtypesFor('finance_cost')}::TEXT[])
        THEN jl.debit - jl.credit ELSE 0 END), 0) AS interest_expense,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'interest_income'
        THEN jl.credit - jl.debit ELSE 0 END), 0) AS interest_income,
      COALESCE(SUM(CASE WHEN ga.account_subtype = ANY(${[...rawSubtypesFor('payroll_expense'),
        'uif', 'medical_aid', 'provident_fund', 'leave_pay', 'bonuses']}::TEXT[])
        THEN jl.debit - jl.credit ELSE 0 END), 0) AS employee_costs,
      -- Two hand-picked spellings reported R0.00 tax for a company whose tax
      -- accounts use the vocabulary's own. account_type = 'expense' keeps the
      -- raw 'tax' a VAT control account carries out of an income-tax figure.
      COALESCE(SUM(CASE WHEN ga.account_type = 'expense'
          AND ga.account_subtype = ANY(${TAX_EXPENSE_SUBTYPES as string[]}::TEXT[])
        THEN jl.debit - jl.credit ELSE 0 END), 0) AS tax_expense,
      COALESCE(SUM(CASE WHEN ga.account_subtype = 'raw_materials'
        THEN jl.debit - jl.credit ELSE 0 END), 0) AS direct_materials
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID AND je.status = 'posted'
      AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
  `) as Row[];

  const data: FinancialData = {
    ...toFinancialData(figures),
    employeeCount: amount(headCount?.count),
    interestExpense: amount(subtypeTotals?.interest_expense),
    interestIncome: amount(subtypeTotals?.interest_income),
    employeeCosts: amount(subtypeTotals?.employee_costs),
    taxExpense: amount(subtypeTotals?.tax_expense),
    directMaterialCosts: amount(subtypeTotals?.direct_materials),
  };
  return { data, figures };
}
