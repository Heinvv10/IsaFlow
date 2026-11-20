/**
 * Header billing for committed spend (Hein's ruling on PR #1703, 2026-11-20; isaflow-c8's requirements): a bill that ties a
 * purchase order by its HEADER, not by its lines, nets that PO's committed lines too. Without it a PO billed only through
 * `purchase_order_bill_links` or `supplier_invoices.purchase_order_id` (every bill the retired supplier_purchase_orders ever had,
 * and any canonical bill linked without line links) stayed committed in full while its bill was also actual.
 *
 * One decision per (bill, PO):
 *   - the bill has ANY line naming a line of THAT PO (`po_item_id`): it nets the PO by its lines only (`billedLinesByPoItem`),
 *     never by its header as well;
 *   - else, tied by a link row: it nets the link's `amount` (the bill's ex-VAT share on that PO, migration 1006: a bill split
 *     across POs has one row per PO, each PO nets its own row, never the bill's total);
 *   - else, tied only by `purchase_order_id`: its ex-VAT subtotal less what it already attributes elsewhere (the posted ex-VAT of
 *     its lines that name any PO line, and its link rows to other POs), floored at 0: 1006's amount rule, so one rand never nets
 *     two POs.
 * Same bill statuses as line netting (`BILLED_STATUSES`, or a bill in `own`), and the bill must be the PO's company AND supplier.
 * The amount is spread over ALL the PO's lines by `line_total` share in cents (sort_order, id), the residual on the last line;
 * the core floors each line at 0 (`openPoLineCents`). Basis: `po_items.line_total`, the link amount, the subtotal and the posted
 * line amounts are all ex-VAT. Named limit (the slice): header billing nets at the PO line, not at the bill's own account /
 * centre / month; the posting carries no account or dimensions (null) and the bill's month.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { toCents } from './grid/cents';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from '../ap/supplierInvoiceLineOrder';
import { mapInvoiceRow } from '../ap/supplierInvoiceWorkflowRow';
import type { BilledPosting } from './remainingBudgetCore';
// A cycle with remainingCommitted (it imports this module): only function declarations cross it, read at call time.
import { postedExpenseLines } from './remainingCommitted';

/** One header tie that nets: a bill, a PO, the ex-VAT cents it nets there, the bill's month. */
export interface HeaderTie { billId: string; poId: string; cents: number; month: string }

const lower = (v: unknown): string => String(v).toLowerCase();

/**
 * The header ties of these POs that net committed (see the module note), each with its amount in cents.
 * `billedStatuses` is passed in (remainingCommitted's BILLED_STATUSES) so this module does not import its caller.
 */
