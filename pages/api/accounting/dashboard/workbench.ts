/**
 * GET /api/accounting/dashboard/workbench
 *
 * Returns the six Accounting Workbench exception metrics for the current
 * company. Used by the WorkbenchSection dashboard widget.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getWorkbenchMetrics } from '@/modules/accounting/services/dashboard/workbenchService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const metrics = await getWorkbenchMetrics(companyId);
    return apiResponse.success(res, metrics);
  } catch (err) {
    log.error('Failed to load workbench metrics', { error: err }, 'workbench-api');
    return apiResponse.internalError(res, err, 'Failed to load workbench metrics');
  }
}

export default withAuth(withErrorHandler(handler));
