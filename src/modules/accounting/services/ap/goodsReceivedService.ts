/**
 * Goods receipts: the app's POST /api/accounting/goods-received and MCP create_goods_received run the same `receiveGoods`.
 * Posts nothing: a receipt records quantities (grn_items, po_items.quantity_received) and moves the PO status; the ledger moves
 * when the bill is approved. Locks, first first: number lock 620 (the GRN-NNNNN sequence, scope the company), the PO row
 * `FOR UPDATE`, its po_items `FOR UPDATE`. Nothing takes 620 after a PO row (the cancel takes no 620 at all: PO -> po_items -> note). Every refusal is a
 * typed `GoodsReceivedError` raised before the first write, every refused line listed: all or nothing. Audited.
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { requireCtx } from '@/lib/als';
import { logAuditOrThrow } from '../core/auditTrailService';
import { GoodsReceivedError, parseGoodsReceived, type GoodsReceivedLineRefusal } from './goodsReceivedValidation';
export { GoodsReceivedError } from './goodsReceivedValidation';

/** The statuses that take a receipt (and whose receipts can be cancelled). */
export const RECEIVING_PO_STATUSES: readonly string[] = ['approved', 'partially_received'];
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

export interface GoodsReceivedOptions {
  /** Recorded as the audit row's source (e.g. `mcp:create_goods_received`); the app route sends none. */
  via?: string;
  /** The source system's id for this receipt: unique per company among notes that are not cancelled. */
  external?: { system: string; ref: string } | null;
}

export interface ReceivedGoods {
  receipt: DbRow;
  poNumber: string;
  poStatusBefore: string;
  poStatusAfter: string;
  items: Array<{ poItemId: string; quantityReceived: number; quantityRejected: number }>;
}

/** Number lock 620, then the PO row and its lines, company-scoped. Null when the PO is not this company's. */
export async function lockPoForReceipt(companyId: string, poId: string): Promise<{ po: DbRow; items: DbRow[] } | null> {
  // The same key as before (scope = the company id, seed 620), now bounded at 5 s tighten-only (migration 864).
  await sql`SELECT public.take_number_lock(${companyId}::text, 620)`;
  const po = ((await sql`
    SELECT id, po_number, status FROM purchase_orders WHERE id = ${poId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE
  `) as DbRow[])[0];
  if (!po) return null;
  const items = (await sql`
    SELECT pi.id, pi.quantity, pi.quantity_received FROM po_items pi
      JOIN purchase_orders po ON po.id = pi.purchase_order_id
     WHERE po.company_id = ${companyId}::uuid AND po.id = ${poId}::uuid ORDER BY pi.id FOR UPDATE OF pi
  `) as DbRow[];
  return { po, items };
}

/** received when every line is received in full, partially_received when any is received, else approved. Returns the status. */
export async function recomputePoReceiptStatus(companyId: string, poId: string): Promise<string> {
  const rows = (await sql`
    UPDATE purchase_orders po SET status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM po_items pi WHERE pi.purchase_order_id = po.id AND COALESCE(pi.quantity_received, 0) < pi.quantity) THEN 'received'
      WHEN EXISTS (SELECT 1 FROM po_items pi WHERE pi.purchase_order_id = po.id AND pi.quantity_received > 0) THEN 'partially_received'
      ELSE 'approved' END, updated_at = NOW()
    WHERE po.id = ${poId}::uuid AND po.company_id = ${companyId}::uuid RETURNING po.status
  `) as DbRow[];
  return String(rows[0]!.status);
}

/**
 * The live (not cancelled) note of this company holding (system, ref), or null. Read under lock 620, which every create holds, so two
 * creates never both pass; the cancel takes no 620, but it only ever frees a reference (live -> cancelled), so a create that reads a
 * note as live while its cancel is uncommitted refuses (retry once it commits), and goods_received_notes_external_ref_uq is behind it.
 */
export async function liveNoteWithRef(companyId: string, system: string, ref: string): Promise<{ id: string; grnNumber: string } | null> {
  const row = ((await sql`
    SELECT id::text AS id, grn_number FROM goods_received_notes
     WHERE company_id = ${companyId}::uuid AND external_system = ${system} AND external_ref = ${ref} AND status <> 'cancelled'
     ORDER BY created_at, id LIMIT 1
  `) as DbRow[])[0];
  return row ? { id: String(row.id), grnNumber: String(row.grn_number) } : null;
}

