/**
 * GET /api/billing/flows/bundles — active purchasable Flow bundles.
 * Open to any authenticated tenant (not gated to PAYG only) so the
 * upgrade-compare UI can render bundle pricing for Starter users.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { listActiveBundles } from '@/modules/billing/services/flowWalletService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const bundles = await listActiveBundles();
  return apiResponse.success(res, bundles);
}

export default withAuth(withErrorHandler(handler));
