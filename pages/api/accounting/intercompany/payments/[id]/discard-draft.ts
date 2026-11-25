/**
 * POST { paymentId, reason } — discard the F draft receipt an accepted payment message names (F, (k) Q1): the draft is cancelled, the message
 * is open again with no target, one audit row. Needs Approve on Customers & AR (as the receipt cancel) and your own session; 409 when the
 * receipt is not this message's draft any more (confirmed, cancelled, another receipt). Nothing posts.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { isUuidParam } from '@/lib/validation';
import { refuseWithoutApprove } from '@/modules/accounting/services/core/approvePermissionResponse';
import { discardIcDraftReceipt } from '@/modules/accounting/services/intercompany/paymentDiscardService';
import { respondIfPaymentRefusal } from '@/modules/accounting/services/intercompany/paymentRoute';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  const body = (req.body ?? {}) as { paymentId?: unknown; reason?: unknown };
  if (!isUuidParam(body.paymentId)) return apiResponse.badRequest(res, 'paymentId must be a valid UUID');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length === 0 || reason.length > 200) return apiResponse.badRequest(res, 'A reason (up to 200 characters) is required');
  if (await refuseWithoutApprove(res, req.companyId, req.user.id, 'customers', 'customer receipts')) return;
  try {
    const out = await discardIcDraftReceipt({ companyId: req.companyId, messageId: id.toLowerCase(), userId: req.user.id, paymentId: body.paymentId.toLowerCase(), reason });
    return apiResponse.success(res, out, 'Draft discarded');
  } catch (err) {
    if (respondIfPaymentRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
