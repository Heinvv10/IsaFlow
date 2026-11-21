/**
 * get_purchase_order: one PO with its lines (ordered / received / billed quantity and amount, outstanding), the bills
 * linked to it, its goods received notes and filed documents, the billed total and `fully_billed` (billed >= subtotal -
 * 1 c; design decision 6). Reads only; company-scoped. Each list is capped (`DETAIL_CAPS`; `grnItems` is per goods received note, each reporting `items_total` and `items_truncated`) with its total beside it, so
 * the reply fits a client's result limit.
 */
import { readPoTies } from './purchaseOrderTies';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { toCents } from '../budgets/grid/cents';
import { BILLED_STATUSES, poBillingBasisCents } from '../budgets/remainingCommitted';
import { billTies } from '../budgets/billAttribution';
import { billedByPoItem, billedCentsByPo } from './purchaseOrderBilled';
import { isFullyBilled } from './purchaseOrderBillLinkTypes';
import { isClosedUnderBilled } from './purchaseOrderBillingClose';

/** Caps and text limits sized so the widest reply (`poBillLinkTools.test.ts`) stays under MAX_READ_RESULT_BYTES. Lines page by offset. */
export const DETAIL_CAPS = { lines: 40, bills: 30, grns: 15, grnItems: 5, documents: 15 } as const;
const TEXT_CAP = 150;

type Obj = Record<string, unknown>;

const day = (v: unknown): string | null => (v == null || v === '' ? null : fmtDate(v));
const text = (v: unknown): string | null => (v == null ? null : String(v));
const short = (v: unknown): string | null => (v == null ? null : String(v).slice(0, TEXT_CAP));
const rand = (cents: number) => cents / 100;

export interface PurchaseOrderDetail {
  purchase_order: Obj;
  lines: Obj[];
  lines_total: number;
  /** The offset of the next page of lines, null on the last. */
  next_offset: number | null;
  bills: Obj[];
  bills_total: number;
  goods_received_notes: Obj[];
  goods_received_notes_total: number;
  documents: Obj[];
  documents_total: number;
  billed_total: number;
  outstanding_to_bill: number;
  fully_billed: boolean;
  /** Closed BY BILLING (a link call's close_when_fully_billed, or 1022) and billed is now below the subtotal less 1 c: `purchaseOrderBillingClose.isClosedUnderBilled`. */
  closed_under_billed: boolean;
}

