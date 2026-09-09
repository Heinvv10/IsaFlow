/**
 * Supplier Transaction Ledger API
 * GET /api/accounting/reports-supplier-ledger?supplierId=&dateFrom=&dateTo=
 *
 * Returns all invoices + payments for a single supplier with a running balance.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
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
  supplier_name: string;
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
  const raw = d instanceof Date ? d.toISOString() : String(d);
  return raw.split('T')[0] ?? raw;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { supplierId, dateFrom, dateTo } = req.query;

  if (!supplierId || typeof supplierId !== 'string') {
    return apiResponse.badRequest(res, 'supplierId is required');
  }

  const dateFromVal = typeof dateFrom === 'string' && dateFrom ? dateFrom : null;
  const dateToVal = typeof dateTo === 'string' && dateTo ? dateTo : null;

  try {
    // Resolve supplier name
    const supplierRows = (await sql`
      SELECT name
      FROM suppliers
      WHERE id = ${supplierId}
        AND company_id = ${companyId}
        AND deleted_at IS NULL
      LIMIT 1
    `) as { name: string }[];

    if (!supplierRows.length) {
      return apiResponse.notFound(res, 'Supplier', supplierId);
    }

    const supplierName = (supplierRows[0] as { name: string }).name;

    // Union of invoices + payments
    const rows = (await sql`
      SELECT
        'invoice'                                         AS type,
        si.id                                             AS transaction_id,
        si.invoice_number                                 AS reference,
        si.invoice_date                                   AS transaction_date,
        si.total_amount                                   AS debit,
        0                                                 AS credit,
        si.status
      FROM supplier_invoices si
      WHERE si.company_id = ${companyId}
        AND si.supplier_id = ${supplierId}
        -- The supplier NAME lookup above already filters deleted_at; the
        -- invoice leg did not, so a soft-deleted bill stayed in the ledger
        -- and in its running balance.
        AND si.deleted_at IS NULL
        -- And the same status set AP aging uses: a draft bill has not been
        -- issued and a cancelled one has had its journal reversed, so neither
        -- belongs in a statement or its running balance.
        AND si.status NOT IN ('draft', 'cancelled')
        AND (${dateFromVal}::date IS NULL OR si.invoice_date >= ${dateFromVal}::date)
        AND (${dateToVal}::date IS NULL OR si.invoice_date <= ${dateToVal}::date)

      UNION ALL

      SELECT
        'payment'                                         AS type,
        sp.id                                             AS transaction_id,
        COALESCE(sp.reference, sp.payment_number)         AS reference,
        sp.payment_date                                   AS transaction_date,
        0                                                 AS debit,
        sp.total_amount                                   AS credit,
        'paid'                                            AS status
      FROM supplier_payments sp
      WHERE sp.company_id = ${companyId}
        AND sp.supplier_id = ${supplierId}
        AND sp.status != 'cancelled'
        AND (${dateFromVal}::date IS NULL OR sp.payment_date >= ${dateFromVal}::date)
        AND (${dateToVal}::date IS NULL OR sp.payment_date <= ${dateToVal}::date)

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
      supplier_name: supplierName,
      opening_balance: openingBalance,
      closing_balance: closingBalance,
      transactions,
    };

    return apiResponse.success(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Supplier ledger report failed', { error: message, supplierId }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to generate supplier ledger');
  }
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
