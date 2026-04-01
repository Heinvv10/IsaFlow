/**
 * Item Valuation Report API
 * GET: Current stock value (qty x cost) by item, totals by category
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
    const companyId = (req as CompanyApiRequest).companyId;
    const format = req.query.format as string;
    const category = req.query.category as string | undefined;

    let rows;
    if (category) {
      rows = await sql`
        SELECT id, item_code, name, category, uom, qty_available, standard_cost,
          (COALESCE(qty_available, 0) * COALESCE(standard_cost, 0)) AS stock_value
        FROM stock_items
        WHERE company_id = ${companyId} AND is_active = true AND category = ${category}
        ORDER BY stock_value DESC
      `;
    } else {
      rows = await sql`
        SELECT id, item_code, name, category, uom, qty_available, standard_cost,
          (COALESCE(qty_available, 0) * COALESCE(standard_cost, 0)) AS stock_value
        FROM stock_items
        WHERE company_id = ${companyId} AND is_active = true
        ORDER BY stock_value DESC
      `;
    }

    const data = rows.map(r => ({
      id: r.id,
      itemCode: r.item_code || '',
      name: r.name,
      category: r.category || 'uncategorized',
      uom: r.uom || '',
      qtyOnHand: Number(r.qty_available || 0),
      costPrice: Number(r.standard_cost || 0),
      stockValue: Number(r.stock_value || 0),
    }));

    if (format === 'csv') {
      const header = 'Item Code,Name,Category,UOM,Qty On Hand,Unit Cost,Stock Value';
      const csvRows = data.map(r =>
        `"${r.itemCode}","${r.name}","${r.category}","${r.uom}",${r.qtyOnHand},${r.costPrice.toFixed(2)},${r.stockValue.toFixed(2)}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="item-valuation.csv"');
      return res.send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Item valuation report error', { error: message });
    return apiResponse.badRequest(res, 'Failed to generate report');
  }
}

export default withCompany(withErrorHandler(handler));
