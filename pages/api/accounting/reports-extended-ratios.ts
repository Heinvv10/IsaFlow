/**
 * Extended Financial Ratios API
 * GET /api/accounting/reports-extended-ratios?from=YYYY-MM-DD&to=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { inventoryWarning, unclassifiedWarning } from '@/modules/accounting/services/gl/financialFiguresService';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { readExtendedRatioInputs } from '@/modules/accounting/services/reports/extendedRatioInputs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const from: string = (req.query.from as string) || '2026-01-01';
  const to: string = (req.query.to as string) || new Date().toISOString().split('T')[0]!

  // As `reports-ratios` does: the day counts multiply by this window's length,
  // so a date it cannot read or a window that runs backwards is refused.
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return apiResponse.badRequest(res, 'from and to must be YYYY-MM-DD dates');
  }
  if (from > to) {
    return apiResponse.badRequest(res, 'from must not be after to');
  }

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
