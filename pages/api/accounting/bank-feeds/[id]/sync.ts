/**
 * Bank Feed Sync — trigger a manual sync for a connection
 * POST /api/accounting/bank-feeds/[id]/sync
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  syncBankFeed,
  BankFeedProviderNotImplementedError,
} from '@/modules/accounting/services/bank/openBankingService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;
  const connectionId = req.query.id as string;

  if (!connectionId) {
    return apiResponse.badRequest(res, 'Connection ID is required');
  }

  if (req.method === 'POST') {
    try {
      const result = await syncBankFeed(companyId, connectionId, userId);
      return apiResponse.success(res, result);
    } catch (err) {
      // A provider with no integration is a permanent, expected answer, not a
      // server fault. Answering 4xx keeps the failed sync log and the
      // connection's last_sync_error — withAuth only ROLLBACKs on >= 500.
      if (err instanceof BankFeedProviderNotImplementedError) {
        return apiResponse.badRequest(res, err.message);
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