export async function receiveGoods(companyId: string, userId: string, input: unknown, opts: GoodsReceivedOptions = {}): Promise<ReceivedGoods> {
  const ctx = requireCtx();
  if (ctx.companyId !== companyId || ctx.userId !== userId) throw new Error('Receipt requires the authenticated company transaction');
  const body = parseGoodsReceived(input, userId);
  const external = opts.external ? { system: opts.external.system.toLowerCase(), ref: opts.external.ref } : null;
  return withTransaction(async () => {
    const locked = await lockPoForReceipt(companyId, body.purchaseOrderId);
    if (external) {
      const holder = await liveNoteWithRef(companyId, external.system, external.ref);
      if (holder) {
        throw new GoodsReceivedError(`This delivery is already received as ${holder.grnNumber} (external reference ${external.system} ${external.ref}); nothing was written`,
          'duplicate_external_ref', { existing: holder });
      }
    }
    if (!locked) throw new GoodsReceivedError('Purchase order not found', 'not_found');
    const { po, items } = locked;
    const status = String(po.status);
    // A received PO has nothing outstanding: a line asking for more is answered as the over-receipt it is (the lines below).
    if (!RECEIVING_PO_STATUSES.includes(status) && status !== 'received') {
      throw new GoodsReceivedError('Only approved or partially received orders accept receipts', 'po_not_receivable', { poStatus: status });
    }
    const refused: GoodsReceivedLineRefusal[] = [...body.duplicates];
    const repeated = new Set(body.duplicates.map((d) => d.index));
    body.items.forEach((line, index) => {
      if (repeated.has(index)) return;
      const item = items.find((i) => String(i.id) === line.poItemId);
      if (!item) { refused.push({ index, poItemId: line.poItemId, code: 'line_not_on_po' }); return; }
      const outstanding = cents(item.quantity) - cents(item.quantity_received);
      if (Math.round(line.quantityReceived * 100) > outstanding) {
        refused.push({ index, poItemId: line.poItemId, code: 'over_receipt', outstanding: outstanding / 100, asked: line.quantityReceived });
      }
    });
    if (refused.length > 0) {
      refused.sort((a, b) => a.index - b.index);
      const first = refused[0]!;
      const message = first.code === 'line_not_on_po' ? 'Every receipt line must belong to this purchase order'
        : first.code === 'duplicate_line' ? 'A purchase order line may appear only once per receipt'
          : 'Received quantity exceeds the outstanding order quantity';
      throw new GoodsReceivedError(message, first.code, { lines: refused });
    }
    if (status === 'received') {
      throw new GoodsReceivedError('Only approved or partially received orders accept receipts', 'po_not_receivable', { poStatus: status });
    }
    const sequence = (await sql`
      SELECT (COALESCE(MAX(substring(grn_number from 5)::numeric), 0) + 1)::text AS next
        FROM goods_received_notes WHERE company_id = ${companyId}::uuid AND grn_number ~ '^GRN-[0-9]+$'
    `) as DbRow[];
    const number = `GRN-${String(sequence[0]!.next).padStart(5, '0')}`;
    const receipt = ((await sql`
      INSERT INTO goods_received_notes (company_id, grn_number, purchase_order_id, received_date, received_by, notes, created_by, external_system, external_ref)
      VALUES (${companyId}::uuid, ${number}, ${body.purchaseOrderId}::uuid, ${body.receivedDate}::date, ${body.receivedBy}, ${body.notes ?? null}, ${userId},
              ${external?.system ?? null}, ${external?.ref ?? null}) RETURNING *
    `) as DbRow[])[0]!;
    for (const line of body.items) {
      await sql`
        INSERT INTO grn_items (grn_id, po_item_id, quantity_received, quantity_rejected, notes)
        SELECT g.id, pi.id, ${line.quantityReceived}, ${line.quantityRejected}, ${line.notes ?? null}
          FROM goods_received_notes g JOIN purchase_orders po ON po.id = g.purchase_order_id AND po.company_id = g.company_id
          JOIN po_items pi ON pi.purchase_order_id = po.id
         WHERE g.id = ${receipt.id as string}::uuid AND g.company_id = ${companyId}::uuid AND pi.id = ${line.poItemId}::uuid
      `;
      await sql`
        UPDATE po_items pi SET quantity_received = COALESCE(pi.quantity_received, 0) + ${line.quantityReceived}
          FROM purchase_orders po WHERE pi.purchase_order_id = po.id AND po.company_id = ${companyId}::uuid
           AND po.id = ${body.purchaseOrderId}::uuid AND pi.id = ${line.poItemId}::uuid
      `;
    }
    const after = await recomputePoReceiptStatus(companyId, body.purchaseOrderId);
    await logAuditOrThrow({
      companyId, userId, action: 'create', entityType: 'goods_received_note', entityId: String(receipt.id), entityRef: number,
      changes: {
        fields: [{ field: 'status', old: null, new: String(receipt.status), label: 'Status' }],
        metadata: {
          source: opts.via ?? 'app', purchase_order_id: body.purchaseOrderId, po_number: String(po.po_number).slice(0, 100),
          po_status_before: status, po_status_after: after, lines: String(body.items.length),
          ...(external ? { external_system: external.system, external_ref: external.ref.slice(0, 128) } : {}),
        },
      },
    });
    return {
      receipt, poNumber: String(po.po_number), poStatusBefore: status, poStatusAfter: after,
      items: body.items.map((l) => ({ poItemId: l.poItemId, quantityReceived: l.quantityReceived, quantityRejected: l.quantityRejected })),
    };
  });
}

/** The app route's entry point: the note's row. */
export async function createGoodsReceived(companyId: string, userId: string, input: unknown) {
  return (await receiveGoods(companyId, userId, input)).receipt;
}
