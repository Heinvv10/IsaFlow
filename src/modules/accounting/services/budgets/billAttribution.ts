/**
 * How much of a bill each purchase order it ties holds: the ONE attribution committed netting (`remainingHeaderBilled`), billed
 * (`ap/purchaseOrderBilled`: fully_billed, the close and reopen rules) and the unlink read (PR #1703: review M2, ledger breaker
 * BRK-A/B/C/E, isaflow-c8). One rand of a bill is attributed to at most one PO. Per (bill, PO), decided once:
 *   - `lines`: the bill has a line naming a line of that PO: the posted ex-VAT of those lines (`postedExpenseLines`), floored at 0
 *     once, where the per-PO sum is built (a negative line, a discount naming a PO line, never makes a PO hold less than nothing;
 *     review r3 L2 / r4 L4; the other-PO sum below reads the same floored figure), whatever a link row of the pair says (a stored amount written beside lines before the link tool
 *     checked it is ignored, c8);
 *   - `link`: else a `purchase_order_bill_links` row: its amount;
 *   - `header`: else only `purchase_order_id`: the subtotal less what the bill attributes to every OTHER PO it ties, by the same
 *     rule (lines when its lines name that PO, counted only when positive; else that PO's link amount), kept between 0 and the
 *     subtotal.
 * Named limit (breaker R3-2): a lines tie can hold more than the bill's subtotal when the bill's OTHER lines are negative (an R1200
 * line naming a PO beside an unnamed R-400 discount line, subtotal R800). That is line netting "wherever it posted": the PO line's
 * account really posted R1200. The header fallback of the same bill then holds 0, never less.
 * Named limit (breaker R4-5): attribution is per (bill, PO), not per PO line. A line over-billed by its lines (A R500 billed R800)
 * counts in full towards the PO's billed, so fully_billed can be true while committed (per line, each capped at its own total) still
 * holds the PO's other lines: A 500 billed 800 by lines plus a R200 header bill is fully billed and B still commits R300.
 * A link or header tie needs the PO's supplier; a lines tie does not (line netting never asked; `assertBillPoLinks` checks it
 * when the line is written). All ex-VAT cents.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { toCents } from './grid/cents';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from '../ap/supplierInvoiceLineOrder';
import { mapInvoiceRow } from '../ap/supplierInvoiceWorkflowRow';
import { postedExpenseLines } from './postedExpenseLines';

export interface BillTie {
  billId: string;
  poId: string;
  via: 'lines' | 'link' | 'header';
  cents: number;
  /** 'YYYY-MM' of the bill's invoice date. */
  month: string;
  status: string;
  deleted: boolean;
}

const lower = (v: unknown): string => String(v).toLowerCase();

/**
 * Every bill tie of these POs, with its attributed cents. `statuses` null: any bill status; else bills in it, or in `own`.
 */
