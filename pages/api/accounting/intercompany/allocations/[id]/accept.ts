/**
 * POST { expectedLoanAccountId, invoiceId, amount, postingDate } — clear an allocation message (P4-D): posts ONE contra settlement of this
 * company's customer invoice against its intercompany loan account (DR loan / CR Accounts Receivable), dated `postingDate`, and marks the message
 * accepted with that receipt. 200 `{ accepted: true, paymentId, paymentNumber, journalEntryId }`; a refusal of the books is 200
 * `{ accepted: false, status: 'failed', error }` (stored on the message, nothing posted); a stale preview 409 and a bad date 400 (nothing
 * written); a Login-as session, no write role or no Approve on Customers & AR 403. No 4xx is answered after a write.
 * The dark flag `intercompany_loan_clearing` off for this company: 403 with a plain sentence, before the body is read (the service refuses
 * `not_enabled` as its first step too).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { isUuidParam } from '@/lib/validation';
import { respondIfRefusal } from '@/modules/accounting/services/intercompany/connectionRoute';
import { acceptAllocation } from '@/modules/accounting/services/intercompany/allocationClearService';
import { parseAcceptBody } from '@/modules/accounting/services/intercompany/allocationClearRefusals';
import { LOAN_CLEARING_OFF, loanClearingEnabled } from '@/modules/accounting/services/intercompany/loanClearingGate';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  if (!(await loanClearingEnabled(req.companyId))) return apiResponse.forbidden(res, LOAN_CLEARING_OFF);
  const parsed = parseAcceptBody(req.body);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  try {
    const out = await acceptAllocation({ companyId: req.companyId, messageId: id.toLowerCase(), userId: req.user.id, input: parsed.value });
    return apiResponse.success(res, out, out.accepted ? 'Cleared' : 'Not cleared');
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
