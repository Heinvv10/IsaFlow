/**
 * GET — the PAYER's "paid, no payment message" list (intercompany F, (k) M-4): this company's cash applied to linked partner bills on an active
 * cash connection past its cut-over that carry no message of either kind, oldest first, 500 at most. { state: 'ok' | 'cannot_determine',
 * sentence, items }. Needs the dark flag and an intercompany write role (403 otherwise). Read only.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { loanClearingEnabled } from '@/modules/accounting/services/intercompany/loanClearingGate';
import { userCanWrite } from '@/modules/accounting/services/intercompany/allocationClearReads';
import { PAYMENT_REFUSALS } from '@/modules/accounting/services/intercompany/paymentAcceptRules';
import { listUnsentPayments } from '@/modules/accounting/services/intercompany/paymentUnsent';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  if (!(await loanClearingEnabled(req.companyId))) return apiResponse.forbidden(res, PAYMENT_REFUSALS.not_enabled.sentence);
  if (!(await userCanWrite(req.companyId))) return apiResponse.forbidden(res, PAYMENT_REFUSALS.no_write_role.sentence);
  return apiResponse.success(res, await listUnsentPayments(req.companyId));
}

export default withAuth(withErrorHandler(handler));
