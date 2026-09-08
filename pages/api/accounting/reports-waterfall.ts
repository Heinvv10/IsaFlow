/**
 * Waterfall Chart API
 * GET /api/accounting/reports-waterfall?type=profit|cashflow|variance&from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';
import { CASH_SUBTYPES } from '@/modules/accounting/services/gl/accountClassification';
import {
  getFinancialFigures,
  unclassifiedWarning,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { buildProfitWaterfall, buildCashFlowWaterfall } from '@/modules/accounting/services/reports/waterfallDataService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const type = (req.query.type as string) || 'profit';
  const from: string = (req.query.from as string) || '2026-01-01';
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!;

  if (type === 'profit') {
    const { period, cumulative } = await getFinancialFigures(companyId, from, to);

    const { steps } = buildProfitWaterfall({
      revenue: period.revenue,
      costOfSales: period.costOfSales,
      grossProfit: period.grossProfit,
      operatingExpenses: period.operatingExpenses,
      otherIncome: period.otherIncome,
      otherExpenses: period.otherExpenses,
      netProfit: period.netProfit,
    });

    return apiResponse.success(res, {
      type: 'profit',
      period: { from, to },
      steps,
      unclassifiedAccounts: unclassifiedWarning(cumulative),
    });
  }

  if (type === 'cashflow') {
    const [cf] = (await sql`
      SELECT
        COALESCE(SUM(CASE WHEN je.entry_date < ${from}::date THEN jl.debit - jl.credit ELSE 0 END), 0) as opening,
        COALESCE(SUM(CASE WHEN je.entry_date >= ${from}::date AND jl.debit > 0 THEN jl.debit ELSE 0 END), 0) as inflows,
        COALESCE(SUM(CASE WHEN je.entry_date >= ${from}::date AND jl.credit > 0 THEN -jl.credit ELSE 0 END), 0) as outflows
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId} AND jl.company_id = ${companyId}::UUID AND je.status = 'posted'
        AND ga.account_type = 'asset'
        AND ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[])
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

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
