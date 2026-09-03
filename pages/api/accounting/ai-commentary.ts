/**
 * AI Commentary API
 * POST /api/accounting/ai-commentary
 * Body: { from: string, to: string }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { getFinancialFigures } from '@/modules/accounting/services/gl/financialFiguresService';
import { log } from '@/lib/logger';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import {
  identifyKeyDrivers,
  assessRiskAreas,
  buildExecutiveSummary,
  type ManagementPackData,
} from '@/modules/accounting/services/reports/aiCommentaryService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);

  const ip = getClientIp(req);
  const { companyId } = req as CompanyAuthedRequest;
  if (!(await checkRateLimit(`ai-commentary:ip:${ip}`, { max: 30, windowSecs: 15 * 60 }))) {
    return apiResponse.tooManyRequests(res);
  }
  if (!(await checkRateLimit(`ai-commentary:company:${companyId}`, { max: 60, windowSecs: 15 * 60 }))) {
    return apiResponse.tooManyRequests(res);
  }
  const { from, to } = req.body as { from?: string; to?: string };

  if (!from || !to) return apiResponse.badRequest(res, 'from and to dates are required');

  log.info('ai-commentary: building management pack data', { companyId, from, to });

  // Prior period: same duration ending one day before 'from'
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const durationMs = toDate.getTime() - fromDate.getTime();
  const priorTo = new Date(fromDate.getTime() - 86400000);
  const priorFrom = new Date(priorTo.getTime() - durationMs);
  const priorFromStr = priorFrom.toISOString().split('T')[0]!;
  const priorToStr = priorTo.toISOString().split('T')[0]!;

  const [current, prior] = await Promise.all([
    getFinancialFigures(companyId, from, to),
    getFinancialFigures(companyId, priorFromStr, priorToStr),
  ]);

  const [company] = (await sql`
    SELECT name FROM companies WHERE id = ${companyId}
  `) as Row[];

  // Build ManagementPackData
  const { period, cumulative } = current;
  const revenue = period.revenue;
  const costOfSales = period.costOfSales;
  const operatingExpenses = period.operatingExpenses;
  const grossProfit = period.grossProfit;
  const netProfit = period.netProfit;

  const totalAssets = cumulative.totalAssets;
  const totalLiabilities = cumulative.totalLiabilities;
  // Current-year profit is not closed into retained earnings until year end.
  const totalEquity = cumulative.totalEquity + netProfit;
  const currentAssets = cumulative.currentAssets;
  const currentLiabilities = cumulative.currentLiabilities;
  const inventory = cumulative.inventory;

  const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;
  const debtEquityRatio = totalEquity > 0 ? totalLiabilities / totalEquity : 0;
  const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  const priorRevenue = prior.period.revenue;
  const priorCostOfSales = prior.period.costOfSales;
  const priorOperatingExpenses = prior.period.operatingExpenses;
  const priorGrossProfit = prior.period.grossProfit;
  const priorNetProfit = prior.period.netProfit;

  const packData: ManagementPackData = {
    companyName: company?.name ?? 'Company',
    period: `${from} to ${to}`,
    incomeStatement: { revenue, costOfSales, grossProfit, operatingExpenses, netProfit },
    balanceSheet: { totalAssets, totalLiabilities, equity: totalEquity, currentRatio, debtEquityRatio },
    priorPeriod: { revenue: priorRevenue, costOfSales: priorCostOfSales, grossProfit: priorGrossProfit, operatingExpenses: priorOperatingExpenses, netProfit: priorNetProfit },
    ratios: { grossMargin, netMargin, currentRatio, quickRatio: currentLiabilities > 0 ? (currentAssets - inventory) / currentLiabilities : 0 },
  };

  const keyDrivers = identifyKeyDrivers(packData.incomeStatement, packData.priorPeriod!);
  const riskAreas = assessRiskAreas(packData);
  const executiveSummary = buildExecutiveSummary(packData);

  log.info('ai-commentary: complete', { companyId, keyDriversCount: keyDrivers.length, riskCount: riskAreas.length });

  return apiResponse.success(res, {
    period: { from, to },
    executiveSummary,
    keyDrivers,
    riskAreas,
    financials: packData,
  });
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