export async function billTies(
  companyId: string, poIds: readonly string[], opts: { statuses: readonly string[] | null; own?: readonly string[] },
): Promise<BillTie[]> {
  if (poIds.length === 0) return [];
  const any = opts.statuses === null;
  const rows = (await sql`
    WITH cand AS (
      SELECT l.supplier_invoice_id AS bill, l.purchase_order_id AS po FROM purchase_order_bill_links l
       WHERE l.company_id = ${companyId}::UUID AND l.purchase_order_id = ANY(${[...poIds]}::UUID[])
      UNION
      SELECT si.id, si.purchase_order_id FROM supplier_invoices si
       WHERE si.company_id = ${companyId}::UUID AND si.purchase_order_id = ANY(${[...poIds]}::UUID[])
      UNION
      SELECT x.supplier_invoice_id, pi.purchase_order_id FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id
       WHERE pi.purchase_order_id = ANY(${[...poIds]}::UUID[])
    )
    SELECT c.bill::TEXT AS bill, c.po::TEXT AS po, l.amount::TEXT AS link_amount, (po.supplier_id = si.supplier_id) AS same_supplier,
           EXISTS (SELECT 1 FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id
                    WHERE x.supplier_invoice_id = c.bill AND pi.purchase_order_id = c.po) AS by_lines,
           si.*
      FROM cand c
      JOIN supplier_invoices si ON si.id = c.bill AND si.company_id = ${companyId}::UUID
      JOIN purchase_orders po ON po.id = c.po AND po.company_id = ${companyId}::UUID
      LEFT JOIN purchase_order_bill_links l
        ON l.company_id = ${companyId}::UUID AND l.purchase_order_id = c.po AND l.supplier_invoice_id = c.bill
     WHERE (${any}::BOOLEAN OR si.status = ANY(${[...(opts.statuses ?? [])]}::TEXT[]) OR si.id = ANY(${[...(opts.own ?? [])]}::UUID[]))
  `) as DbRow[];
  const kept = rows.filter((r) => r.by_lines === true || r.same_supplier === true);
  if (kept.length === 0) return [];
  const bills = [...new Set(kept.map((r) => String(r.bill)))];
  const items = (await sql`
    SELECT sii.*, pi.purchase_order_id::TEXT AS named_po FROM supplier_invoice_items sii
      LEFT JOIN po_items pi ON pi.id = sii.po_item_id
     WHERE sii.supplier_invoice_id = ANY(${bills}::UUID[])
    ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
  `) as DbRow[];
  const links = (await sql`
    SELECT supplier_invoice_id::TEXT AS bill, purchase_order_id::TEXT AS po, amount::TEXT AS amount FROM purchase_order_bill_links
     WHERE company_id = ${companyId}::UUID AND supplier_invoice_id = ANY(${bills}::UUID[])
  `) as DbRow[];

  // Per bill: the POs its lines name, the posted cents of those lines per PO, and its link amount per PO.
  const facts = new Map<string, { named: Set<string>; posted: Map<string, number>; linked: Map<string, number> }>();
  for (const id of bills) {
    const row = kept.find((r) => String(r.bill) === id)!;
    const own = items.filter((i) => String(i.supplier_invoice_id) === id);
    const poOfLine = new Map(own.filter((i) => i.named_po != null).map((i) => [String(i.id), lower(i.named_po)]));
    const posted = new Map<string, number>();
    for (const l of postedExpenseLines(row, own)) {
      const po = poOfLine.get(String(l.description));
      if (po) posted.set(po, (posted.get(po) ?? 0) + toCents(l.debit));
    }
    // The one clamp (review r3 L2 / r4 L4): what a bill's lines hold on a PO is floored at 0 here, where it is built.
    for (const [po, c] of posted) posted.set(po, Math.max(0, c));
    const linked = new Map(links.filter((k) => String(k.bill) === id).map((k) => [lower(k.po), toCents(Number(k.amount))]));
    facts.set(id, { named: new Set(poOfLine.values()), posted, linked });
  }
  const held = (f: { named: Set<string>; posted: Map<string, number>; linked: Map<string, number> }, po: string) =>
    (f.named.has(po) ? (f.posted.get(po) ?? 0) : (f.linked.get(po) ?? 0));

  return kept.map((r) => {
    const f = facts.get(String(r.bill))!;
    const po = lower(r.po);
    let via: BillTie['via'];
    let cents: number;
    if (r.by_lines === true) { via = 'lines'; cents = f.posted.get(po) ?? 0; } else if (r.link_amount != null) {
      via = 'link'; cents = toCents(Number(r.link_amount));
    } else {
      via = 'header';
      const subtotal = toCents(Number(r.subtotal ?? 0));
      const others = [...new Set([...f.named, ...f.linked.keys()])].filter((p) => p !== po).reduce((s, p) => s + held(f, p), 0);
      cents = Math.min(subtotal, Math.max(0, subtotal - others));
    }
    return {
      billId: lower(r.bill), poId: po, via, cents, month: fmtDate(mapInvoiceRow(r).invoiceDate).slice(0, 7),
      status: String(r.status), deleted: r.deleted_at != null,
    };
  });
}
