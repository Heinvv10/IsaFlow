/**
 * GET — the group companies this company could open an intercompany connection with (current members of a
 * group this company is in, where the user can write in both companies).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listGroupCandidates } from '@/modules/accounting/services/intercompany/connectionService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const items = await listGroupCandidates(req.user.id, req.companyId);
  return apiResponse.success(res, { items, count: items.length });
}

export default withAuth(withErrorHandler(handler));
