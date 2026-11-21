/**
 * list_goods_received and get_goods_received: goods received notes with their PO, supplier, items, documents (entity-store kind
 * `goods_received`) and the bills that carry them (`supplier_invoices.grn_id`). Reads only; every query is company-scoped
 * (grn_items and po_items have no company_id: they are reached through the note / the PO). Cancelled notes are listed with
 * status `cancelled`. The list is offset-paged on (received_date, grn_number, id), a total order; the detail's lists are capped
 * with their totals beside them, and its items page (`items_offset` / `items_limit`; `items_truncated` when the page is not every item,
 * `items_next_offset` null on the last page). The caps
 * and text limits are sized so the widest reply (every list full, every text field at its limit in three-byte characters) stays
 * under MAX_READ_RESULT_BYTES (gate finding 5; `mcp-goods-received-read.int.test.ts`). A note's documents are both entity types
 * it is filed under: `goods_received` and the legacy `goods_receipt_note` (gate finding 4).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

export const GRN_STATUSES = ['draft', 'received', 'inspected', 'accepted', 'rejected', 'cancelled'] as const;
/** `items` is the largest page of items (items_limit's maximum and default). */
export const GRN_DETAIL_CAPS = { items: 40, documents: 25, bills: 25 } as const;
/** Both entity types a note's documents are filed under (VALID_ENTITY_TYPES writes only the first). */
export const GRN_DOCUMENT_ENTITY_TYPES = ['goods_received', 'goods_receipt_note'] as const;
/** list_goods_received's page (round 3, finding 5): sized with LIST_TEXT_CAP so the widest page stays under MAX_READ_RESULT_BYTES. */
export const GRN_LIST_LIMITS = { default: 25, max: 30 } as const;
const TEXT_CAP = 150;
/** The list's compact projection: free text (received_by, supplier, notes, cancel reason) cut shorter; get_goods_received has it whole. */
const LIST_TEXT_CAP = 80;

const day = (v: unknown): string | null => (v == null || v === '' ? null : fmtDate(v));
const text = (v: unknown): string | null => (v == null ? null : String(v));
const short = (v: unknown): string | null => (v == null ? null : String(v).slice(0, TEXT_CAP));
const stamp = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());

export interface GoodsReceivedListFilters {
  poId: string | null;
  supplierId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  externalRef: string | null;
  statuses: string[] | null;
}

function noteOut(r: DbRow, compact = false) {
  const free = (v: unknown, cap: number): string | null => (v == null ? null : String(v).slice(0, compact ? LIST_TEXT_CAP : cap));
  return {
    id: String(r.id), grn_number: short(r.grn_number) ?? '', status: String(r.status), received_date: day(r.received_date),
    received_by: free(r.received_by, TEXT_CAP), notes: free(r.notes, 500),
    purchase_order_id: String(r.purchase_order_id), po_number: short(r.po_number), po_status: text(r.po_status),
    supplier_id: text(r.supplier_id), supplier_name: free(r.supplier_name, TEXT_CAP),
    external_system: short(r.external_system), external_ref: short(r.external_ref),
    cancelled_at: stamp(r.cancelled_at), cancelled_by: short(r.cancelled_by), cancel_reason: free(r.cancel_reason, 500),
    created_at: stamp(r.created_at),
  };
}

export async function listGoodsReceived(
  companyId: string, f: GoodsReceivedListFilters, page: { limit: number; offset: number },
): Promise<{ rows: Array<ReturnType<typeof noteOut> & { line_count: number; document_count: number }>; total: number }> {
  const rows = (await sql`
    SELECT g.id, g.grn_number, g.status, g.received_date, g.received_by, g.notes, g.purchase_order_id, g.external_system, g.external_ref,
           g.cancelled_at, g.cancelled_by, g.cancel_reason, g.created_at, po.po_number, po.status AS po_status, po.supplier_id, s.name AS supplier_name,
           (SELECT count(*) FROM grn_items gi WHERE gi.grn_id = g.id)::INT AS line_count,
           (SELECT count(*) FROM procurement_documents d
             WHERE d.entity_type = ANY(${[...GRN_DOCUMENT_ENTITY_TYPES]}::TEXT[]) AND d.entity_id = g.id AND d.is_active = true)::INT AS document_count,
           count(*) OVER ()::INT AS total_rows
      FROM goods_received_notes g
      JOIN purchase_orders po ON po.id = g.purchase_order_id AND po.company_id = g.company_id
      LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
     WHERE g.company_id = ${companyId}::UUID
       AND (${f.poId}::UUID IS NULL OR g.purchase_order_id = ${f.poId}::UUID)
       AND (${f.supplierId}::UUID IS NULL OR po.supplier_id = ${f.supplierId}::UUID)
       AND (${f.dateFrom}::DATE IS NULL OR g.received_date >= ${f.dateFrom}::DATE)
       AND (${f.dateTo}::DATE IS NULL OR g.received_date <= ${f.dateTo}::DATE)
       AND (${f.externalRef}::TEXT IS NULL OR g.external_ref = ${f.externalRef})
       AND (${f.statuses}::TEXT[] IS NULL OR g.status = ANY(${f.statuses}::TEXT[]))
     ORDER BY g.received_date, g.grn_number, g.id
     LIMIT ${page.limit} OFFSET ${page.offset}
  `) as DbRow[];
  if (rows.length === 0 && page.offset > 0) {
    const head = await listGoodsReceived(companyId, f, { limit: 1, offset: 0 });
    return { rows: [], total: head.total };
  }
  return {
    rows: rows.map((r) => ({ ...noteOut(r, true), line_count: Number(r.line_count), document_count: Number(r.document_count) })),
    total: rows[0] ? Number(rows[0].total_rows) : 0,
  };
}

