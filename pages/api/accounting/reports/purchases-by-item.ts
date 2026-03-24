/**
 * Purchases by Item Report API
 * GET: Purchase analysis grouped by item for a date range
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { neon } from '@neondatabase/serverless';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';

const sql = neon(process.env.DATABASE_URL!);

export default withAuth(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  try {
    const from = (req.query.from as string) || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to = (req.query.to as string) || new Date().toISOString().split('T')[0];
    const format = req.query.format as string;

    const rows = await sql`
      SELECT
        si.id, si.item_code, si.name, si.category,
        COUNT(DISTINCT poi.purchase_order_id)::int AS po_count,
        COALESCE(SUM(poi.quantity_ordered), 0)::numeric AS qty_ordered,
        COALESCE(SUM(poi.quantity_ordered * poi.unit_price), 0)::numeric AS total_cost
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      JOIN stock_items si ON si.id = poi.stock_item_id
      WHERE po.order_date >= ${from}
        AND po.order_date <= ${to}
      GROUP BY si.id, si.item_code, si.name, si.category
      ORDER BY total_cost DESC
    `;

    const data = rows.map(r => ({
      id: r.id,
      itemCode: r.item_code || '',
      name: r.name,
      category: r.category || '',
      poCount: Number(r.po_count),
      qtyOrdered: Number(r.qty_ordered),
      totalCost: Number(r.total_cost),
      avgCost: Number(r.qty_ordered) > 0 ? Number(r.total_cost) / Number(r.qty_ordered) : 0,
    }));

    if (format === 'csv') {
      const header = 'Item Code,Name,Category,PO Count,Qty Ordered,Total Cost,Avg Cost';
      const csvRows = data.map(r =>
        `"${r.itemCode}","${r.name}","${r.category}",${r.poCount},${r.qtyOrdered},${r.totalCost.toFixed(2)},${r.avgCost.toFixed(2)}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="purchases-by-item-${from}-${to}.csv"`);
      return res.send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Purchases by item report error', { error: message });
    return apiResponse.badRequest(res, 'Failed to generate report');
  }
});
