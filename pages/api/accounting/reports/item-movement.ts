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
    // An empty item_id ("all items") is no filter: ''::uuid would throw (review of c2110f585e, L1).
    const itemId = (req.query.item_id as string | undefined) || null;
    const format = req.query.format as string;

    // Get GRN (goods received) as stock IN. grn_items.product_id references PRODUCTS (its FK, and what the receipt copies from the PO
    // line's product_id); this used to join stock_items, a separate catalogue no receipt ever names (Codex gate at 1cf5bdc1, 1).
    // A receipt written before the receipt copied the product has product_id NULL (1021 backfills nothing): its product is resolved
    // here through the item's own PO line, that line's PO being the note's and this company's (Codex gate at 42de08b3, 1).
    // A PO line may name a catalogue ITEM instead (po_items.item_id, product_id NULL: update_purchase_order and the MCP import write
    // those): such a receipt is keyed by the item, named by its code and description (Codex gate at 4840b1a6, major). Each row's
    // key is (kind, id): the product when the line resolves to one, else the item, so a line naming both counts under its product.
    // Both are checked to be this company's. item_id filters on the key's id (a product id or an item id). The running balance is per
    // key and summed in SQL as NUMERIC (nit 1: JS floats made 0.1 + 0.2 read 0.30000000000000004). No sales rows:
    // customer_invoice_items don't link to products.
    const grnRows = await sql`
      WITH moves AS (
        SELECT g.received_date AS move_date, g.grn_number AS reference, gi.id AS line_id,
          CASE WHEN p.id IS NOT NULL THEN 'product' ELSE 'item' END AS kind,
          COALESCE(p.id, it.id) AS key_id,
          CASE WHEN p.id IS NOT NULL THEN p.name ELSE it.description END AS item_name,
          CASE WHEN p.id IS NOT NULL THEN p.code ELSE it.code END AS item_code,
          gi.quantity_received AS qty_in
        FROM grn_items gi
        JOIN goods_received_notes g ON g.id = gi.grn_id AND g.company_id = ${companyId}
        LEFT JOIN po_items pi ON pi.id = gi.po_item_id AND pi.purchase_order_id = g.purchase_order_id
        LEFT JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}
        LEFT JOIN products p ON p.id = COALESCE(gi.product_id, CASE WHEN po.id IS NOT NULL THEN pi.product_id END)
                            AND p.company_id = ${companyId}
        LEFT JOIN items it ON p.id IS NULL AND po.id IS NOT NULL AND it.id = pi.item_id AND it.company_id = ${companyId}
        WHERE g.received_date IS NOT NULL
          AND g.status <> 'cancelled'
          AND g.received_date >= ${from} AND g.received_date <= ${to}
          AND (p.id IS NOT NULL OR it.id IS NOT NULL)
      )
      SELECT move_date, 'GRN' AS move_type, reference, kind, key_id::text AS key_id, item_name, item_code,
        qty_in::text AS qty_in, '0' AS qty_out,
        (SUM(qty_in) OVER (PARTITION BY kind, key_id ORDER BY move_date, reference, line_id ROWS UNBOUNDED PRECEDING))::text AS balance
      FROM moves
      WHERE ${itemId}::uuid IS NULL OR key_id = ${itemId}::uuid
      ORDER BY move_date, reference, line_id
    `;

    // NUMERIC text to a number only for display: the sums were exact in SQL.
    const data = grnRows.map(r => ({
      date: fmtDate(r.move_date),
      type: r.move_type,
      reference: r.reference || '',
      kind: String(r.kind) as 'product' | 'item',
      productId: r.kind === 'product' ? String(r.key_id) : null,
      itemId: r.kind === 'item' ? String(r.key_id) : null,
      itemName: r.item_name,
      itemCode: r.item_code || '',
      qtyIn: Number(r.qty_in),
      qtyOut: Number(r.qty_out),
      balance: Number(r.balance),
    }));

    if (format === 'csv') {
      // Catalogue: product or item, so a code that exists in both is told apart.
      const header = 'Date,Type,Reference,Catalogue,Item Code,Item,Qty In,Qty Out,Balance';
      const csvRows = data.map(r =>
        `${r.date},${csvCell(r.type)},${csvCell(r.reference)},${r.kind},${csvCell(r.itemCode)},${csvCell(r.itemName)},${r.qtyIn},${r.qtyOut},${r.balance}`
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
