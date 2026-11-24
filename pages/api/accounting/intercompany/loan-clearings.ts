/**
 * "Clear against the intercompany loan" (intercompany P4-E): the PAYER clears its supplier bill, linked to the partner's customer invoice on a
 * group LOAN connection, with ONE contra settlement against its intercompany loan account (DR Accounts Payable / CR the loan account). The
 * P4-B hook sends the allocation message; the partner then clears its invoice (P4-D).
 *   GET  ?billId=<uuid>  the preview (both legs, the open amount, the partner, whether it can post now and why not). Read only.
 *   POST { billId, amount, postingDate, expected: { loanAccountId, linkId, amount, openAmount } }  200 `{ cleared: true, paymentId,
 *        paymentNumber, journalEntryId, messageId }`; a refusal is a 4xx with a plain sentence (404 bill, 403 the person, 400 the date or the
 *        body, 409 the books or a stale preview), always before any write; anything after the posting is a 5xx (the request rolls back).
 * The dark flag `intercompany_loan_clearing` off for this company: 403 with a plain sentence, before the query or the body is read (the
 * service refuses `not_enabled` as its first step too).
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
import { LOAN_CLEARING_OFF, loanClearingEnabled } from '@/modules/accounting/services/intercompany/loanClearingGate';
import { clearBillAgainstLoan } from '@/modules/accounting/services/intercompany/payerLoanClearService';
import { previewLoanClearing } from '@/modules/accounting/services/intercompany/payerLoanClearPreview';
import { parseLoanClearBody } from '@/modules/accounting/services/intercompany/payerLoanClearRefusals';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
  if (!(await loanClearingEnabled(req.companyId))) return apiResponse.forbidden(res, LOAN_CLEARING_OFF);
  try {
    if (req.method === 'GET') {
      const billId = req.query.billId;
      if (!isUuidParam(billId)) return apiResponse.badRequest(res, 'billId must be a valid UUID');
      return apiResponse.success(res, await previewLoanClearing(req.companyId, billId.toLowerCase()));
    }
    const parsed = parseLoanClearBody(req.body);
    if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
    const out = await clearBillAgainstLoan({ companyId: req.companyId, ...parsed.value, actor: { userId: req.user.id } });
    return apiResponse.success(res, out, 'Cleared against the intercompany loan');
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (respondIfRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
