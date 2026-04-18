/**
 * Consolidation: Consolidated Trial Balance API
 * GET — consolidated trial balance across parent + subsidiaries
 *   ?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getConsolidatedTrialBalance } from '@/modules/accounting/services/reports/consolidationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const periodStart = req.query.periodStart as string | undefined;
  const periodEnd   = req.query.periodEnd   as string | undefined;

  if (!periodStart || !periodEnd) {
    return apiResponse.badRequest(res, 'periodStart and periodEnd are required (YYYY-MM-DD)');
  }

  const report = await getConsolidatedTrialBalance(companyId, periodStart, periodEnd);
  return apiResponse.success(res, report);
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
