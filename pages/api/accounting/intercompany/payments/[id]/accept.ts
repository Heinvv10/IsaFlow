/**
 * POST — accept a payment message (F): { outcome: 'existing', receiptId, expected: { amount, state } } matches it to a receipt this company
 * already has (only the message changes), { outcome: 'draft', bankAccountId, paymentDate, allocations, expected: { amount, state, invoiceIds } }
 * drafts ONE receipt for exactly the amount (nothing posts: Confirm is the normal receipt confirm). 200 { accepted, outcome, receiptId,
 * receiptNumber }. Every refusal is a 4xx before any write (403 flag off / person, 404, 409 handled / state / changed, 422 the receipt or the
 * draft); after the draft is written a failure is a 5xx and the request rolls back. The dark flag off: 403 before the body is read.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { isUuidParam } from '@/lib/validation';
import { loanClearingEnabled } from '@/modules/accounting/services/intercompany/loanClearingGate';
import { acceptPaymentMessage } from '@/modules/accounting/services/intercompany/paymentAcceptService';
import { PAYMENT_REFUSALS, parsePaymentAcceptBody } from '@/modules/accounting/services/intercompany/paymentAcceptRules';
import { respondIfPaymentRefusal } from '@/modules/accounting/services/intercompany/paymentRoute';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a valid UUID');
  if (!(await loanClearingEnabled(req.companyId))) return apiResponse.forbidden(res, PAYMENT_REFUSALS.not_enabled.sentence);
  const parsed = parsePaymentAcceptBody(req.body);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  try {
    const out = await acceptPaymentMessage({ companyId: req.companyId, messageId: id.toLowerCase(), userId: req.user.id, input: parsed.value });
    return apiResponse.success(res, out, out.outcome === 'draft' ? 'Draft receipt created' : 'Matched');
  } catch (err) {
    if (respondIfPaymentRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
