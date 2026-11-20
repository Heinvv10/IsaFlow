/**
 * list_goods_received and get_goods_received: goods received notes with their PO, supplier, items, documents (entity-store kind
 * `goods_received`) and the bills that carry them (`supplier_invoices.grn_id`). Reads only; every query is company-scoped
 * (grn_items and po_items have no company_id: they are reached through the note / the PO). Cancelled notes are listed with
 * status `cancelled`. The list is offset-paged on (received_date, grn_number, id), a total order; the detail's lists are capped
 * with their totals beside them.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

export const GRN_STATUSES = ['draft', 'received', 'inspected', 'accepted', 'rejected', 'cancelled'] as const;
export const GRN_DETAIL_CAPS = { items: 100, documents: 25, bills: 25 } as const;
const TEXT_CAP = 150;

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

function noteOut(r: DbRow) {
  return {
    id: String(r.id), grn_number: String(r.grn_number), status: String(r.status), received_date: day(r.received_date),
    received_by: short(r.received_by), notes: text(r.notes)?.slice(0, 500) ?? null,
    purchase_order_id: String(r.purchase_order_id), po_number: text(r.po_number), po_status: text(r.po_status),
    supplier_id: text(r.supplier_id), supplier_name: short(r.supplier_name),
    external_system: short(r.external_system), external_ref: short(r.external_ref),
    cancelled_at: stamp(r.cancelled_at), cancelled_by: text(r.cancelled_by), cancel_reason: text(r.cancel_reason)?.slice(0, 500) ?? null,
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
             WHERE d.entity_type = 'goods_received' AND d.entity_id = g.id AND d.is_active = true)::INT AS document_count,
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
    rows: rows.map((r) => ({ ...noteOut(r), line_count: Number(r.line_count), document_count: Number(r.document_count) })),
    total: rows[0] ? Number(rows[0].total_rows) : 0,
  };
}

export async function readGoodsReceivedDetail(companyId: string, grnId: string) {
  const head = ((await sql`
    SELECT g.*, po.po_number, po.status AS po_status, po.supplier_id, s.name AS supplier_name
      FROM goods_received_notes g
      JOIN purchase_orders po ON po.id = g.purchase_order_id AND po.company_id = g.company_id
      LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
     WHERE g.id = ${grnId}::UUID AND g.company_id = ${companyId}::UUID
  `) as DbRow[])[0];
  if (!head) return null;
  const items = (await sql`
    SELECT gi.id, gi.po_item_id, gi.quantity_received, gi.quantity_rejected, gi.notes, pi.description, pi.quantity AS ordered,
           pi.quantity_received AS line_received, count(*) OVER ()::INT AS total_rows
      FROM grn_items gi
      JOIN goods_received_notes g ON g.id = gi.grn_id AND g.company_id = ${companyId}::UUID
      JOIN po_items pi ON pi.id = gi.po_item_id AND pi.purchase_order_id = g.purchase_order_id
     WHERE gi.grn_id = ${grnId}::UUID
     ORDER BY pi.sort_order, pi.id, gi.id LIMIT ${GRN_DETAIL_CAPS.items}
  `) as DbRow[];
  const docs = (await sql`
    SELECT d.id, d.document_name, d.document_type, d.mime_type, d.file_size, d.uploaded_at, count(*) OVER ()::INT AS total_rows
      FROM procurement_documents d JOIN goods_received_notes g ON g.id = d.entity_id AND g.company_id = ${companyId}::UUID
     WHERE d.entity_type = 'goods_received' AND d.entity_id = ${grnId}::UUID AND d.is_active = true
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
    items: items.map((i) => ({
      id: String(i.id), po_item_id: String(i.po_item_id), description: short(i.description), quantity_ordered: Number(i.ordered),
      quantity_received: Number(i.quantity_received), quantity_rejected: Number(i.quantity_rejected ?? 0),
      po_line_quantity_received: Number(i.line_received ?? 0), notes: short(i.notes),
    })),
    items_total: total(items),
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
