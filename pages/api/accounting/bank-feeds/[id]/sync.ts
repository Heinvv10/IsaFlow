/**
 * Bank Feed Sync — trigger a manual sync for a connection
 * POST /api/accounting/bank-feeds/[id]/sync
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { syncBankFeed } from '@/modules/accounting/services/openBankingService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;
  const connectionId = req.query.id as string;

  if (!connectionId) {
    return apiResponse.badRequest(res, 'Connection ID is required');
  }

  if (req.method === 'POST') {
    const result = await syncBankFeed(companyId, connectionId, userId);
    return apiResponse.success(res, result);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
}

export default withCompany(withErrorHandler(handler as any));
