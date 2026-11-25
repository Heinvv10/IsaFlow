/** GET — one payment message of this company (F) with its state word and, while open and the flag is on, its match suggestions (never stored). Read only; another company's or another kind: 404. */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { isUuidParam } from '@/lib/validation';
import { loadPaymentDetail } from '@/modules/accounting/services/intercompany/paymentInbox';
import { respondIfPaymentRefusal } from '@/modules/accounting/services/intercompany/paymentRoute';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  try {
    return apiResponse.success(res, await loadPaymentDetail(req.companyId, id.toLowerCase()));
  } catch (err) {
    if (respondIfPaymentRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(handler));