export async function readGoodsReceivedDetail(
  companyId: string, grnId: string, itemsPage: { offset: number; limit: number } = { offset: 0, limit: GRN_DETAIL_CAPS.items },
) {
  const itemsLimit = Math.min(Math.max(1, itemsPage.limit), GRN_DETAIL_CAPS.items);
  const head = ((await sql`
    SELECT g.*, po.po_number, po.status AS po_status, po.supplier_id, s.name AS supplier_name
      FROM goods_received_notes g
      JOIN purchase_orders po ON po.id = g.purchase_order_id AND po.company_id = g.company_id
      LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
     WHERE g.id = ${grnId}::UUID AND g.company_id = ${companyId}::UUID
  `) as DbRow[])[0];
  if (!head) return null;
  // LEFT JOIN (gate finding 6): an item whose PO line is not on the note's PO (a legacy row, which the cancel refuses as
  // items_not_on_po) is kept with its own quantities, the line's metadata null; it sorts after the note's PO's lines.
  const items = (await sql`
    SELECT gi.id, gi.po_item_id, gi.quantity_received, gi.quantity_rejected, gi.notes, pi.id AS on_po, pi.description, pi.quantity AS ordered,
           pi.quantity_received AS line_received, count(*) OVER ()::INT AS total_rows
      FROM grn_items gi
      JOIN goods_received_notes g ON g.id = gi.grn_id AND g.company_id = ${companyId}::UUID
      LEFT JOIN po_items pi ON pi.id = gi.po_item_id AND pi.purchase_order_id = g.purchase_order_id
     WHERE gi.grn_id = ${grnId}::UUID
     ORDER BY pi.sort_order NULLS LAST, pi.id NULLS LAST, gi.po_item_id, gi.id LIMIT ${itemsLimit} OFFSET ${itemsPage.offset}
  `) as DbRow[];
  // The total when the page is past the end (no row to carry the window count).
  const itemsTotal = items[0] ? Number(items[0].total_rows) : itemsPage.offset === 0 ? 0 : Number(((await sql`
    SELECT count(*)::INT AS n FROM grn_items gi JOIN goods_received_notes g ON g.id = gi.grn_id AND g.company_id = ${companyId}::UUID
     WHERE gi.grn_id = ${grnId}::UUID
  `) as DbRow[])[0]?.n ?? 0);
  const docs = (await sql`
    SELECT d.id, d.document_name, d.document_type, d.mime_type, d.file_size, d.uploaded_at, count(*) OVER ()::INT AS total_rows
      FROM procurement_documents d JOIN goods_received_notes g ON g.id = d.entity_id AND g.company_id = ${companyId}::UUID
     WHERE d.entity_type = ANY(${[...GRN_DOCUMENT_ENTITY_TYPES]}::TEXT[]) AND d.entity_id = ${grnId}::UUID AND d.is_active = true
     ORDER BY d.uploaded_at, d.id LIMIT ${GRN_DETAIL_CAPS.documents}
  `) as DbRow[];
  const bills = (await sql`
    SELECT si.id, si.invoice_number, si.status, si.invoice_date, si.total_amount, (si.deleted_at IS NOT NULL) AS deleted, count(*) OVER ()::INT AS total_rows
      FROM supplier_invoices si WHERE si.company_id = ${companyId}::UUID AND si.grn_id = ${grnId}::UUID
     ORDER BY si.invoice_date, si.invoice_number, si.id LIMIT ${GRN_DETAIL_CAPS.bills}
  `) as DbRow[];
  const total = (rows: DbRow[]) => (rows[0] ? Number(rows[0].total_rows) : 0);
  return {
    goods_received_note: noteOut(head),
    items: items.map((i) => {
      const onPo = i.on_po != null;
      return {
        id: String(i.id), po_item_id: String(i.po_item_id), on_purchase_order: onPo, description: onPo ? short(i.description) : null,
        quantity_ordered: onPo ? Number(i.ordered) : null,
        quantity_received: Number(i.quantity_received), quantity_rejected: Number(i.quantity_rejected ?? 0),
        po_line_quantity_received: onPo ? Number(i.line_received ?? 0) : null, notes: short(i.notes),
      };
    }),
    items_total: itemsTotal,
    items_offset: itemsPage.offset,
    items_truncated: items.length < itemsTotal,
    items_next_offset: items.length > 0 && itemsPage.offset + items.length < itemsTotal ? itemsPage.offset + items.length : null,
    documents: docs.map((d) => ({
      id: String(d.id), name: short(d.document_name), document_type: text(d.document_type), mime_type: text(d.mime_type),
      size: d.file_size == null ? null : Number(d.file_size), uploaded_at: stamp(d.uploaded_at),
    })),
    documents_total: total(docs),
    bills: bills.map((b) => ({
      id: String(b.id), invoice_number: String(b.invoice_number), status: String(b.status), invoice_date: day(b.invoice_date),
      total_amount: Number(b.total_amount ?? 0), deleted: b.deleted === true,
    })),
    bills_total: total(bills),
  };
}
