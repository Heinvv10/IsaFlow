/**
 * Sales by Item Report API
 * GET: Sales analysis grouped by item for a date range
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  try {
    const from = (req.query.from as string) || fmtDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const to = (req.query.to as string) || fmtDate(new Date());
    const format = req.query.format as string;

    const { companyId } = req as CompanyAuthedRequest;
    const rows = await sql`
      SELECT
        cii.description AS name,
        COALESCE(ga.account_name, '') AS category,
        COUNT(cii.id)::int AS times_sold,
        COALESCE(SUM(cii.quantity), 0)::numeric AS qty_sold,
        COALESCE(SUM(cii.amount), 0)::numeric AS total_revenue
      FROM customer_invoice_items cii
      JOIN customer_invoices ci ON ci.id = cii.invoice_id
      LEFT JOIN gl_accounts ga ON ga.id = cii.gl_account_id
      WHERE ci.company_id = ${companyId}
        -- Dated to the period end, exactly as sales-by-customer over the same
        -- range: without it the two reports disagree by a deleted document's
        -- net for every range that spans its reversal.
        -- See shared/softDeleteLedgerPresence.
        AND ${documentInLedgerAsAtFragment('ci', to, companyId)}
        AND ci.invoice_date >= ${from}
        AND ci.invoice_date <= ${to}
        -- Drafts are excluded for the same reason sales-by-customer and the
        -- ageing exclude them: a draft invoice is not a sale. It is not issued
        -- to anyone, it posts nothing to the GL, and its lines are still being
        -- edited — counting them made this report disagree with
        -- sales-by-customer over the same range by every draft, while the
        -- comment above claimed the two were dated alike (R-059 round 3).
        -- COALESCE: status is NULLABLE and NULL NOT IN (...) is NULL, not TRUE,
        -- so the bare comparison silently DROPPED every null-status invoice —
        -- the under-reporting K-091 fixed on sales-by-customer.
        AND COALESCE(ci.status, '') NOT IN ('draft', 'cancelled')
      GROUP BY cii.description, ga.account_name
      ORDER BY total_revenue DESC
    `;

    const data = rows.map(r => ({
      id: '',
      itemCode: '',
      name: r.name || 'Unnamed',
      category: r.category || '',
      timesSold: Number(r.times_sold),
      qtySold: Number(r.qty_sold),
      totalRevenue: Number(r.total_revenue),
      avgPrice: Number(r.qty_sold) > 0 ? Number(r.total_revenue) / Number(r.qty_sold) : 0,
    }));

    if (format === 'csv') {
      const header = 'Item Code,Name,Category,Times Sold,Qty Sold,Total Revenue,Avg Price';
      const csvRows = data.map(r =>
        `${csvCell(r.itemCode)},${csvCell(r.name)},${csvCell(r.category)},${r.timesSold},${r.qtySold},${r.totalRevenue.toFixed(2)},${r.avgPrice.toFixed(2)}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sales-by-item-${from}-${to}.csv"`);
      return res.send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Sales by item report error', { error: message });
    return apiResponse.badRequest(res, 'Failed to generate report');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
