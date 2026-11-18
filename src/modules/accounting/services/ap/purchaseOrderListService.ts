/**
 * Purchase orders for list_purchase_orders: one row per PO with its supplier, totals, whether a document is filed on
 * it (an active entity-store row, entity_type 'purchase_order') and its external reference. Company-scoped; ordered on
 * (po_number, id), a total order, so an offset walk serves every PO once. Totals are over the whole filter.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface PurchaseOrderListFilters {
  poNumber: string | null;
  statuses: string[] | null;
  supplierId: string | null;
  fromDate: string | null;
  toDate: string | null;
  externalSystem: string | null;
  externalRef: string | null;
}

export interface PurchaseOrderListRow {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string | null;
  orderDate: string;
  deliveryDate: string | null;
  status: string;
  reference: string | null;
  subtotal: number;
  taxAmount: number;
  total: number;
  lineCount: number;
  documentCount: number;
  externalSystem: string | null;
  externalRef: string | null;
  externalDocumentNumber: string | null;
}

const day = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};

export async function listPurchaseOrdersForMcp(
  companyId: string, f: PurchaseOrderListFilters, page: { limit: number; offset: number },
): Promise<{ rows: PurchaseOrderListRow[]; total: number; totals: { subtotal: number; taxAmount: number; total: number } }> {
  const rows = (await sql`
    WITH po AS (
      SELECT po.* FROM purchase_orders po
       WHERE po.company_id = ${companyId}::UUID
         AND (${f.poNumber}::TEXT IS NULL OR po.po_number = ${f.poNumber})
         AND (${f.statuses}::TEXT[] IS NULL OR po.status = ANY(${f.statuses}::TEXT[]))
         AND (${f.supplierId}::UUID IS NULL OR po.supplier_id = ${f.supplierId}::UUID)
         AND (${f.fromDate}::DATE IS NULL OR po.order_date >= ${f.fromDate}::DATE)
         AND (${f.toDate}::DATE IS NULL OR po.order_date <= ${f.toDate}::DATE)
         AND (${f.externalSystem}::TEXT IS NULL OR lower(po.external_system) = lower(${f.externalSystem}))
         AND (${f.externalRef}::TEXT IS NULL OR po.external_ref = ${f.externalRef})
    )
    SELECT po.id, po.po_number, po.supplier_id, s.name AS supplier_name, po.order_date, po.expected_delivery_date, po.status,
           po.reference, po.subtotal, po.tax_amount, po.total, po.external_system, po.external_ref, po.external_document_number,
           (SELECT count(*) FROM po_items pi WHERE pi.purchase_order_id = po.id)::INT AS line_count,
           (SELECT count(*) FROM procurement_documents d
             WHERE d.entity_type = 'purchase_order' AND d.entity_id = po.id AND d.is_active = true)::INT AS document_count,
           count(*) OVER ()::INT AS total_rows,
           sum(po.subtotal) OVER () AS sum_subtotal, sum(po.tax_amount) OVER () AS sum_tax, sum(po.total) OVER () AS sum_total
      FROM po
      LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
     ORDER BY po.po_number, po.id
     LIMIT ${page.limit} OFFSET ${page.offset}
  `) as DbRow[];
  if (rows.length === 0 && page.offset > 0) {
    // Past the end: no row carries the window sums. The same query's first row does (one filter, one place).
    const head = await listPurchaseOrdersForMcp(companyId, f, { limit: 1, offset: 0 });
    return { rows: [], total: head.total, totals: head.totals };
  }
  const first = rows[0];
  return {
    rows: rows.map((r) => ({
      id: String(r.id), poNumber: String(r.po_number), supplierId: String(r.supplier_id),
      supplierName: r.supplier_name == null ? null : String(r.supplier_name), orderDate: day(r.order_date)!,
      deliveryDate: day(r.expected_delivery_date), status: String(r.status), reference: r.reference == null ? null : String(r.reference),
      subtotal: Number(r.subtotal), taxAmount: Number(r.tax_amount), total: Number(r.total),
      lineCount: Number(r.line_count), documentCount: Number(r.document_count),
      externalSystem: r.external_system == null ? null : String(r.external_system),
      externalRef: r.external_ref == null ? null : String(r.external_ref),
      externalDocumentNumber: r.external_document_number == null ? null : String(r.external_document_number),
    })),
    total: first ? Number(first.total_rows) : 0,
    totals: {
      subtotal: first ? Number(first.sum_subtotal) : 0, taxAmount: first ? Number(first.sum_tax) : 0, total: first ? Number(first.sum_total) : 0,
    },
  };
}
