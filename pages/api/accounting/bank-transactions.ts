/**
 * Bank Transactions API
 * GET /api/accounting/bank-transactions - List transactions (with filters)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankReconciliationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const {
      bank_account_id, reconciliation_id, status,
      from_date, to_date, from_amount, to_amount,
      search, limit, offset,
      sort_order, allocation_filter, tx_type, alloc_type, has_suggestion,
    } = req.query;
    const result = await getBankTransactions(companyId, {
      bankAccountId:    bank_account_id    ? String(bank_account_id)    : undefined,
      reconciliationId: reconciliation_id  ? String(reconciliation_id)  : undefined,
      status:           status             ? String(status)             : undefined,
      fromDate:         from_date          ? String(from_date)          : undefined,
      toDate:           to_date            ? String(to_date)            : undefined,
      fromAmount:       from_amount        ? String(from_amount)        : undefined,
      toAmount:         to_amount          ? String(to_amount)          : undefined,
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

 
export default withCompany(withErrorHandler(withWriteAccess(handler)));
