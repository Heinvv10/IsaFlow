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
import { confirmReceiptMatch } from '@/modules/accounting/services/ar/receiptMatchConfirmService';

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

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    return;
  }
  const { bankTxId } = parsed.data;
  const allocations = parsed.data.allocations
    ?? [{ invoiceId: parsed.data.customerInvoiceId!, amount: parsed.data.amount! }];

  try {
    const result = await confirmReceiptMatch(companyId, { bankTxId, userId: user.id, allocations });
    apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Every refusal the service can make happens BEFORE allocateTransaction, so
    // a 400 here cannot commit a half-finished allocation. Anything raised
    // afterwards falls through to the 500 path, where withAuth rolls back.
    if (
      /not found/i.test(message) ||
      /exceeds/i.test(message) ||
      /must be/i.test(message) ||
      /names no customer/i.test(message) ||
      /different customer/i.test(message) ||
      /appears more than once/i.test(message) ||
      /cannot receive a receipt/i.test(message) ||
      /already allocated/i.test(message) ||
      /cannot be allocated/i.test(message) ||
      /money OUT/i.test(message)
    ) {
      apiResponse.badRequest(res, message);
      return;
    }
    log.error('Failed to confirm receipt match', { bankTxId, error: err }, 'accounting-api');
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
