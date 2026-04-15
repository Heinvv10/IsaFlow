/**
 * Bank Feed Connection — single-resource operations
 * DELETE /api/accounting/bank-feeds/[id] — soft-delete a connection
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { deleteBankFeedConnection } from '@/modules/accounting/services/bank/openBankingService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;
  const connectionId = req.query.id as string;

  if (!connectionId) {
    return apiResponse.badRequest(res, 'Connection ID is required');
  }

  if (req.method === 'DELETE') {
    await deleteBankFeedConnection(companyId, connectionId);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['DELETE']);
}

export default withCompany(withErrorHandler(handler));
