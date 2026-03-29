/**
 * Waterfall Chart API
 * GET /api/accounting/reports-waterfall?type=profit|cashflow|variance&from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { buildProfitWaterfall, buildCashFlowWaterfall } from '@/modules/accounting/services/waterfallDataService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const type = (req.query.type as string) || 'profit';
  const from: string = (req.query.from as string) || '2026-01-01';
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!;

  if (type === 'profit') {
    const [totals] = (await sql`
      SELECT
        COALESCE(SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END), 0) as revenue,
        COALESCE(SUM(CASE WHEN ga.account_code LIKE '5%' AND ga.account_code < '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as cost_of_sales,
        COALESCE(SUM(CASE WHEN ga.account_code >= '5200' AND ga.account_code < '5800' THEN jl.debit - jl.credit ELSE 0 END), 0) as operating_expenses,
        COALESCE(SUM(CASE WHEN ga.account_code = '4300' THEN jl.credit - jl.debit ELSE 0 END), 0) as other_income
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId} AND je.status = 'posted'
        AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
    `) as Row[];

    const revenue = parseFloat(totals?.revenue || '0');
    const cos = parseFloat(totals?.cost_of_sales || '0');
    const opex = parseFloat(totals?.operating_expenses || '0');
    const otherIncome = parseFloat(totals?.other_income || '0');
    const grossProfit = revenue - cos;
    const netProfit = grossProfit - opex + otherIncome;

    const steps = buildProfitWaterfall({
      revenue, costOfSales: cos, grossProfit,
      operatingExpenses: opex, otherIncome, otherExpenses: 0, netProfit,
    });

    return apiResponse.success(res, { type: 'profit', period: { from, to }, steps });
  }

  if (type === 'cashflow') {
    const [cf] = (await sql`
      SELECT
        COALESCE(SUM(CASE WHEN ga.account_code = '1110' AND je.entry_date < ${from}::date THEN jl.debit - jl.credit ELSE 0 END), 0) as opening,
        COALESCE(SUM(CASE WHEN ga.account_code = '1110' AND je.entry_date >= ${from}::date AND jl.debit > 0 THEN jl.debit ELSE 0 END), 0) as inflows,
        COALESCE(SUM(CASE WHEN ga.account_code = '1110' AND je.entry_date >= ${from}::date AND jl.credit > 0 THEN -jl.credit ELSE 0 END), 0) as outflows
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId} AND je.status = 'posted'
        AND je.entry_date <= ${to}::date
    `) as Row[];

    const opening = parseFloat(cf?.opening || '0');
    const inflows = parseFloat(cf?.inflows || '0');
    const outflows = parseFloat(cf?.outflows || '0');
    const closing = opening + inflows + outflows;

    const steps = buildCashFlowWaterfall({
      opening, operatingIn: inflows, operatingOut: outflows,
      investingNet: 0, financingNet: 0, closing,
    });

    return apiResponse.success(res, { type: 'cashflow', period: { from, to }, steps });
  }

  return apiResponse.badRequest(res, 'type must be "profit" or "cashflow"');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
