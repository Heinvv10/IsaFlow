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

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { confirmReceiptMatch } from '@/modules/accounting/services/ar/receiptMatchService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
    return;
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const body = req.body ?? {};

  const bankTxId = typeof body.bankTxId === 'string' ? body.bankTxId : '';
  const customerInvoiceId =
    typeof body.customerInvoiceId === 'string' ? body.customerInvoiceId : '';
  const amount = Number(body.amount);

  if (!bankTxId) {
    apiResponse.badRequest(res, 'bankTxId is required');
    return;
  }
  if (!customerInvoiceId) {
    apiResponse.badRequest(res, 'customerInvoiceId is required');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    apiResponse.badRequest(res, 'amount must be a positive number');
    return;
  }

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

export default withAuth(withErrorHandler(withWriteAccess(handler)));
