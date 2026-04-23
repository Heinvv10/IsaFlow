/**
 * GET /api/accounting/ar/receipt-match/[bankTxId]
 * Returns top-5 scored customer-invoice candidates for the receipt.
 * PRD-06 Phase 4. Company-scoped, auth-required.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getReceiptMatchCandidates } from '@/modules/accounting/services/ar/receiptMatchService';
import { fetchBankTransaction } from '@/modules/accounting/services/bank/bankMatchCandidatesService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
    return;
  }

  const { bankTxId } = req.query;
  if (!bankTxId || typeof bankTxId !== 'string') {
    apiResponse.badRequest(res, 'bankTxId path param is required');
    return;
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const tx = await fetchBankTransaction(bankTxId, companyId);
    if (!tx) {
      apiResponse.notFound(res, 'Bank transaction', bankTxId);
      return;
    }
    if (tx.amount <= 0) {
      apiResponse.badRequest(res, 'Bank transaction is not a receipt (amount must be positive)');
      return;
    }

    const { candidates } = await getReceiptMatchCandidates(bankTxId, companyId);
    apiResponse.success(res, { candidates, bankTransaction: tx });
  } catch (err) {
    log.error('Failed to fetch receipt-match candidates', { bankTxId, error: err }, 'accounting-api');
    apiResponse.internalError(res, err);
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
