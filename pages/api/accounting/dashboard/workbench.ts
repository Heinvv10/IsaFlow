/**
 * GET /api/accounting/dashboard/workbench
 *
 * Returns the six Accounting Workbench exception metrics for the current
 * company. Used by the WorkbenchSection dashboard widget.
 *
 * Error handling is delegated to withErrorHandler.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getWorkbenchMetrics } from '@/modules/accounting/services/dashboard/workbenchService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const metrics = await getWorkbenchMetrics(companyId);
  return apiResponse.success(res, metrics);
}

export default withAuth(withErrorHandler(handler));
