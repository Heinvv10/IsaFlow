/**
 * Item Quantities Report API
 * GET: Current on-hand quantities per item with min stock alerts
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';

export default withCompany(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  try {
    const format = req.query.format as string;
    const lowStockOnly = req.query.low_stock === 'true';

    const rows = await sql`
      SELECT id, item_code, name, category, uom, qty_available,
        COALESCE(min_stock_level, 0) AS min_stock_level
      FROM stock_items
      WHERE is_active = true
      ORDER BY name
    `;

    let data = rows.map(r => ({
      id: r.id,
      itemCode: r.item_code || '',
      name: r.name,
      category: r.category || 'uncategorized',
      uom: r.uom || '',
      qtyOnHand: Number(r.qty_available || 0),
      minLevel: Number(r.min_stock_level || 0),
      lowStock: Number(r.min_stock_level || 0) > 0 && Number(r.qty_available || 0) <= Number(r.min_stock_level || 0),
    }));

    if (lowStockOnly) {
      data = data.filter(r => r.lowStock);
    }

    if (format === 'csv') {
      const header = 'Item Code,Name,Category,UOM,Qty On Hand,Min Level,Low Stock';
      const csvRows = data.map(r =>
        `"${r.itemCode}","${r.name}","${r.category}","${r.uom}",${r.qtyOnHand},${r.minLevel},${r.lowStock ? 'Yes' : 'No'}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="item-quantities.csv"');
      return res.send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Item quantities report error', { error: message });
    return apiResponse.badRequest(res, 'Failed to generate report');
  }
});
