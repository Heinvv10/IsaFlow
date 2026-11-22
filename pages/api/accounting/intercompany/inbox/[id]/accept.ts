/**
 * POST — accept an inbox message: creates a DRAFT supplier invoice (or supplier credit note) in this company from the sender's
 * snapshot, marks the message accepted and links the two documents. Nothing is approved or posted.
 * Body (optional): { lineAccounts?: { "<line index>": accountId }, accountId?: <credit note account> }; a line left out uses the suggestion.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { isUuidParam } from '@/lib/validation';
import { acceptMessage } from '@/modules/accounting/services/intercompany/acceptService';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { parseAcceptBody } from '@/modules/accounting/services/intercompany/inboxValidation';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  const parsed = parseAcceptBody(req.body);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  try {
    const result = await acceptMessage(req.user.id, req.companyId, id.toLowerCase(), parsed.value);
    return apiResponse.success(res, result, 'Accepted as a draft');
  } catch (err) {
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
