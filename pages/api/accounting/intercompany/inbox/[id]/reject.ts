/** POST { reason } — reject an inbox message; the reason (required) goes back to the sender's outbox. Touches only the message. */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { isUuidParam } from '@/lib/validation';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { rejectMessage } from '@/modules/accounting/services/intercompany/handleService';
import { parseRejectBody } from '@/modules/accounting/services/intercompany/inboxValidation';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  const parsed = parseRejectBody(req.body);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  try {
    await rejectMessage(req.companyId, id.toLowerCase(), parsed.value.reason);
    return apiResponse.success(res, { id: id.toLowerCase(), status: 'rejected' }, 'Rejected');
  } catch (err) {
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
