/**
 * Executive Summary API
 * GET /api/accounting/reports-executive-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';
import {
  getFinancialFigures,
  unclassifiedWarning,
  totalEquity,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { log } from '@/lib/logger';
import {
  buildExecutiveSummary,
  type ExecutiveSummaryInput,
} from '@/modules/accounting/services/reports/executiveSummaryService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const from: string = (req.query.from as string) || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]!;
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!;

  const { from: priorFrom, to: priorTo } = priorPeriod(from, to);

  const [figures, priorFigures, empCount, companyRow] = await Promise.all([
    getFinancialFigures(companyId, from, to),
    getFinancialFigures(companyId, priorFrom, priorTo),
    getEmployeeCount(companyId),
    sql`SELECT name FROM companies WHERE id = ${companyId} LIMIT 1` as Promise<Row[]>,
  ]);
  const companyName: string = (companyRow[0]?.name as string) || 'Company';

  const { period, cumulative } = figures;
  const netProfit = period.netProfit;

  const input: ExecutiveSummaryInput = {
    period: `${from} to ${to}`,
    companyName,
    revenue: period.revenue,
    costOfSales: period.costOfSales,
    operatingExpenses: period.operatingExpenses,
    netProfit,
    totalAssets: cumulative.totalAssets,
    totalLiabilities: cumulative.totalLiabilities,
    totalEquity: totalEquity(figures),
    currentAssets: cumulative.currentAssets,
    currentLiabilities: cumulative.currentLiabilities,
    cash: cumulative.cash,
    accountsReceivable: cumulative.accountsReceivable,
    accountsPayable: cumulative.accountsPayable,
    inventory: cumulative.inventory,
    priorRevenue: priorFigures.period.revenue || undefined,
    priorNetProfit: priorFigures.period.netProfit || undefined,
  };

  const summary = buildExecutiveSummary(input, from, to);

  log.info('Executive summary generated', { companyId, from, to, employees: empCount }, 'accounting');

  return apiResponse.success(res, {
    summary,
    period: { from, to },
    unclassifiedAccounts: unclassifiedWarning(cumulative),
  });
}

/** The equal-length window immediately before [from, to]. */
function priorPeriod(from: string, to: string): { from: string; to: string } {
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const daysDiff = Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
  return {
    from: new Date(fromDate.getTime() - (daysDiff + 1) * 86400000).toISOString().split('T')[0]!,
    to: new Date(fromDate.getTime() - 86400000).toISOString().split('T')[0]!,
  };
}

async function getEmployeeCount(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int as count FROM payroll_employees WHERE company_id = ${companyId}::uuid AND (end_date IS NULL OR end_date > NOW())
  `) as Row[];
  return rows[0]?.count || 0;
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
