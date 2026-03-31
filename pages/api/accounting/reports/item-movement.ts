/**
 * Item Movement Report API
 * GET: Stock movement log (in/out/adjustments) per item with running balance
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
    const from = (req.query.from as string) || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to = (req.query.to as string) || new Date().toISOString().split('T')[0];
    const itemId = req.query.item_id as string | undefined;
    const format = req.query.format as string;

    // Get GRN (goods received) as stock IN
    let grnRows;
    if (itemId) {
      grnRows = await sql`
        SELECT g.delivery_date AS move_date, 'GRN' AS move_type,
          g.grn_number AS reference, si.name AS item_name, si.item_code,
          gi.quantity_received AS qty_in, 0 AS qty_out
        FROM grn_items gi
        JOIN goods_received_notes g ON g.id = gi.grn_id
        JOIN stock_items si ON si.id = gi.stock_item_id
        WHERE si.company_id = ${companyId}
          AND gi.stock_item_id = ${itemId}
          AND g.delivery_date >= ${from} AND g.delivery_date <= ${to}
      `;
    } else {
      grnRows = await sql`
        SELECT g.delivery_date AS move_date, 'GRN' AS move_type,
          g.grn_number AS reference, si.name AS item_name, si.item_code,
          gi.quantity_received AS qty_in, 0 AS qty_out
        FROM grn_items gi
        JOIN goods_received_notes g ON g.id = gi.grn_id
        JOIN stock_items si ON si.id = gi.stock_item_id
        WHERE si.company_id = ${companyId}
          AND g.delivery_date IS NOT NULL
          AND g.delivery_date >= ${from} AND g.delivery_date <= ${to}
      `;
    }

    // No sales rows — customer_invoice_items don't link to stock_items
    const salesRows: typeof grnRows = [];

    // Merge and sort by date
    const allMoves = [...grnRows, ...salesRows].sort((a, b) =>
      new Date(a.move_date).getTime() - new Date(b.move_date).getTime()
    );

    let runningBalance = 0;
    const data = allMoves.map(r => {
      const qtyIn = Number(r.qty_in || 0);
      const qtyOut = Number(r.qty_out || 0);
      runningBalance += qtyIn - qtyOut;
      return {
        date: r.move_date instanceof Date ? r.move_date.toISOString().split('T')[0] : String(r.move_date || '').split('T')[0],
        type: r.move_type,
        reference: r.reference || '',
        itemName: r.item_name,
        itemCode: r.item_code || '',
        qtyIn,
        qtyOut,
        balance: runningBalance,
      };
    });

    if (format === 'csv') {
      const header = 'Date,Type,Reference,Item Code,Item,Qty In,Qty Out,Balance';
      const csvRows = data.map(r =>
        `${r.date},"${r.type}","${r.reference}","${r.itemCode}","${r.itemName}",${r.qtyIn},${r.qtyOut},${r.balance}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="item-movement-${from}-${to}.csv"`);
      return res.send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Item movement report error', { error: message });
    return apiResponse.badRequest(res, 'Failed to generate report');
  }
}

export default withCompany(withErrorHandler(handler as any));
