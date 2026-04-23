/**
 * GET /api/accounting/ar/disputes/[id] — fetch a single dispute (company-scoped).
 * PRD-06 Phase 3.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { getDispute } from '@/modules/accounting/services/ar/disputeService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
    return;
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    apiResponse.badRequest(res, 'Dispute id is required');
    return;
  }

  const dispute = await getDispute(companyId, id);
  if (!dispute) {
    apiResponse.notFound(res, 'Dispute');
    return;
  }
  apiResponse.success(res, dispute);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
