/**
 * Extended Financial Ratios API
 * GET /api/accounting/reports-extended-ratios?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';
import { rawSubtypesFor } from '@/modules/accounting/services/gl/accountSubtypes';
import {
  getFinancialFigures,
  toFinancialData,
  inventoryWarning,
  unclassifiedWarning,
  type PeriodFigures,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const from: string = (req.query.from as string) || '2026-01-01';
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!

  const { data, figures } = await buildFinancialData(companyId, from, to);
  const ratios = calculateExtendedRatios(data);

  return apiResponse.success(res, {
    period: { from, to },
    ratios,
    financialData: data,
    inventory: inventoryWarning(figures),
    unclassifiedAccounts: unclassifiedWarning(figures.cumulative),
  });
}

async function buildFinancialData(
  companyId: string,
  from: string,
  to: string
): Promise<{ data: FinancialData; figures: PeriodFigures }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Row = Record<string, any>;

  // Balance sheet + P&L come from the shared classification resolver; the AFS
  // Master v15 amounts below are subtype-specific and stay a separate query.
  const [figures, [empCount], [subtypeTotals]] = await Promise.all([
    getFinancialFigures(companyId, from, to),
    sql`SELECT COUNT(*)::int as count FROM payroll_employees WHERE company_id = ${companyId}::uuid AND (end_date IS NULL OR end_date > NOW())` as Promise<Row[]>,
    // AFS Master v15: interest, employee costs, tax by account subtype
    sql`
      SELECT
        COALESCE(SUM(CASE WHEN ga.account_subtype = ANY(${rawSubtypesFor('finance_cost')}::TEXT[])
          THEN jl.debit - jl.credit ELSE 0 END), 0) as interest_expense,
        COALESCE(SUM(CASE WHEN ga.account_subtype = 'interest_income'
          THEN jl.credit - jl.debit ELSE 0 END), 0) as interest_income,
        COALESCE(SUM(CASE WHEN ga.account_subtype = ANY(${[...rawSubtypesFor('payroll_expense'),
          'uif', 'medical_aid', 'provident_fund', 'leave_pay', 'bonuses']}::TEXT[])
          THEN jl.debit - jl.credit ELSE 0 END), 0) as employee_costs,
        COALESCE(SUM(CASE WHEN ga.account_subtype IN ('income_tax_expense', 'deferred_tax_expense')
          THEN jl.debit - jl.credit ELSE 0 END), 0) as tax_expense,
        COALESCE(SUM(CASE WHEN ga.account_subtype = 'raw_materials'
          THEN jl.debit - jl.credit ELSE 0 END), 0) as direct_materials
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId} AND jl.company_id = ${companyId}::UUID AND je.status = 'posted'
        AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
    ` as Promise<Row[]>,
  ]);

  const data: FinancialData = {
    ...toFinancialData(figures),
    employeeCount: empCount?.count || 0,
    // AFS Master v15 additions
    interestExpense: parseFloat(subtypeTotals?.interest_expense || '0'),
    interestIncome: parseFloat(subtypeTotals?.interest_income || '0'),
    employeeCosts: parseFloat(subtypeTotals?.employee_costs || '0'),
    taxExpense: parseFloat(subtypeTotals?.tax_expense || '0'),
    directMaterialCosts: parseFloat(subtypeTotals?.direct_materials || '0'),
  };
  return { data, figures };
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
