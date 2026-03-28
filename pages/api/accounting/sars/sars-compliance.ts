/**
 * SARS Compliance Calendar API
 * GET ?year=YYYY — get compliance calendar with upcoming deadlines
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getComplianceCalendarWithDB } from '@/modules/accounting/services/sarsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const year = req.query.year ? Number(req.query.year) : undefined;
    const events = await getComplianceCalendarWithDB(companyId, year);
    return apiResponse.success(res, { events });
  } catch (err) {
    log.error('Failed to get compliance calendar', { error: err }, 'sars-api');
    return apiResponse.badRequest(res, 'Failed to load compliance calendar');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
