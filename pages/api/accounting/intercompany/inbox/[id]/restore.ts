/** POST — restore a dismissed inbox message to pending. */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { isUuidParam } from '@/lib/validation';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { restoreMessage } from '@/modules/accounting/services/intercompany/handleService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  try {
    await restoreMessage(req.companyId, id.toLowerCase());
    return apiResponse.success(res, { id: id.toLowerCase(), status: 'pending' }, 'Restored');
  } catch (err) {
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
