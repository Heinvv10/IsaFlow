/**
 * Archived Data API (read-only)
 * GET /api/accounting/archived-data?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&limit=50&offset=0
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getArchivedEntries } from '@/modules/accounting/services/dataArchivingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { date_from, date_to, limit, offset } = req.query;

  try {
    const result = await getArchivedEntries(companyId, {
      dateFrom: typeof date_from === 'string' ? date_from : undefined,
      dateTo: typeof date_to === 'string' ? date_to : undefined,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to get archived data', { companyId, error: err }, 'archived-data-api');
    return apiResponse.internalError(res, err, 'Failed to retrieve archived data');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
