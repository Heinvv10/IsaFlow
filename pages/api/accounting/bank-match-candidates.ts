/**
 * Bank Match Candidates API
 * GET /api/accounting/bank-match-candidates?bankTransactionId=<uuid>
 *
 * Smart matching strategy:
 * 1. Extract entity name from description → filter to that customer/supplier
 * 2. Direction-based: receipts → customer invoices, payments → supplier invoices/POs
 * 3. Invoice reference detection: if description contains "INV-00478" → boost that invoice
 * 4. Exact amount match on outstanding balance → highest score
 * 5. Multi-invoice combo: find 2-3 invoices whose balances sum to the payment amount
 * 6. Journal lines as fallback
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getMatchCandidates, fetchBankTransaction } from '@/modules/accounting/services/bankMatchCandidatesService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { bankTransactionId } = req.query;
  if (!bankTransactionId || typeof bankTransactionId !== 'string') {
    return apiResponse.badRequest(res, 'bankTransactionId query param is required');
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    // Verify transaction exists and belongs to this company
    const tx = await fetchBankTransaction(bankTransactionId, companyId);
    if (!tx) {
      return apiResponse.notFound(res, 'Bank transaction', bankTransactionId);
    }

    const { candidates } = await getMatchCandidates(bankTransactionId, companyId);

    return apiResponse.success(res, { candidates });
  } catch (err) {
    log.error('Failed to fetch bank match candidates', { bankTransactionId, error: err }, 'accounting-api');
    return apiResponse.internalError(res, err);
  }
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
