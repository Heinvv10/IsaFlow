/**
 * Bank Transactions API
 * GET /api/accounting/bank-transactions - List transactions (with filters)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankReconciliationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const {
      bank_account_id, bankAccountId,
      reconciliation_id, reconciliationId,
      status,
      from_date, fromDate, to_date, toDate,
      from_amount, fromAmount, to_amount, toAmount,
      search, limit, offset,
      sort_order, allocation_filter, tx_type, alloc_type, has_suggestion,
    } = req.query;
    const pick = (a?: unknown, b?: unknown) => (a ?? b) as string | undefined;
    const result = await getBankTransactions(companyId, {
      bankAccountId:    pick(bank_account_id, bankAccountId)     ? String(pick(bank_account_id, bankAccountId))     : undefined,
      reconciliationId: pick(reconciliation_id, reconciliationId) ? String(pick(reconciliation_id, reconciliationId)) : undefined,
      status:           status             ? String(status)             : undefined,
      fromDate:         pick(from_date, fromDate)   ? String(pick(from_date, fromDate))   : undefined,
      toDate:           pick(to_date, toDate)       ? String(pick(to_date, toDate))       : undefined,
      fromAmount:       pick(from_amount, fromAmount) ? String(pick(from_amount, fromAmount)) : undefined,
      toAmount:         pick(to_amount, toAmount)   ? String(pick(to_amount, toAmount))   : undefined,
      search:           search             ? String(search)             : undefined,
      limit:            limit              ? Number(limit)              : undefined,
      offset:           offset             ? Number(offset)             : undefined,
      sortOrder:        sort_order === 'asc' ? 'asc' : 'desc',
      allocationFilter: allocation_filter  ? String(allocation_filter) as 'all' | 'allocated' | 'unallocated' : undefined,
      txType:           tx_type            ? String(tx_type)           as 'all' | 'spent' | 'received'       : undefined,
      allocType:        alloc_type         ? String(alloc_type)        as 'all' | 'account' | 'supplier' | 'customer' : undefined,
      hasSuggestion:    has_suggestion     ? String(has_suggestion)    as 'all' | 'yes' | 'no'              : undefined,
    });
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to get bank transactions', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to get bank transactions');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
