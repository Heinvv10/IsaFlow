/**
 * Customer Transaction Ledger API
 * GET /api/accounting/reports-customer-ledger?customerId=&dateFrom=&dateTo=
 *
 * Returns all invoices + receipts for a single customer with a running balance.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql, fmtDate } from '@/lib/neon';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';

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

type DbRow = {
  type: string;
  transaction_id: string;
  reference: string | null;
  transaction_date: Date | string;
  debit: string | number;
  credit: string | number;
  status: string;
};

function toDateStr(d: Date | string): string {
  // P1.4 sweep: toISOString() on a pg DATE (local midnight, UTC+2) rolls the
  // date back a day — fmtDate uses local getters.
  return fmtDate(d) || String(d);
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

  const dateFromVal = typeof dateFrom === 'string' && dateFrom ? dateFrom : null;
  const dateToVal = typeof dateTo === 'string' && dateTo ? dateTo : null;

  try {
    // Resolve customer name
    const customerRows = (await sql`
      SELECT name
      FROM customers
      WHERE id = ${customerId}
        AND company_id = ${companyId}
        AND deleted_at IS NULL
      LIMIT 1
    `) as { name: string }[];

    if (!customerRows.length) {
      return apiResponse.notFound(res, 'Customer', customerId);
    }

    const customerName = (customerRows[0] as { name: string }).name;

    // Union of invoices + receipts
    const rows = (await sql`
      SELECT
        'invoice'                                   AS type,
        ci.id                                       AS transaction_id,
        ci.invoice_number                           AS reference,
        ci.invoice_date                             AS transaction_date,
        ci.total_amount                             AS debit,
        0                                           AS credit,
        ci.status
      FROM customer_invoices ci
      WHERE ci.company_id = ${companyId}
        AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}
        AND (${dateFromVal}::date IS NULL OR ci.invoice_date >= ${dateFromVal}::date)
        AND (${dateToVal}::date IS NULL OR ci.invoice_date <= ${dateToVal}::date)
        AND (ci.deleted_at IS NULL OR ci.deleted_at > NOW())

      UNION ALL

      SELECT
        'receipt'                                   AS type,
        cp.id                                       AS transaction_id,
        COALESCE(cp.bank_reference, cp.payment_number) AS reference,
        cp.payment_date                             AS transaction_date,
        0                                           AS debit,
        cp.total_amount                             AS credit,
        'paid'                                      AS status
      FROM customer_payments cp
      WHERE cp.company_id = ${companyId}
        AND cp.client_id = ${customerId}
        AND cp.status != 'cancelled'
        AND (${dateFromVal}::date IS NULL OR cp.payment_date >= ${dateFromVal}::date)
        AND (${dateToVal}::date IS NULL OR cp.payment_date <= ${dateToVal}::date)

      ORDER BY transaction_date ASC, type ASC
    `) as DbRow[];

    // Compute running balance
    let balance = 0;
    const transactions: LedgerRow[] = rows.map((row) => {
      const debit = Number(row.debit) || 0;
      const credit = Number(row.credit) || 0;
      balance = balance + debit - credit;
      return {
        type: row.type,
        transaction_id: row.transaction_id,
        reference: row.reference,
        transaction_date: toDateStr(row.transaction_date),
        debit,
        credit,
        status: row.status,
        running_balance: balance,
      };
    });

    const openingBalance = 0;
    const closingBalance = balance;

    const result: LedgerResult = {
      customer_name: customerName,
      opening_balance: openingBalance,
      closing_balance: closingBalance,
      transactions,
    };

    return apiResponse.success(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Customer ledger report failed', { error: message, customerId }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to generate customer ledger');
  }
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
