/**
 * Report Pack API
 * GET /api/accounting/reports-pack?type=board|management|monthly&from=YYYY-MM-DD&to=YYYY-MM-DD
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
import { checkReportRateLimit } from '@/lib/rateLimit';
import {
  buildReportPack,
  type PackType,
  type ReportPackInput,
} from '@/modules/accounting/services/reports/reportPackService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const VALID_TYPES: PackType[] = ['board', 'management', 'monthly'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;

  if (!(await checkReportRateLimit(companyId, 'reports-pack'))) {
    log.warn('Report pack rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many report requests. Please try again shortly.');
  }

  const packType = (req.query.type as string) as PackType;
  const from: string = (req.query.from as string) || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]!;
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!;

  if (!packType || !VALID_TYPES.includes(packType)) {
    return apiResponse.badRequest(res, `type must be one of: ${VALID_TYPES.join(', ')}`);
  }

  const [figures, companyRow] = await Promise.all([
    getFinancialFigures(companyId, from, to),
    getCompanyName(companyId),
  ]);

  const { period, cumulative } = figures;
  const netProfit = period.netProfit;

  const data: ReportPackInput = {
    companyName: companyRow?.name || 'Company',
    period: `${from} to ${to}`,
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
    otherIncome: period.otherIncome,
    otherExpenses: period.otherExpenses,
  };

  const pack = buildReportPack(packType, data, from, to);

  log.info('Report pack generated', { companyId, packType, from, to }, 'accounting');

  return apiResponse.success(res, {
    pack,
    period: { from, to },
    unclassifiedAccounts: unclassifiedWarning(cumulative),
  });
}

async function getCompanyName(companyId: string): Promise<Row | null> {
  const rows = (await sql`
    SELECT name FROM companies WHERE id = ${companyId} LIMIT 1
  `) as Row[];
  return rows[0] || null;
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
