/**
 * Dashboard Action Items API
 * GET /api/accounting/dashboard-todos
 * Returns overdue invoices, pending supplier payments, uncategorized bank txns, and draft invoices.
 *
 * Overdue customer invoices (rows AND count) come from arOutstandingService, the
 * one definition of overdue shared with the dashboard figure and the invoice
 * list tiles. The draft invoice and overdue bill COUNTS are the headline counts
 * (reports/headlineFigures), shared with the workbench cards and Month-End.
 * The rest of this queue (the supplier bill rows) keeps the
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
import { todayInSast } from '@/lib/saDateParser';
import { AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { getHeadlineCounts } from '@/modules/accounting/services/reports/headlineFigures';
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
  /** The first 10 overdue bills; overdueBillCount is the true company-wide count. */
  pendingSupplierPayments: PendingSupplierPayment[];
  /** Open bills with a balance, due before today (SAST): the headline count. */
  overdueBillCount: number;
  uncategorizedBankTxns: number;
  draftInvoices: number;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const today = todayInSast();

  try {
    const [overdueRows, supplierRows, bankCountRows, counts, arSummary] = await Promise.all([
      listOverdueInvoices(companyId, 10),
      sql`
        SELECT
          si.id::text,
          COALESCE(si.invoice_number, '') AS "invoiceNumber",
          COALESCE(s.name, '') AS "supplierName",
          si.total_amount::numeric AS amount,
          EXTRACT(DAY FROM NOW() - si.due_date)::int AS "daysOverdue"
        FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
        WHERE si.company_id = ${companyId}
          AND si.deleted_at IS NULL
          AND si.status = ANY(${Array.from(AP_OPEN_STATUSES)}::text[])
          AND si.total_amount - COALESCE(si.amount_paid, 0) > 0
          -- The headline overdue-bill population (reports/headlineFigures), so
          -- these rows are the first 10 of overdueBillCount.
          AND si.due_date < ${today}::DATE
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
      getHeadlineCounts(companyId, today),
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
    const draftInvoices = counts.draftInvoices;

    const data: TodoData = {
      overdueInvoices: overdueRows,
      overdueInvoiceCount: arSummary.overdueCount,
      pendingSupplierPayments,
      overdueBillCount: counts.billsOverdue,
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
