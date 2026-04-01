/**
 * Archive Runs API
 * GET /api/accounting/archive-runs → list archive run history for company
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getArchiveRuns } from '@/modules/accounting/services/dataArchivingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const runs = await getArchiveRuns(companyId);
    return apiResponse.success(res, { runs });
  } catch (err) {
    log.error('Failed to get archive runs', { companyId, error: err }, 'archive-runs-api');
    return apiResponse.badRequest(res, 'Failed to retrieve archive run history');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
