/**
 * Dashboard Action Items API
 * GET /api/accounting/dashboard-todos
 * Returns overdue invoices, pending supplier payments, uncategorized bank txns, and draft invoices.
 *
 * Overdue customer invoices (rows AND count) come from arOutstandingService, the
 * one definition of overdue shared with the dashboard figure and the invoice
 * list tiles. The rest of this queue (supplier bills, drafts) keeps the
 * UNDATED `deleted_at IS NULL` predicate of K-053: a workflow queue asked as
 * at NOW, as on the chase siblings `dunningService`, `dunningCronService` and
 * `smart-reminder`.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getAROutstandingSummary, listOverdueInvoices, type OverdueInvoiceRow } from '@/modules/accounting/services/ar/arOutstandingService';

interface PendingSupplierPayment {
  id: string;
  invoiceNumber: string;
  supplierName: string;
  amount: number;
  daysOverdue: number;
}

interface TodoData {
  overdueInvoices: OverdueInvoiceRow[];
  /** True company-wide count (shared AR service); overdueInvoices is only the top 10 rows. */
  overdueInvoiceCount: number;
  pendingSupplierPayments: PendingSupplierPayment[];
  uncategorizedBankTxns: number;
  draftInvoices: number;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const [overdueRows, supplierRows, bankCountRows, draftCountRows, arSummary] = await Promise.all([
      listOverdueInvoices(companyId, 10),
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
          AND si.deleted_at IS NULL
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
          AND feed_state = 'posted'
      `,
      sql`
        SELECT COUNT(*)::int AS cnt
        FROM customer_invoices
        WHERE company_id = ${companyId}
          AND deleted_at IS NULL
          AND status = 'draft'
      `,
      getAROutstandingSummary(companyId),
    ]);

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
      overdueInvoices: overdueRows,
      overdueInvoiceCount: arSummary.overdueCount,
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

export default withAuth(withErrorHandler(handler));
