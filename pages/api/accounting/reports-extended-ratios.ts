/**
 * Extended Financial Ratios API
 * GET /api/accounting/reports-extended-ratios?from=YYYY-MM-DD&to=YYYY-MM-DD
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

  // The same read the KPI scorecard and the ratio trends on this screen use.
  const { data, figures } = await readExtendedRatioInputs(companyId, from, to);
  const ratios = calculateExtendedRatios(data);

  return apiResponse.success(res, {
    period: { from, to },
    ratios,
    financialData: data,
    inventory: inventoryWarning(figures),
    unclassifiedAccounts: unclassifiedWarning(figures.cumulative),
  });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
