/**
 * GET /api/accounting/dashboard/attention
 *
 * The dashboard's one "Needs attention" list for the active company:
 * { asAt, items }. Read only. A failed reader answers 500 (withErrorHandler),
 * so the screen shows Retry rather than an all-clear.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getAttentionList } from '@/modules/accounting/services/dashboard/attentionService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  return apiResponse.success(res, await getAttentionList(companyId));
}

export default withAuth(withErrorHandler(handler));
