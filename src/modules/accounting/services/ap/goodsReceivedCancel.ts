/**
 * cancel_goods_received (design docs/design/mcp-goods-received.md): a goods received note becomes `cancelled` (with who, when and
 * why), each of its items' quantity_received comes back off its PO line, and the PO status is recomputed (received ->
 * partially_received / approved). Posts nothing. The note is kept, never deleted, and a cancelled note never changes again
 * (migration 1021's trigger).
 *
 * Refused (typed `GoodsReceivedError`, nothing written): another company's or no such note (not_found), a note already cancelled
 * (already_cancelled), a PO that is not approved / partially_received / received, e.g. closed or cancelled (po_not_receivable), and a
 * note a bill that is neither deleted nor cancelled carries in `supplier_invoices.grn_id` (grn_on_bill, naming them; cancelling or
 * deleting those bills frees it). Billed quantity above received quantity after a cancel is allowed, as when a bill arrives first.
 *
 * The write is migration 1021's `goods_received_note_cancel` (SECURITY DEFINER: app_user has no UPDATE or DELETE on the notes or their
 * items). It re-decides every refusal under the note lock and answers it instead of writing. This service keeps the guards that
 * name things, the locks and the audit row.
 *
 * Locks, the create's order: number lock 620 -> the PO row FOR UPDATE -> its po_items FOR UPDATE -> (in the function) the note FOR
 * UPDATE. A bill naming the note (create, restore) holds it FOR SHARE (`goods_received_note_hold`) until it commits, after any PO
 * lock it takes: the note lock waits for that bill and the bill check after it sees the bill, or the bill waits and reads `cancelled`.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
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

export interface NoteForCancel { poId: string; poNumber: string; poStatus: string; grnNumber: string; status: string }

/**
 * Number lock 620, then the note's PO row FOR UPDATE (reached through the note, ONE company filter: the PO's, the note tied to the
 * PO's company by the join) and its lines. Null when the note is not this company's. The note's status read here is stable: only the
 * cancel changes it, and the cancel holds this PO lock first.
 */
export async function lockNoteForCancel(companyId: string, grnId: string): Promise<NoteForCancel | null> {
  await sql`SELECT public.take_number_lock(${companyId}::text, 620)`;
  const row = ((await sql`
    SELECT po.id::text AS po_id, po.po_number, po.status AS po_status, g.grn_number, g.status
      FROM goods_received_notes g JOIN purchase_orders po ON po.id = g.purchase_order_id AND po.company_id = g.company_id
     WHERE g.id = ${grnId}::uuid AND po.company_id = ${companyId}::uuid
       FOR UPDATE OF po
  `) as DbRow[])[0];
  if (!row) return null;
  await sql`SELECT pi.id FROM po_items pi WHERE pi.purchase_order_id = ${String(row.po_id)}::uuid ORDER BY pi.id FOR UPDATE OF pi`;
  // Re-read after the lock (a fresh statement): the join above could return the note as it was before a cancel that held the PO.
  const note = ((await sql`SELECT status FROM goods_received_notes WHERE id = ${grnId}::uuid AND purchase_order_id = ${String(row.po_id)}::uuid`) as DbRow[])[0];
  return {
    poId: String(row.po_id), poNumber: String(row.po_number), poStatus: String(row.po_status), grnNumber: String(row.grn_number),
    status: String(note?.status ?? row.status),
  };
}

