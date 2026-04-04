/**
 * AI Commentary API
 * POST /api/accounting/ai-commentary
 * Body: { from: string, to: string }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  identifyKeyDrivers,
  assessRiskAreas,
  buildExecutiveSummary,
  type ManagementPackData,
} from '@/modules/accounting/services/aiCommentaryService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);

  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (checkRateLimit(`ai-commentary:${ip}`, { maxRequests: 30, windowMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
  }

  const { companyId } = req as CompanyApiRequest;
  const { from, to } = req.body as { from?: string; to?: string };

  if (!from || !to) return apiResponse.badRequest(res, 'from and to dates are required');

  log.info('ai-commentary: building management pack data', { companyId, from, to });

  // Current period financials
  const [currTotals] = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '5%' AND ga.account_code < '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) AS cost_of_sales,
      COALESCE(SUM(CASE WHEN ga.account_code >= '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) AS operating_expenses
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
  `) as Row[];

  const [currBalances] = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '1%' THEN jl.debit - jl.credit ELSE 0 END), 0) AS total_assets,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '2%' THEN jl.credit - jl.debit ELSE 0 END), 0) AS total_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '3%' THEN jl.credit - jl.debit ELSE 0 END), 0) AS total_equity,
      COALESCE(SUM(CASE WHEN ga.account_code >= '1100' AND ga.account_code < '1200' THEN jl.debit - jl.credit ELSE 0 END), 0) AS current_assets,
      COALESCE(SUM(CASE WHEN ga.account_code >= '2100' AND ga.account_code < '2200' THEN jl.credit - jl.debit ELSE 0 END), 0) AS current_liabilities
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date <= ${to}::date
  `) as Row[];

  // Prior period: same duration ending one day before 'from'
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const durationMs = toDate.getTime() - fromDate.getTime();
  const priorTo = new Date(fromDate.getTime() - 86400000);
  const priorFrom = new Date(priorTo.getTime() - durationMs);
  const priorFromStr = priorFrom.toISOString().split('T')[0]!;
  const priorToStr = priorTo.toISOString().split('T')[0]!;

  const [priorTotals] = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '5%' AND ga.account_code < '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) AS cost_of_sales,
      COALESCE(SUM(CASE WHEN ga.account_code >= '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) AS operating_expenses
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date >= ${priorFromStr}::date AND je.entry_date <= ${priorToStr}::date
  `) as Row[];

  const [company] = (await sql`
    SELECT name FROM companies WHERE id = ${companyId}
  `) as Row[];

  // Build ManagementPackData
  const revenue = parseFloat(currTotals?.revenue ?? '0');
  const costOfSales = parseFloat(currTotals?.cost_of_sales ?? '0');
  const operatingExpenses = parseFloat(currTotals?.operating_expenses ?? '0');
  const grossProfit = revenue - costOfSales;
  const netProfit = grossProfit - operatingExpenses;

  const totalAssets = parseFloat(currBalances?.total_assets ?? '0');
  const totalLiabilities = parseFloat(currBalances?.total_liabilities ?? '0');
  const totalEquity = parseFloat(currBalances?.total_equity ?? '0') + netProfit;
  const currentAssets = parseFloat(currBalances?.current_assets ?? '0');
  const currentLiabilities = parseFloat(currBalances?.current_liabilities ?? '0');

  const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;
  const debtEquityRatio = totalEquity > 0 ? totalLiabilities / totalEquity : 0;
  const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  const priorRevenue = parseFloat(priorTotals?.revenue ?? '0');
  const priorCostOfSales = parseFloat(priorTotals?.cost_of_sales ?? '0');
  const priorOperatingExpenses = parseFloat(priorTotals?.operating_expenses ?? '0');
  const priorGrossProfit = priorRevenue - priorCostOfSales;
  const priorNetProfit = priorGrossProfit - priorOperatingExpenses;

  const packData: ManagementPackData = {
    companyName: company?.name ?? 'Company',
    period: `${from} to ${to}`,
    incomeStatement: { revenue, costOfSales, grossProfit, operatingExpenses, netProfit },
    balanceSheet: { totalAssets, totalLiabilities, equity: totalEquity, currentRatio, debtEquityRatio },
    priorPeriod: { revenue: priorRevenue, costOfSales: priorCostOfSales, grossProfit: priorGrossProfit, operatingExpenses: priorOperatingExpenses, netProfit: priorNetProfit },
    ratios: { grossMargin, netMargin, currentRatio, quickRatio: currentRatio },
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
