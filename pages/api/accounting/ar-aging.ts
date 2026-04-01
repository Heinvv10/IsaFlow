/**
 * AR Aging Report API
 * GET /api/accounting/ar-aging
 *   ?as_at_date=YYYY-MM-DD  - optional, defaults to today
 *   ?client_id=UUID          - optional, returns detail for single client
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getARAging, getARAgingDetail } from '@/modules/accounting/services/arAgingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const { as_at_date, client_id } = req.query;
    const asAtDate = as_at_date ? String(as_at_date) : undefined;

    if (client_id) {
      const detail = await getARAgingDetail(companyId, String(client_id), asAtDate);
      return apiResponse.success(res, detail);
    }

    const buckets = await getARAging(companyId, asAtDate);
    return apiResponse.success(res, buckets);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get AR aging';
    log.error('Failed to get AR aging', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