async function onBillRefusal(companyId: string, grnId: string, grnNumber: string): Promise<GoodsReceivedError> {
  const bills = (await sql`
    SELECT si.id::text AS id, si.invoice_number, count(*) OVER ()::int AS n FROM supplier_invoices si
     WHERE si.company_id = ${companyId}::uuid AND si.grn_id = ${grnId}::uuid AND si.deleted_at IS NULL AND si.status <> 'cancelled'
     ORDER BY si.invoice_number, si.id LIMIT ${BILLS_SHOWN}
  `) as DbRow[];
  const total = Number(bills[0]?.n ?? 0);
  const named = bills.map((b) => `${String(b.invoice_number)} (${String(b.id)})`).join(', ');
  return new GoodsReceivedError(
    `${grnNumber} is on ${total === 1 ? 'a bill' : `${total} bills`}: ${named}${total > bills.length ? ` and ${total - bills.length} more` : ''}. Cancel or delete ${total === 1 ? 'that bill' : 'those bills'} first (a paid bill needs its payment reversed before it can be cancelled), then cancel the note`,
    'grn_on_bill', { bills: bills.map((b) => ({ id: String(b.id), invoiceNumber: String(b.invoice_number) })), billsTotal: total });
}

const notReceivable = (poStatus: string) => new GoodsReceivedError(
  `The purchase order is ${poStatus.replace(/_/g, ' ')}, so its receipts cannot be cancelled; set the purchase order status back first`,
  'po_not_receivable', { poStatus });

export async function cancelGoodsReceived(
  companyId: string, grnId: string, reason: string, opts: { userId: string; via: string },
): Promise<CancelledGoodsReceived> {
  const why = reason.trim();
  if (why === '' || why.length > CANCEL_REASON_MAX) throw new GoodsReceivedError(`Give a reason of at most ${CANCEL_REASON_MAX} characters to cancel a goods received note`);
  return withSavepoint('cancel_goods_received', async () => {
    const note = await lockNoteForCancel(companyId, grnId);
    if (!note) throw new GoodsReceivedError('Goods received note not found', 'not_found');
    const { poId, grnNumber } = note;
    if (note.status === 'cancelled') throw new GoodsReceivedError(`${grnNumber} is already cancelled`, 'already_cancelled');
    if (!CANCELLABLE_PO_STATUSES.includes(note.poStatus)) throw notReceivable(note.poStatus);
    const items = (await sql`
      SELECT gi.po_item_id::text AS po_item_id, gi.quantity_received, COALESCE(gi.quantity_rejected, 0) AS quantity_rejected
        FROM grn_items gi JOIN goods_received_notes g ON g.id = gi.grn_id AND g.company_id = ${companyId}::uuid
       WHERE gi.grn_id = ${grnId}::uuid ORDER BY gi.po_item_id, gi.id
    `) as DbRow[];

    const done = ((await sql`SELECT outcome, po_status FROM public.goods_received_note_cancel(${grnId}::uuid, ${why})`) as DbRow[])[0];
    const outcome = String(done?.outcome ?? 'not_found');
    if (outcome === 'grn_on_bill') throw await onBillRefusal(companyId, grnId, grnNumber);
    if (outcome === 'already_cancelled') throw new GoodsReceivedError(`${grnNumber} is already cancelled`, 'already_cancelled');
    if (outcome === 'po_not_receivable') throw notReceivable(String(done!.po_status));
    if (outcome !== 'cancelled') throw new GoodsReceivedError('Goods received note not found', 'not_found');
    const after = String(done!.po_status);

    await logAuditOrThrow({
      companyId, userId: opts.userId, action: 'update', entityType: 'goods_received_note', entityId: grnId, entityRef: grnNumber,
      changes: {
        fields: [{ field: 'status', old: note.status, new: 'cancelled', label: 'Status' }],
        metadata: {
          cancelled: 'true', reason: why, source: opts.via, purchase_order_id: poId, po_number: note.poNumber.slice(0, 100),
          po_status_before: note.poStatus, po_status_after: after, lines: String(items.length),
        },
      },
    });
    return {
      grnId, grnNumber, poId, poNumber: note.poNumber, poStatusBefore: note.poStatus, poStatusAfter: after,
      items: items.map((i) => ({ poItemId: String(i.po_item_id), quantityReceived: Number(i.quantity_received), quantityRejected: Number(i.quantity_rejected) })),
    };
  });
}
