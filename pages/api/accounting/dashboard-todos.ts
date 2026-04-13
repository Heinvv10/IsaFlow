/**
 * Dashboard Action Items API
 * GET /api/accounting/dashboard-todos
 * Returns overdue invoices, pending supplier payments, uncategorized bank txns, and draft invoices.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

interface OverdueInvoice {
  id: string;
  invoiceNumber: string;
  clientName: string;
  amount: number;
  daysOverdue: number;
}

interface PendingSupplierPayment {
  id: string;
  invoiceNumber: string;
  supplierName: string;
  amount: number;
  daysOverdue: number;
}

interface TodoData {
  overdueInvoices: OverdueInvoice[];
  pendingSupplierPayments: PendingSupplierPayment[];
  uncategorizedBankTxns: number;
  draftInvoices: number;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const [overdueRows, supplierRows, bankCountRows, draftCountRows] = await Promise.all([
      sql`
        SELECT
          ci.id::text,
          COALESCE(ci.invoice_number, '') AS "invoiceNumber",
          COALESCE(c.name, '') AS "clientName",
          ci.total_amount::numeric AS amount,
          EXTRACT(DAY FROM NOW() - ci.due_date)::int AS "daysOverdue"
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        WHERE ci.company_id = ${companyId}
          AND ci.status IN ('sent', 'approved', 'partially_paid')
          AND ci.due_date < NOW()
        ORDER BY ci.due_date ASC
        LIMIT 10
      `,
      sql`
        SELECT
          si.id::text,
          COALESCE(si.invoice_number, '') AS "invoiceNumber",
          COALESCE(s.name, '') AS "supplierName",
          si.total_amount::numeric AS amount,
          EXTRACT(DAY FROM NOW() - si.due_date)::int AS "daysOverdue"
        FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.company_id = ${companyId}
          AND si.status IN ('approved', 'partially_paid')
          AND si.due_date < NOW()
        ORDER BY si.due_date ASC
        LIMIT 10
      `,
      sql`
        SELECT COUNT(*)::int AS cnt
        FROM bank_transactions
        WHERE company_id = ${companyId}
          AND allocation_type IS NULL
          AND status = 'imported'
      `,
      sql`
        SELECT COUNT(*)::int AS cnt
        FROM customer_invoices
        WHERE company_id = ${companyId}
          AND status = 'draft'
      `,
    ]);

    const overdueInvoices: OverdueInvoice[] = overdueRows.map((r) => ({
      id: String(r.id),
      invoiceNumber: String(r.invoiceNumber),
      clientName: String(r.clientName),
      amount: Number(r.amount),
      daysOverdue: Number(r.daysOverdue),
    }));

    const pendingSupplierPayments: PendingSupplierPayment[] = supplierRows.map((r) => ({
      id: String(r.id),
      invoiceNumber: String(r.invoiceNumber),
      supplierName: String(r.supplierName),
      amount: Number(r.amount),
      daysOverdue: Number(r.daysOverdue),
    }));

    const uncategorizedBankTxns = Number(bankCountRows[0]?.cnt ?? 0);
    const draftInvoices = Number(draftCountRows[0]?.cnt ?? 0);

    const data: TodoData = {
      overdueInvoices,
      pendingSupplierPayments,
      uncategorizedBankTxns,
      draftInvoices,
    };

    return apiResponse.success(res, data);
  } catch (err) {
    log.error('Failed to load dashboard todos', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to load dashboard todos');
  }
}

export default withCompany(withErrorHandler(handler));
