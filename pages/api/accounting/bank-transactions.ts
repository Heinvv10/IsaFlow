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
import { parseReconFilter } from '@/modules/accounting/services/bank/bankTxTabCond';
import { AMOUNT_BOUND_RE } from '@/modules/accounting/utils/bankAmountBound';
import { escapeLikeLiteral } from '@/lib/sqlLikeLiteral';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  // An amount bound that is not a number is a 400 (it reached ::NUMERIC and answered 500).
  for (const key of ['from_amount', 'fromAmount', 'to_amount', 'toAmount'] as const) {
    const v = req.query[key];
    if (v !== undefined && v !== '' && !(typeof v === 'string' && AMOUNT_BOUND_RE.test(v.trim()))) {
      return apiResponse.badRequest(res, `${key} must be a non-negative number (the filter is on the size of the line)`);
    }
  }

  try {
    const {
      bank_account_id, bankAccountId,
      reconciliation_id, reconciliationId,
      status,
      from_date, fromDate, to_date, toDate,
      from_amount, fromAmount, to_amount, toAmount,
      search, limit, offset,
      sort_order, allocation_filter, tx_type, alloc_type, has_suggestion, recon_filter,
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
      // % and _ in what the person typed are literal characters, not wildcards ("50%" must not match everything).
      search:           search             ? escapeLikeLiteral(String(search))  : undefined,
      limit:            limit              ? Number(limit)              : undefined,
      offset:           offset             ? Number(offset)             : undefined,
      sortOrder:        sort_order === 'asc' ? 'asc' : 'desc',
      allocationFilter: allocation_filter  ? String(allocation_filter) as 'all' | 'allocated' | 'suggested' | 'unallocated' : undefined,
      txType:           tx_type            ? String(tx_type)           as 'all' | 'spent' | 'received'       : undefined,
      allocType:        alloc_type         ? String(alloc_type)        as 'all' | 'account' | 'supplier' | 'customer' : undefined,
      hasSuggestion:    has_suggestion     ? String(has_suggestion)    as 'all' | 'yes' | 'no'              : undefined,
      reconFilter:      parseReconFilter(recon_filter),
    });
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to get bank transactions', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to get bank transactions');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
