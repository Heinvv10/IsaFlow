/**
 * POST /api/accounting/ar/receipt-match/confirm
 * Body: { bankTxId, customerInvoiceId, amount }
 *
 * Confirms a receipt-match: posts the GL entry, creates a confirmed
 * customer_payment row, allocates it to the target invoice, and bumps
 * the invoice's amount_paid/status.
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
import { confirmReceiptMatch } from '@/modules/accounting/services/ar/receiptMatchService';

const BodySchema = z.object({
  bankTxId: UUID,
  customerInvoiceId: UUID,
  amount: z.union([z.number(), z.string()]).transform(v => Number(v)).refine(n => Number.isFinite(n) && n > 0, {
    message: 'amount must be a positive number',
  }),
}).strict();

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
  const { bankTxId, customerInvoiceId, amount } = parsed.data;

  try {
    const result = await confirmReceiptMatch(companyId, {
      bankTxId,
      customerInvoiceId,
      amount,
      userId: user.id,
    });
    apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      /not found/i.test(message) ||
      /exceeds outstanding/i.test(message) ||
      /must be/i.test(message) ||
      /no customer link/i.test(message) ||
      /already .*cannot allocate/i.test(message)
    ) {
      apiResponse.badRequest(res, message);
      return;
    }
    log.error('Failed to confirm receipt match', { bankTxId, customerInvoiceId, error: err }, 'accounting-api');
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
