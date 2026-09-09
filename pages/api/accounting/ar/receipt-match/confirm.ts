/**
 * POST /api/accounting/ar/receipt-match/confirm
 * Body: { bankTxId, customerInvoiceId, amount }            — one invoice
 *    or { bankTxId, allocations: [{ invoiceId, amount }] }  — several
 *
 * Confirms a receipt-match: posts the GL entry for the whole bank line, creates
 * a confirmed customer_payment row, allocates it to the target invoices, and
 * bumps each invoice's amount_paid/status.
 *
 * The single-invoice body is what the receipt-match screen sends and is kept
 * working unchanged; the `allocations` form was added when the service was
 * widened, because one receipt routinely settles several invoices and the
 * remainder used to be left sitting on the AR control account.
 *
 * WHY THE TWO CALLS ARE NOT IN ONE try/catch.
 *
 * `withAuth` decides COMMIT vs ROLLBACK on `res.statusCode >= 500`, so a 4xx
 * COMMITS. This route used to wrap the whole of `confirmReceiptMatch` and pick
 * 400-vs-500 by regex-matching the message — safe only while every refusal
 * preceded `allocateTransaction`. Widening the service broke that silently:
 * `confirmReceiptMatch` now calls `planReceiptApplication` a SECOND time after
 * the journal has posted, as a race guard, and it throws the very message
 * shapes the regex matched ("not found", "already allocated", "exceeds",
 * "different customer"). A genuine race therefore posted the journal, flipped
 * the bank transaction to `allocated`, COMMITTED both, and told the caller
 * nothing had happened.
 *
 * So the halves are separated structurally rather than by pattern-matching
 * prose. `validateBankReceiptApplication` answers every refusal from READS
 * alone and is the only thing caught; from `confirmReceiptMatch` onward nothing
 * is caught, and a failure reaches withAuth as a 5xx that rolls the whole
 * request back. This is the same discipline `apply_receipt_to_invoice` already
 * follows over MCP, and the same rule
 * `tests/unit/api/chartOfAccountsPutPartialCommit.test.ts` pins for the
 * chart-of-accounts PUT.
 *
 * PRD-06 Phase 4. Company-scoped, auth-required.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import {
  confirmReceiptMatch,
  validateBankReceiptApplication,
} from '@/modules/accounting/services/ar/receiptMatchConfirmService';
import { isCallerSafeError } from '@/lib/lockTimeout';

const Amount = z.union([z.number(), z.string()])
  .transform(v => Number(v))
  .refine(n => Number.isFinite(n) && n > 0, { message: 'amount must be a positive number' });

const BodySchema = z.object({
  bankTxId: UUID,
  customerInvoiceId: UUID.optional(),
  amount: Amount.optional(),
  allocations: z.array(z.object({ invoiceId: UUID, amount: Amount })).min(1).optional(),
}).strict().refine(
  b => (b.allocations !== undefined) !== (b.customerInvoiceId !== undefined && b.amount !== undefined),
  { message: 'Send either allocations, or customerInvoiceId with amount — not both.' },
);

/**
 * True for an application-level refusal — a hand-thrown Error with no SQLSTATE
 * `code`. Driver errors always carry one and could leak schema names, so they
 * propagate to the 500 path instead of being handed to the caller.
 *
 * A typed row-lock timeout counts as a refusal too, even though it carries a
 * `code`: it is hand-thrown, it says "retry in a moment", and it is raised in
 * the PRE-write block where nothing has been written. Without this it was a
 * 500, so routine 5s contention on an invoice row was logged as a server fault
 * and the caller was never told to retry.
 */
const isRefusal = isCallerSafeError;

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request body');
    return;
  }
  const { bankTxId } = parsed.data;
  const allocations = parsed.data.allocations
    ?? [{ invoiceId: parsed.data.customerInvoiceId!, amount: parsed.data.amount! }];

  // PRE-WRITE. Reads only — every refusal this can raise is answerable before
  // anything has been written, which is what makes a 400 safe here.
  try {
    await validateBankReceiptApplication(companyId, bankTxId, allocations);
  } catch (err) {
    if (isRefusal(err)) {
      apiResponse.badRequest(res, err.message);
      return;
    }
    log.error('Receipt-match validation failed', { bankTxId, error: err }, 'accounting-api');
    throw err;
  }

  // POST-WRITE FROM HERE. Nothing is caught: allocateTransaction posts the
  // journal as its first act, and any failure after that must reach withAuth as
  // a 5xx so the transaction rolls back. Catching it would COMMIT the journal
  // behind a response saying the request failed.
  const result = await confirmReceiptMatch(companyId, { bankTxId, userId: user.id, allocations });
  apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
