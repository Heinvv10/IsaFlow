/**
 * cancel_goods_received (design docs/design/mcp-goods-received.md): a goods received note becomes `cancelled` (with who, when and
 * why), each of its items' quantity_received comes back off its PO line, and the PO status is recomputed (received ->
 * partially_received / approved). Posts nothing. The note is kept, never deleted, and a cancelled note never changes again
 * (migration 1021's trigger).
 *
 * Refused (typed `GoodsReceivedError`, before any write): another company's or no such note (not_found), a note already
 * cancelled (already_cancelled), a PO that is not approved / partially_received / received, e.g. closed or cancelled
 * (po_not_receivable), and a note a bill that is not deleted carries in `supplier_invoices.grn_id` (grn_on_bill, naming them).
 * Billed quantity above received quantity after a cancel is allowed, as it is when a bill arrives before the goods.
 *
 * Locks, the create's order: number lock 620 -> the PO row FOR UPDATE -> its po_items FOR UPDATE -> the note FOR UPDATE. The note
 * row lock conflicts with the KEY SHARE a bill insert / update naming the note takes on it (the grn_id foreign key), so a bill
 * written concurrently is either seen by the bill check or waits for this to commit.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { lockPoForReceipt, recomputePoReceiptStatus } from './goodsReceivedService';
import { GoodsReceivedError } from './goodsReceivedValidation';

export const CANCEL_REASON_MAX = 500;
const CANCELLABLE_PO_STATUSES: readonly string[] = ['approved', 'partially_received', 'received'];
const BILLS_SHOWN = 10;

export interface CancelledGoodsReceived {
  grnId: string;
  grnNumber: string;
  poId: string;
  poNumber: string;
  poStatusBefore: string;
  poStatusAfter: string;
  items: Array<{ poItemId: string; quantityReceived: number; quantityRejected: number }>;
}

export async function cancelGoodsReceived(
  companyId: string, grnId: string, reason: string, opts: { userId: string; via: string },
): Promise<CancelledGoodsReceived> {
  const why = reason.trim();
  if (why === '' || why.length > CANCEL_REASON_MAX) throw new GoodsReceivedError(`Give a reason of at most ${CANCEL_REASON_MAX} characters to cancel a goods received note`);
  return withSavepoint('cancel_goods_received', async () => {
    const head = ((await sql`
      SELECT purchase_order_id::text AS po_id FROM goods_received_notes WHERE id = ${grnId}::uuid AND company_id = ${companyId}::uuid
    `) as DbRow[])[0];
    if (!head) throw new GoodsReceivedError('Goods received note not found', 'not_found');
    const poId = String(head.po_id);
    const locked = await lockPoForReceipt(companyId, poId);
    if (!locked) throw new GoodsReceivedError('Goods received note not found', 'not_found');
    const note = ((await sql`
      SELECT id, grn_number, status, purchase_order_id::text AS po_id FROM goods_received_notes
       WHERE id = ${grnId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE
    `) as DbRow[])[0];
    if (!note || String(note.po_id) !== poId) throw new GoodsReceivedError('Goods received note not found', 'not_found');
    const grnNumber = String(note.grn_number);
    if (note.status === 'cancelled') throw new GoodsReceivedError(`${grnNumber} is already cancelled`, 'already_cancelled');
    const poStatus = String(locked.po.status);
    if (!CANCELLABLE_PO_STATUSES.includes(poStatus)) {
      throw new GoodsReceivedError(`The purchase order is ${poStatus.replace(/_/g, ' ')}, so its receipts cannot be cancelled; set the purchase order status back first`,
        'po_not_receivable', { poStatus });
    }
    const bills = (await sql`
      SELECT si.id::text AS id, si.invoice_number, count(*) OVER ()::int AS n FROM supplier_invoices si
       WHERE si.company_id = ${companyId}::uuid AND si.grn_id = ${grnId}::uuid AND si.deleted_at IS NULL
       ORDER BY si.invoice_number, si.id LIMIT ${BILLS_SHOWN}
    `) as DbRow[];
    if (bills.length > 0) {
      const named = bills.map((b) => `${String(b.invoice_number)} (${String(b.id)})`).join(', ');
      const total = Number(bills[0]!.n);
      throw new GoodsReceivedError(
        `${grnNumber} is on ${total === 1 ? 'a bill' : `${total} bills`}: ${named}${total > bills.length ? ` and ${total - bills.length} more` : ''}. Remove the goods received note from ${total === 1 ? 'that bill' : 'those bills'} first, then cancel it`,
        'grn_on_bill', { bills: bills.map((b) => ({ id: String(b.id), invoiceNumber: String(b.invoice_number) })), billsTotal: total });
    }
    const items = (await sql`
      SELECT gi.po_item_id::text AS po_item_id, gi.quantity_received, COALESCE(gi.quantity_rejected, 0) AS quantity_rejected
        FROM grn_items gi JOIN goods_received_notes g ON g.id = gi.grn_id AND g.company_id = ${companyId}::uuid
       WHERE gi.grn_id = ${grnId}::uuid ORDER BY gi.po_item_id, gi.id
    `) as DbRow[];

    await sql`
      UPDATE goods_received_notes SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = ${opts.userId}, cancel_reason = ${why}
       WHERE id = ${grnId}::uuid AND company_id = ${companyId}::uuid
    `;
    // Every line this note received, its quantity back off: one statement, summed per PO line, scoped through the PO.
    const restored = (await sql`
      UPDATE po_items pi SET quantity_received = pi.quantity_received - r.qty
        FROM (SELECT gi.po_item_id, sum(gi.quantity_received) AS qty FROM grn_items gi WHERE gi.grn_id = ${grnId}::uuid GROUP BY gi.po_item_id) r,
             purchase_orders po
       WHERE pi.id = r.po_item_id AND po.id = pi.purchase_order_id AND po.id = ${poId}::uuid AND po.company_id = ${companyId}::uuid
         AND r.qty > 0
       RETURNING pi.id, pi.quantity_received
    `) as DbRow[];
    if (restored.some((r) => Number(r.quantity_received) < 0)) {
      // The PO line holds less than this note received: the receipts and the line disagree. Not the caller's to fix; nothing is kept.
      throw new Error(`goods received note ${grnId}: a PO line's received quantity would fall below zero`);
    }
    const after = await recomputePoReceiptStatus(companyId, poId);
    await logAuditOrThrow({
      companyId, userId: opts.userId, action: 'update', entityType: 'goods_received_note', entityId: grnId, entityRef: grnNumber,
      changes: {
        fields: [{ field: 'status', old: String(note.status), new: 'cancelled', label: 'Status' }],
        metadata: {
          cancelled: 'true', reason: why, source: opts.via, purchase_order_id: poId, po_number: String(locked.po.po_number).slice(0, 100),
          po_status_before: poStatus, po_status_after: after, lines: String(items.length),
        },
      },
    });
    return {
      grnId, grnNumber, poId, poNumber: String(locked.po.po_number), poStatusBefore: poStatus, poStatusAfter: after,
      items: items.map((i) => ({ poItemId: String(i.po_item_id), quantityReceived: Number(i.quantity_received), quantityRejected: Number(i.quantity_rejected) })),
    };
  });
}
