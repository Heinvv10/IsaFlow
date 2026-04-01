/**
 * KPI Scorecard API
 * GET /api/accounting/reports-kpi-scorecard?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reportingEngineService';
import { buildKPIScorecard, type KPITargetConfig } from '@/modules/accounting/services/kpiScorecardService';

// Default SA business targets
const DEFAULT_TARGETS: KPITargetConfig[] = [
  { ratioKey: 'grossProfitMargin', target: 35, warningThreshold: 25, criticalThreshold: 15, lowerIsBetter: false },
  { ratioKey: 'netProfitMargin', target: 15, warningThreshold: 8, criticalThreshold: 3, lowerIsBetter: false },
  { ratioKey: 'currentRatio', target: 1.5, warningThreshold: 1.2, criticalThreshold: 1.0, lowerIsBetter: false },
  { ratioKey: 'quickRatio', target: 1.0, warningThreshold: 0.8, criticalThreshold: 0.5, lowerIsBetter: false },
  { ratioKey: 'debtToEquity', target: 0.5, warningThreshold: 1.0, criticalThreshold: 1.5, lowerIsBetter: true },
  { ratioKey: 'returnOnEquity', target: 15, warningThreshold: 10, criticalThreshold: 5, lowerIsBetter: false },
  { ratioKey: 'debtorDays', target: 45, warningThreshold: 60, criticalThreshold: 90, lowerIsBetter: true },
  { ratioKey: 'creditorDays', target: 60, warningThreshold: 45, criticalThreshold: 30, lowerIsBetter: false },
  { ratioKey: 'cashRatio', target: 0.3, warningThreshold: 0.2, criticalThreshold: 0.1, lowerIsBetter: false },
  { ratioKey: 'interestCoverage', target: 3.0, warningThreshold: 2.0, criticalThreshold: 1.0, lowerIsBetter: false },
  { ratioKey: 'ebitdaMargin', target: 20, warningThreshold: 12, criticalThreshold: 5, lowerIsBetter: false },
  { ratioKey: 'assetTurnover', target: 0.5, warningThreshold: 0.3, criticalThreshold: 0.1, lowerIsBetter: false },
];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const from: string = (req.query.from as string) || '2026-01-01';
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!

  const data = await buildFinancialData(companyId, from, to);
  const ratios = calculateExtendedRatios(data);
  const scorecard = buildKPIScorecard(ratios, DEFAULT_TARGETS);

  const summary = {
    green: scorecard.filter(s => s.status === 'green').length,
    amber: scorecard.filter(s => s.status === 'amber').length,
    red: scorecard.filter(s => s.status === 'red').length,
    total: scorecard.length,
  };

  return apiResponse.success(res, { period: { from, to }, scorecard, summary });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function buildFinancialData(companyId: string, from: string, to: string): Promise<FinancialData> {
  const [totals] = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '4%' THEN jl.credit - jl.debit ELSE 0 END), 0) as revenue,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '5%' AND ga.account_code < '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as cost_of_sales,
      COALESCE(SUM(CASE WHEN ga.account_code >= '5200' THEN jl.debit - jl.credit ELSE 0 END), 0) as operating_expenses,
      COALESCE(SUM(CASE WHEN ga.account_code = '5800' THEN jl.debit - jl.credit ELSE 0 END), 0) as depreciation
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted'
      AND je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
  `) as Row[];

  const [bal] = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '1%' THEN jl.debit - jl.credit ELSE 0 END), 0) as total_assets,
      COALESCE(SUM(CASE WHEN ga.account_code LIKE '2%' THEN jl.credit - jl.debit ELSE 0 END), 0) as total_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_code >= '1100' AND ga.account_code < '1200' THEN jl.debit - jl.credit ELSE 0 END), 0) as current_assets,
      COALESCE(SUM(CASE WHEN ga.account_code >= '2100' AND ga.account_code < '2200' THEN jl.credit - jl.debit ELSE 0 END), 0) as current_liabilities,
      COALESCE(SUM(CASE WHEN ga.account_code = '1110' THEN jl.debit - jl.credit ELSE 0 END), 0) as cash,
      COALESCE(SUM(CASE WHEN ga.account_code = '1120' THEN jl.debit - jl.credit ELSE 0 END), 0) as ar,
      COALESCE(SUM(CASE WHEN ga.account_code = '2110' THEN jl.credit - jl.debit ELSE 0 END), 0) as ap
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.company_id = ${companyId} AND je.status = 'posted' AND je.entry_date <= ${to}::date
  `) as Row[];

  const [empCount] = (await sql`SELECT COUNT(*)::int as count FROM employees WHERE company_id = ${companyId} AND status = 'active'`) as Row[];

  const revenue = parseFloat(totals?.revenue || '0');
  const cos = parseFloat(totals?.cost_of_sales || '0');
  const opex = parseFloat(totals?.operating_expenses || '0');

  return {
    revenue, costOfSales: cos, operatingExpenses: opex, netProfit: revenue - cos - opex,
    totalAssets: parseFloat(bal?.total_assets || '0'),
    totalLiabilities: parseFloat(bal?.total_liabilities || '0'),
    totalEquity: Math.max(1, parseFloat(bal?.total_assets || '0') - parseFloat(bal?.total_liabilities || '0')),
    currentAssets: parseFloat(bal?.current_assets || '0'),
    currentLiabilities: parseFloat(bal?.current_liabilities || '0'),
    inventory: 0,
    accountsReceivable: parseFloat(bal?.ar || '0'),
    accountsPayable: parseFloat(bal?.ap || '0'),
    cash: parseFloat(bal?.cash || '0'),
    depreciation: parseFloat(totals?.depreciation || '0'),
    employeeCount: empCount?.count || 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
