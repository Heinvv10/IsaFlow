/**
 * Bank Feed Sync Logs — retrieve sync history for a connection
 * GET /api/accounting/bank-feeds/[id]/logs
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { getBankFeedSyncLogs } from '@/modules/accounting/services/bank/openBankingService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;
  const connectionId = req.query.id as string;

  if (!connectionId) {
    return apiResponse.badRequest(res, 'Connection ID is required');
  }

  if (req.method === 'GET') {
    const limitParam = req.query.limit;
    const limit = limitParam ? Math.min(parseInt(String(limitParam), 10) || 10, 50) : 10;
    const logs = await getBankFeedSyncLogs(companyId, connectionId, limit);
    return apiResponse.success(res, { items: logs, count: logs.length });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
}

export default withCompany(withErrorHandler(handler as any));
