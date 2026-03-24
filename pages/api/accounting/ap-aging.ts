/**
 * AP Aging Report API
 * GET /api/accounting/ap-aging - AP aging buckets by supplier
 * GET /api/accounting/ap-aging?supplier_id=123 - Aging detail for one supplier
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAPAging, getAPAgingDetail } from '@/modules/accounting/services/apAgingService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const { supplier_id, as_at_date } = req.query;
    const asAtDate = as_at_date as string | undefined;

    if (supplier_id) {
      const detail = await getAPAgingDetail(supplier_id as string, asAtDate);
      return apiResponse.success(res, detail);
    }

    const aging = await getAPAging(asAtDate);
    return apiResponse.success(res, aging);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get AP aging';
    log.error('Failed to get AP aging', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
