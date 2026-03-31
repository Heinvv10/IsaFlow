/**
 * Sales by Item Report API
 * GET: Sales analysis grouped by item for a date range
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  try {
    const from = (req.query.from as string) || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to = (req.query.to as string) || new Date().toISOString().split('T')[0];
    const format = req.query.format as string;

    const { companyId } = req as CompanyApiRequest;
    const rows = await sql`
      SELECT
        cii.description AS name,
        cii.income_type AS category,
        COUNT(cii.id)::int AS times_sold,
        COALESCE(SUM(cii.quantity), 0)::numeric AS qty_sold,
        COALESCE(SUM(cii.line_total), 0)::numeric AS total_revenue
      FROM customer_invoice_items cii
      JOIN customer_invoices ci ON ci.id = cii.invoice_id
      WHERE ci.company_id = ${companyId}
        AND ci.invoice_date >= ${from}
        AND ci.invoice_date <= ${to}
        AND ci.status != 'cancelled'
      GROUP BY cii.description, cii.income_type
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
        `"${r.itemCode}","${r.name}","${r.category}",${r.timesSold},${r.qtySold},${r.totalRevenue.toFixed(2)},${r.avgPrice.toFixed(2)}`
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

export default withCompany(withErrorHandler(handler as any));
