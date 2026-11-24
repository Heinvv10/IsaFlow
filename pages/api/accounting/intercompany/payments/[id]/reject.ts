/**
 * POST { reason } — reject a payment message (F); final; the reason (required) is recorded on the message (nothing shows it to the payer yet).
 * Touches only the message: nothing is cleared.
 * AUTHORIZATION: withAuth (session + company), withCsrf, withWriteAccess (the write role) and no Login-as here; the rest lives in
 * `handleService.rejectPayment`, which refuses with a ConnectionRefusal 403 BEFORE anything is read or written: the receiver's dark flag off
 * (round 1 LOW-4), and no Approve on Customers & AR (`mayApprove(companyId, userId, 'customers')`, P4-D round 1). Pinned by
 * tests/integration/intercompany/payment-r1-handle.int.test.ts and tests/unit/services/intercompany/rejectPaymentAuth.test.ts.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { isUuidParam } from '@/lib/validation';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { rejectPayment } from '@/modules/accounting/services/intercompany/handleService';
import { parseRejectBody } from '@/modules/accounting/services/intercompany/inboxValidation';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  const parsed = parseRejectBody(req.body);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  try {
    // P4-D round 2 (A4): rejecting a payment is final, like clearing one: never from a Login-as session
    await assertNotImpersonating();
    await rejectPayment(req.companyId, req.user.id, id.toLowerCase(), parsed.value.reason);
    return apiResponse.success(res, { id: id.toLowerCase(), status: 'rejected' }, 'Rejected');
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