export async function readPurchaseOrderDetail(
  companyId: string, key: { poId: string | null; poNumber: string | null }, linesOffset = 0,
): Promise<PurchaseOrderDetail | null> {
  const head = ((await sql`
    SELECT po.*, s.name AS supplier_name FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.company_id = po.company_id
     WHERE po.company_id = ${companyId}::UUID AND (po.id = ${key.poId}::UUID OR po.po_number = ${key.poNumber}::TEXT)
  `) as DbRow[])[0];
  if (!head) return null;
  const poId = String(head.id);
  const lineRows = (await sql`
    SELECT pi.id, pi.description, pi.quantity, pi.unit_price, pi.tax_rate, pi.line_total, pi.tax_amount, pi.quantity_received,
           pi.gl_account_id, pi.sort_order, count(*) OVER ()::INT AS total_rows
      FROM po_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE pi.purchase_order_id = ${poId}::UUID
     ORDER BY pi.sort_order, pi.id LIMIT ${DETAIL_CAPS.lines} OFFSET ${linesOffset}
  `) as DbRow[];
  const billed = await billedByPoItem(companyId, lineRows.map((r) => String(r.id)));
  const lines = lineRows.map((r) => {
    const b = billed.get(String(r.id).toLowerCase()) ?? { qty: 0, amountCents: 0 };
    const qty = Number(r.quantity);
    const received = Number(r.quantity_received ?? 0);
    const totalCents = toCents(Number(r.line_total));
    return {
      id: String(r.id), description: short(r.description), quantity_ordered: qty, quantity_received: received, quantity_billed: b.qty,
      unit_price: Number(r.unit_price), tax_rate: text(r.tax_rate) === null ? null : Number(r.tax_rate),
      line_total: rand(totalCents), tax_amount: Number(r.tax_amount ?? 0), amount_billed: rand(b.amountCents),
      outstanding_quantity_to_receive: Math.max(0, qty - received), outstanding_quantity_to_bill: Math.max(0, qty - b.qty),
      outstanding_amount_to_bill: rand(Math.max(0, totalCents - b.amountCents)), gl_account_id: text(r.gl_account_id),
    };
  });

  // Every bill that ties the PO, one row each, with its tie kind (link | line | header): the same list the maintenance tools' refusals name.
  const ties = await readPoTies(companyId, poId, DETAIL_CAPS.bills);
  const billRows = ties.rows;
  const grnRows = (await sql`
    SELECT g.id, g.grn_number, g.received_date, g.status, g.received_by, count(*) OVER ()::INT AS total_rows
      FROM goods_received_notes g WHERE g.company_id = ${companyId}::UUID AND g.purchase_order_id = ${poId}::UUID
     ORDER BY g.received_date, g.grn_number, g.id LIMIT ${DETAIL_CAPS.grns}
  `) as DbRow[];
  const grnItems = (await sql`
    SELECT x.grn_id, x.po_item_id, x.quantity_received, x.quantity_rejected, x.n FROM (
      SELECT gi.grn_id, gi.po_item_id, gi.quantity_received, gi.quantity_rejected,
             row_number() OVER (PARTITION BY gi.grn_id ORDER BY gi.po_item_id, gi.id) AS rn,
             count(*) OVER (PARTITION BY gi.grn_id)::INT AS n
        FROM grn_items gi JOIN goods_received_notes g ON g.id = gi.grn_id AND g.company_id = ${companyId}::UUID
       WHERE gi.grn_id = ANY(${grnRows.map((g) => String(g.id))}::UUID[])
    ) x WHERE x.rn <= ${DETAIL_CAPS.grnItems} ORDER BY x.grn_id, x.po_item_id
  `) as DbRow[];
  const docs = (await sql`
    SELECT d.id, d.document_name, d.document_type, d.mime_type, d.file_size, d.uploaded_at, count(*) OVER ()::INT AS total_rows
      FROM procurement_documents d JOIN purchase_orders po ON po.id = d.entity_id AND po.company_id = ${companyId}::UUID
     WHERE d.entity_type = 'purchase_order' AND d.entity_id = ${poId}::UUID AND d.is_active = true
     ORDER BY d.uploaded_at, d.id LIMIT ${DETAIL_CAPS.documents}
  `) as DbRow[];

  const billedCents = (await billedCentsByPo(companyId, [poId])).get(poId.toLowerCase()) ?? 0;
  // What each tying bill holds on this PO by the one attribution billed_total sums (review r3 L4); linked_amount stays the row's
  // stored amount, which a link written before the lines check can disagree with.
  const attributed = new Map((await billTies(companyId, [poId], { statuses: null })).map((t) => [t.billId, t.cents]));
  // Fully billed / outstanding against max(header subtotal, lines' total), as 1022 closes on (review r7 M2).
  const subtotalCents = (await poBillingBasisCents(companyId, [poId])).get(poId.toLowerCase()) ?? toCents(Number(head.subtotal ?? 0));
  const counted = (s: unknown) => (BILLED_STATUSES as readonly string[]).includes(String(s));
  return {
    purchase_order: {
      id: poId, po_number: String(head.po_number), supplier_id: String(head.supplier_id), supplier_name: short(head.supplier_name),
      status: String(head.status), order_date: day(head.order_date), delivery_date: day(head.expected_delivery_date),
      reference: short(head.reference), notes: text(head.notes)?.slice(0, 500) ?? null, subtotal: Number(head.subtotal ?? 0), tax_amount: Number(head.tax_amount ?? 0),
      total: Number(head.total ?? 0), external_system: short(head.external_system), external_ref: short(head.external_ref),
      external_document_number: short(head.external_document_number),
      /** The status a short close / set status closed it from (migration 1007); null when it is not closed that way. */
      closed_from_status: head.closed_from_status == null ? null : String(head.closed_from_status),
    },
    lines, lines_total: lineRows[0] ? Number(lineRows[0].total_rows) : 0,
    next_offset: lineRows.length > 0 && linesOffset + lineRows.length < Number(lineRows[0]!.total_rows) ? linesOffset + lineRows.length : null,
    bills: billRows.map((r) => ({
      tie: String(r.tie), deleted: r.deleted === true, link_id: r.link_id == null ? null : String(r.link_id), bill_id: String(r.bill_id), invoice_number: String(r.invoice_number), status: String(r.status),
      invoice_date: day(r.invoice_date), subtotal: Number(r.subtotal), total_amount: Number(r.total_amount), linked_amount: r.amount == null ? 0 : Number(r.amount),
      // The bill's attribution whether or not it counts (review r4 L5); see counts_as_billed.
      attributed_amount: rand(attributed.get(String(r.bill_id).toLowerCase()) ?? 0),
      counts_as_billed: counted(r.status) && r.deleted !== true, source: r.source == null ? null : String(r.source), external_system: short(r.external_system), external_ref: short(r.external_ref),
    })),
    bills_total: ties.total,
    goods_received_notes: grnRows.map((g) => ({
      id: String(g.id), grn_number: String(g.grn_number), received_date: day(g.received_date), status: String(g.status), received_by: short(g.received_by),
      items: grnItems.filter((i) => String(i.grn_id) === String(g.id)).map((i) => ({
        po_item_id: String(i.po_item_id), quantity_received: Number(i.quantity_received), quantity_rejected: Number(i.quantity_rejected ?? 0),
      })),
      items_total: Number(grnItems.find((i) => String(i.grn_id) === String(g.id))?.n ?? 0),
      items_truncated: Number(grnItems.find((i) => String(i.grn_id) === String(g.id))?.n ?? 0) > DETAIL_CAPS.grnItems,
    })),
    goods_received_notes_total: grnRows[0] ? Number(grnRows[0].total_rows) : 0,
    documents: docs.map((d) => ({
      id: String(d.id), name: short(d.document_name), document_type: text(d.document_type), mime_type: text(d.mime_type),
      size: d.file_size == null ? null : Number(d.file_size), uploaded_at: d.uploaded_at == null ? null : new Date(d.uploaded_at as string).toISOString(),
    })),
    documents_total: docs[0] ? Number(docs[0].total_rows) : 0,
    billed_total: rand(billedCents),
    outstanding_to_bill: rand(Math.max(0, subtotalCents - billedCents)),
    fully_billed: isFullyBilled(billedCents, subtotalCents),
    closed_under_billed: isClosedUnderBilled({ status: String(head.status), closedByBilling: head.closed_by_billing === true, subtotalCents }, billedCents),
  };
}
