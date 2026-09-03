/**
 * KPI Scorecard API
 * GET /api/accounting/reports-kpi-scorecard?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';
import {
  getFinancialFigures,
  toFinancialData,
  inventoryWarning,
  unclassifiedWarning,
  type PeriodFigures,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';
import { buildKPIScorecard, type KPITargetConfig } from '@/modules/accounting/services/reports/kpiScorecardService';

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

  const { companyId } = req as CompanyAuthedRequest;
  const from: string = (req.query.from as string) || '2026-01-01';
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!

  const { data, figures } = await buildFinancialData(companyId, from, to);
  const ratios = calculateExtendedRatios(data);
  const scorecard = buildKPIScorecard(ratios, DEFAULT_TARGETS);

  const summary = {
    green: scorecard.filter(s => s.status === 'green').length,
    amber: scorecard.filter(s => s.status === 'amber').length,
    red: scorecard.filter(s => s.status === 'red').length,
    total: scorecard.length,
  };

  return apiResponse.success(res, {
    period: { from, to },
    scorecard,
    summary,
    inventory: inventoryWarning(figures),
    unclassifiedAccounts: unclassifiedWarning(figures.cumulative),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function buildFinancialData(
  companyId: string,
  from: string,
  to: string
): Promise<{ data: FinancialData; figures: PeriodFigures }> {
  const [figures, [empCount]] = await Promise.all([
    getFinancialFigures(companyId, from, to),
    sql`SELECT COUNT(*)::int as count FROM payroll_employees WHERE company_id = ${companyId}::uuid AND (end_date IS NULL OR end_date > NOW())` as Promise<Row[]>,
  ]);

  const data: FinancialData = {
    ...toFinancialData(figures),
    // Scorecard ratios divide by equity; guard the zero-equity chart of accounts.
    totalEquity: Math.max(
      1,
      figures.cumulative.totalEquity + figures.period.netProfit
    ),
    employeeCount: empCount?.count || 0,
  };
  return { data, figures };
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
