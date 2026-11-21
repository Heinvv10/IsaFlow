/**
 * Item Movement Report API
 * GET: Stock movement log (in/out/adjustments) per item with running balance
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  try {
    const companyId = (req as CompanyAuthedRequest).companyId;
    const from = (req.query.from as string) || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to = (req.query.to as string) || new Date().toISOString().split('T')[0];
    const itemId = req.query.item_id as string | undefined;
    const format = req.query.format as string;

    // Get GRN (goods received) as stock IN. grn_items.product_id references PRODUCTS (its FK, and what the receipt copies from the PO
    // line's product_id); this used to join stock_items, a separate catalogue no receipt ever names (Codex gate at 1cf5bdc1, 1).
    // A receipt written before the receipt copied the product has product_id NULL (1021 backfills nothing): its product is resolved
    // here through the item's own PO line, that line's PO being the note's and this company's, the product checked to be the
    // company's (Codex gate at 42de08b3, 1). One query for both forms; item_id filters on the resolved product.
    const grnRows = await sql`
      SELECT g.received_date AS move_date, 'GRN' AS move_type,
        g.grn_number AS reference, p.id::text AS product_id, p.name AS item_name, p.code AS item_code,
        gi.quantity_received AS qty_in, 0 AS qty_out
      FROM grn_items gi
      JOIN goods_received_notes g ON g.id = gi.grn_id AND g.company_id = ${companyId}
      LEFT JOIN po_items pi ON pi.id = gi.po_item_id AND pi.purchase_order_id = g.purchase_order_id
      LEFT JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}
      JOIN products p ON p.id = COALESCE(gi.product_id, CASE WHEN po.id IS NOT NULL THEN pi.product_id END)
                     AND p.company_id = ${companyId}
      WHERE g.received_date IS NOT NULL
        AND g.status <> 'cancelled'
        AND g.received_date >= ${from} AND g.received_date <= ${to}
        AND (${itemId ?? null}::uuid IS NULL OR p.id = ${itemId ?? null}::uuid)
      ORDER BY g.received_date, g.grn_number, gi.id
    `;

    // No sales rows — customer_invoice_items don't link to products
    const salesRows: typeof grnRows = [];

    // Merge and sort by date
    const allMoves = [...grnRows, ...salesRows].sort((a, b) =>
      new Date(a.move_date).getTime() - new Date(b.move_date).getTime()
    );

    // The running balance is PER PRODUCT (Codex gate at 42de08b3, 2): one shared total made B read 12 after 10 of A and 2 of B.
    const balances = new Map<string, number>();
    const data = allMoves.map(r => {
      const qtyIn = Number(r.qty_in || 0);
      const qtyOut = Number(r.qty_out || 0);
      const key = String(r.product_id);
      const balance = (balances.get(key) ?? 0) + qtyIn - qtyOut;
      balances.set(key, balance);
      return {
        date: fmtDate(r.move_date),
        type: r.move_type,
        reference: r.reference || '',
        productId: key,
        itemName: r.item_name,
        itemCode: r.item_code || '',
        qtyIn,
        qtyOut,
        balance,
      };
    });

    if (format === 'csv') {
      const header = 'Date,Type,Reference,Item Code,Item,Qty In,Qty Out,Balance';
      const csvRows = data.map(r =>
        `${r.date},${csvCell(r.type)},${csvCell(r.reference)},${csvCell(r.itemCode)},${csvCell(r.itemName)},${r.qtyIn},${r.qtyOut},${r.balance}`
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

export default withAuth(withErrorHandler(withWriteAccess(handler)));
