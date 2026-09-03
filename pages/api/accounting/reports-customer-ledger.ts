/**
 * Customer Transaction Ledger API
 * GET /api/accounting/reports-customer-ledger?customerId=&dateFrom=&dateTo=
 *
 * Returns a customer's invoices, receipts and credit notes with a running
 * balance. The composition and arithmetic live in customerLedgerService, where
 * they can be tested; this route is transport only.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getCustomerLedger,
  type CustomerLedgerEntry,
} from '@/modules/accounting/services/ar/customerLedgerService';

interface LedgerRow {
  type: string;
  transaction_id: string;
  reference: string | null;
  transaction_date: string;
  debit: number;
  credit: number;
  status: string;
  running_balance: number;
}

interface LedgerResult {
  customer_name: string;
  opening_balance: number;
  closing_balance: number;
  transactions: LedgerRow[];
}

/** The response stays snake_case — existing UI consumers read these names. */
function toResponseRow(entry: CustomerLedgerEntry): LedgerRow {
  return {
    type: entry.type,
    transaction_id: entry.transactionId,
    reference: entry.reference,
    transaction_date: entry.transactionDate,
    debit: entry.debit,
    credit: entry.credit,
    status: entry.status,
    running_balance: entry.balance,
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { customerId, dateFrom, dateTo } = req.query;

  if (!customerId || typeof customerId !== 'string') {
    return apiResponse.badRequest(res, 'customerId is required');
  }

  try {
    const ledger = await getCustomerLedger(companyId, customerId, {
      dateFrom: typeof dateFrom === 'string' && dateFrom ? dateFrom : null,
      dateTo: typeof dateTo === 'string' && dateTo ? dateTo : null,
    });

    if (ledger === null) {
      return apiResponse.notFound(res, 'Customer', customerId);
    }

    const result: LedgerResult = {
      customer_name: ledger.customerName,
      opening_balance: ledger.openingBalance,
      closing_balance: ledger.closingBalance,
      transactions: ledger.transactions.map(toResponseRow),
    };

    return apiResponse.success(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Customer ledger report failed', { error: message, customerId }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to generate customer ledger');
  }
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
