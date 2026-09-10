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
import { rewindAmount, effectivePaidExpr } from '@/modules/accounting/services/shared/agingRewind';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  try {
    const from = (typeof req.query.from === 'string' ? req.query.from : null) || fmtDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const to = (typeof req.query.to === 'string' ? req.query.to : null) || fmtDate(new Date());
    const format = typeof req.query.format === 'string' ? req.query.format : undefined;

    const { companyId } = req as CompanyAuthedRequest;
    const paid = effectivePaidExpr('ar');
    const rows = await sql`
      SELECT
        ci.client_id,
        c.name AS client_name,
        COUNT(ci.id)::int AS invoice_count,
        COALESCE(SUM(ci.total_amount), 0)::numeric AS total_sales,
        COALESCE(SUM(${sql.unsafe(paid)}), 0)::numeric AS payments_received,
        COALESCE(SUM(ci.total_amount - ${sql.unsafe(paid)}), 0)::numeric AS outstanding
      FROM customer_invoices ci
      JOIN customers c ON c.id = ci.client_id
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: to, todayStr: fmtDate(new Date()), side: 'ar' })}
      ) unpaid ON TRUE
      WHERE ci.company_id = ${companyId}
        -- Everything here is AS AT "to": the invoices raised in the period,
        -- and what had been received on them and was still outstanding on the
        -- period end — the ageing at "to" restricted to these invoices. It is
        -- NOT the ageing's total, which also carries invoices raised before
        -- "from". Received/outstanding used to be TODAY's amount_paid, so a
        -- past period showed settlement made after it (R-059); the rewind is
        -- the aged report's own (shared/agingRewind). Drafts are excluded for
        -- the same reason the ageing excludes them: nothing was sold or owed.
        -- The soft-delete leg is dated to "to" — shared/softDeleteLedgerPresence.
        AND ${documentInLedgerAsAtFragment('ci', to, companyId)}
        AND ci.invoice_date >= ${from}
        AND ci.invoice_date <= ${to}
        AND ci.status NOT IN ('draft', 'cancelled')
      GROUP BY ci.client_id, c.name
      ORDER BY total_sales DESC
    `;

    const data = rows.map(r => ({
      clientId: r.client_id,
      clientName: r.client_name,
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