export async function headerTies(
  companyId: string, poIds: readonly string[], own: readonly string[], billedStatuses: readonly string[],
): Promise<HeaderTie[]> {
  if (poIds.length === 0) return [];
  const rows = (await sql`
    WITH cand AS (
      SELECT l.supplier_invoice_id AS bill, l.purchase_order_id AS po FROM purchase_order_bill_links l
       WHERE l.company_id = ${companyId}::UUID AND l.purchase_order_id = ANY(${[...poIds]}::UUID[])
      UNION
      SELECT si.id, si.purchase_order_id FROM supplier_invoices si
       WHERE si.company_id = ${companyId}::UUID AND si.purchase_order_id = ANY(${[...poIds]}::UUID[])
    )
    SELECT c.bill::TEXT AS bill, c.po::TEXT AS po, l.amount::TEXT AS link_amount,
           (SELECT COALESCE(SUM(o.amount), 0) FROM purchase_order_bill_links o
             WHERE o.company_id = ${companyId}::UUID AND o.supplier_invoice_id = c.bill AND o.purchase_order_id <> c.po)::TEXT AS other_links,
           si.*
      FROM cand c
      JOIN supplier_invoices si ON si.id = c.bill AND si.company_id = ${companyId}::UUID
      JOIN purchase_orders po ON po.id = c.po AND po.company_id = ${companyId}::UUID AND po.supplier_id = si.supplier_id
      LEFT JOIN purchase_order_bill_links l
        ON l.company_id = ${companyId}::UUID AND l.purchase_order_id = c.po AND l.supplier_invoice_id = c.bill
     WHERE (si.status = ANY(${[...billedStatuses]}::TEXT[]) OR si.id = ANY(${[...own]}::UUID[]))
       AND NOT EXISTS (SELECT 1 FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id
                        WHERE x.supplier_invoice_id = c.bill AND pi.purchase_order_id = c.po)
  `) as DbRow[];
  if (rows.length === 0) return [];
  const headerOnly = rows.filter((r) => r.link_amount == null);
  const attributed = new Map<string, number>();
  if (headerOnly.length > 0) {
    const bills = [...new Set(headerOnly.map((r) => String(r.bill)))];
    const items = (await sql`
      SELECT sii.* FROM supplier_invoice_items sii WHERE sii.supplier_invoice_id = ANY(${bills}::UUID[])
      ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
    `) as DbRow[];
    for (const r of headerOnly) {
      const id = String(r.bill);
      if (attributed.has(id)) continue;
      const own_ = items.filter((i) => String(i.supplier_invoice_id) === id);
      const named = new Set(own_.filter((i) => i.po_item_id != null).map((i) => String(i.id)));
      attributed.set(id, postedExpenseLines(r, own_).filter((l) => named.has(String(l.description))).reduce((s, l) => s + toCents(l.debit), 0));
    }
  }
  return rows.map((r) => {
    const cents = r.link_amount != null
      ? toCents(Number(r.link_amount))
      : Math.max(0, toCents(Number(r.subtotal ?? 0)) - (attributed.get(String(r.bill)) ?? 0) - toCents(Number(r.other_links)));
    return { billId: lower(r.bill), poId: lower(r.po), cents, month: fmtDate(mapInvoiceRow(r).invoiceDate).slice(0, 7) };
  }).filter((t) => t.cents > 0);
}

/** `cents` over the lines by their share (BigInt: no float error), the residual on the last; lines summing to <= 0 take nothing. */
export function spreadCents(cents: number, lineCents: readonly number[]): number[] {
  const total = lineCents.reduce((s, c) => s + c, 0);
  if (lineCents.length === 0 || total <= 0) return lineCents.map(() => 0);
  const shares = lineCents.map((c) => Number((BigInt(cents) * BigInt(Math.max(0, c))) / BigInt(total)));
  shares[shares.length - 1] = cents - shares.slice(0, -1).reduce((s, c) => s + c, 0);
  return shares;
}

/** Header billing per PO line (lower-case ids) for the POs these lines belong to, as postings the core sums with line billing. */
export async function headerBilledByPoItem(
  companyId: string, poItemIds: readonly string[], own: readonly string[], billedStatuses: readonly string[],
): Promise<Map<string, BilledPosting[]>> {
  const out = new Map<string, BilledPosting[]>();
  if (poItemIds.length === 0) return out;
  const lines = (await sql`
    SELECT pi.id::TEXT AS id, pi.purchase_order_id::TEXT AS po, pi.line_total::TEXT AS line_total
      FROM po_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE pi.purchase_order_id IN (SELECT x.purchase_order_id FROM po_items x WHERE x.id = ANY(${[...poItemIds]}::UUID[]))
     ORDER BY pi.purchase_order_id, pi.sort_order, pi.id
  `) as DbRow[];
  const byPo = new Map<string, DbRow[]>();
  for (const l of lines) byPo.set(lower(l.po), [...(byPo.get(lower(l.po)) ?? []), l]);
  const wanted = new Set(poItemIds.map(lower));
  for (const tie of await headerTies(companyId, [...byPo.keys()], own, billedStatuses)) {
    const poLines = byPo.get(tie.poId) ?? [];
    const shares = spreadCents(tie.cents, poLines.map((l) => toCents(Number(l.line_total))));
    poLines.forEach((l, i) => {
      const id = lower(l.id);
      if (!wanted.has(id) || shares[i] === 0) return;
      out.set(id, [...(out.get(id) ?? []), { glAccountId: null, cc1Id: null, cc2Id: null, buId: null, month: tie.month, amount: shares[i]! / 100 }]);
    });
  }
  return out;
}
