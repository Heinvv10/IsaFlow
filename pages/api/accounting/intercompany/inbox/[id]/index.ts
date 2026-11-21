/** GET — one inbox message with its lines, the account each will use, the supplier and what blocks Accept (P2). */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { isUuidParam } from '@/lib/validation';
import { previewAccept } from '@/modules/accounting/services/intercompany/acceptService';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  try {
    return apiResponse.success(res, await previewAccept(req.companyId, id.toLowerCase()));
  } catch (err) {
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(handler));
