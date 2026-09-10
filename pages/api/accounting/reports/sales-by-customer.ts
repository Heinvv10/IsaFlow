/**
 * Sales by Customer Report API
 * GET: Returns sales summary grouped by customer for a date range
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  try {
    const from = (typeof req.query.from === 'string' ? req.query.from : null) || fmtDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const to = (typeof req.query.to === 'string' ? req.query.to : null) || fmtDate(new Date());
    const format = typeof req.query.format === 'string' ? req.query.format : undefined;

    const { companyId } = req as CompanyAuthedRequest;
    const rows = await sql`
      SELECT
        COALESCE(ci.client_id, ci.customer_id) AS client_id,
        c.name AS client_name,
        COUNT(ci.id)::int AS invoice_count,
        COALESCE(SUM(ci.total_amount), 0)::numeric AS total_sales,
        COALESCE(SUM(COALESCE(ci.amount_paid, 0)), 0)::numeric AS payments_received,
        COALESCE(SUM(ci.total_amount - COALESCE(ci.amount_paid, 0)), 0)::numeric AS outstanding
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
                           AND c.company_id = ci.company_id
      WHERE ci.company_id = ${companyId}
        -- Dated to the period end this report is drawn to, so the outstanding
        -- column agrees with the ageing and the control account at that date.
        -- See shared/softDeleteLedgerPresence.
        AND ${documentInLedgerAsAtFragment('ci', to, companyId)}
        AND ci.invoice_date >= ${from}
        AND ci.invoice_date <= ${to}
        -- COALESCE, because status is nullable and NULL != 'cancelled' is
        -- NULL: the bare inequality silently dropped every null-status invoice,
        -- the same under-reporting this report was fixed for.
        AND COALESCE(ci.status, '') <> 'cancelled'
      GROUP BY COALESCE(ci.client_id, ci.customer_id), c.name
      ORDER BY total_sales DESC
    `;

    // An unresolvable id gets its own row (the grouping key is the id), so the
    // placeholder must name it — otherwise the CSV shows several identical
    // 'Unknown customer' lines that neither aggregate nor can be attributed.
    // An invoice carrying NEITHER id would have no id to name, and printing
    // `Unknown customer (null)` into a customer-facing CSV states an id that
    // does not exist. `customer_invoices.customer_id` is NOT NULL today, so
    // the COALESCE key cannot be null and this branch is unreachable — it is
    // here because the label, not the constraint, is what makes it safe.
    const data = rows.map(r => ({
      clientId: r.client_id,
      clientName: r.client_name
        ?? (r.client_id == null
          ? 'Unattributed'
          : `Unknown customer (${String(r.client_id)})`),
      invoiceCount: Number(r.invoice_count),
      totalSales: Number(r.total_sales),
      paymentsReceived: Number(r.payments_received),
      outstanding: Number(r.outstanding),
    }));

    if (format === 'csv') {
      const header = 'Customer,Invoices,Total Sales,Received,Outstanding';
      const csvRows = data.map(r =>
        `${csvCell(r.clientName)},${r.invoiceCount},${r.totalSales.toFixed(2)},${r.paymentsReceived.toFixed(2)},${r.outstanding.toFixed(2)}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sales-by-customer-${from}-${to}.csv"`);
      return res.send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('sales-by-customer report error', { error: message });
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, 'Failed to generate report');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
