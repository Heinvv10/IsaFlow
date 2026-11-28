/**
 * GET ?receiptId= — the receipt's intercompany chip (F, (l) LOW-2): the payment message whose TARGET is this receipt of the session company
 * and its state word, or null. Keyed on the message's target, never on the receipt's `IC:` text. Read only.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { isUuidParam } from '@/lib/validation';
import { receiptIcState } from '@/modules/accounting/services/intercompany/paymentInbox';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const id = req.query.receiptId;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'receiptId must be a valid UUID');
  return apiResponse.success(res, await receiptIcState(req.companyId, id.toLowerCase()));
}

export default withAuth(withErrorHandler(handler));
