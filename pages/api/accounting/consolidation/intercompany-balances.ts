/**
 * Consolidation: Intercompany Balances API
 * GET — intercompany elimination balances between group entities
 *   ?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { getIntercompanyBalances } from '@/modules/accounting/services/consolidationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const periodStart = req.query.periodStart as string | undefined;
  const periodEnd   = req.query.periodEnd   as string | undefined;

  if (!periodStart || !periodEnd) {
    return apiResponse.badRequest(res, 'periodStart and periodEnd are required (YYYY-MM-DD)');
  }

  const items = await getIntercompanyBalances(companyId, periodStart, periodEnd);
  return apiResponse.success(res, { items });
}

export default withCompany(withErrorHandler(handler as Parameters<typeof withCompany>[0]));
