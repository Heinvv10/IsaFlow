/**
 * KPI Scorecard API
 * GET /api/accounting/reports-kpi-scorecard?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { fmtDate } from '@/lib/fmtDate';
import { reportWindowProblem } from '@/lib/validation';
import { inventoryWarning, unclassifiedWarning } from '@/modules/accounting/services/gl/financialFiguresService';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { readExtendedRatioInputs } from '@/modules/accounting/services/reports/extendedRatioInputs';
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
  // TODAY ON THIS HOST'S CALENDAR, as `reports-ratios` takes it:
  // `toISOString()` is UTC, which is yesterday from 00:00 to 02:00 SAST. And
  // the start of today's calendar year, not a year written into the code.
  const to: string = (req.query.to as string) || fmtDate(new Date());
  const from: string = (req.query.from as string) || `${to.slice(0, 4)}-01-01`;

  // As `reports-ratios` does: the day counts multiply by this window's length,
  // so a date it cannot read or a window that runs backwards is refused.
  const windowProblem = reportWindowProblem(from, to);
  if (windowProblem) return apiResponse.badRequest(res, windowProblem);

  // The same read the ratio list beside this scorecard uses, so the two
  // cannot state different things about one ratio.
  const { data, figures } = await readExtendedRatioInputs(companyId, from, to);
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

export default withAuth(withErrorHandler(withWriteAccess(handler)));
