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
 *   - else, tied only by `purchase_order_id`: its ex-VAT subtotal less what it already attributes to EACH other PO, floored at 0:
 *     per other PO the larger of the posted ex-VAT of its lines naming that PO and its link row's amount there (a link written
 *     from those very lines holds the same rand, so the two are never both subtracted; review M2), so one rand never nets two POs.
 * Same bill statuses as line netting (`BILLED_STATUSES`, or a bill in `own`), and the bill must be the PO's company AND supplier
 * and not soft-deleted. (Line netting still counts a soft-deleted approved bill, a pre-existing behaviour flagged to Hein: its
 * journal is reversed out of actuals, so netting committed by it would understate; header netting does not copy that.)
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
import { postedExpenseLines } from './postedExpenseLines';

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
    SELECT c.bill::TEXT AS bill, c.po::TEXT AS po, l.amount::TEXT AS link_amount, si.*
      FROM cand c
      JOIN supplier_invoices si ON si.id = c.bill AND si.company_id = ${companyId}::UUID
      JOIN purchase_orders po ON po.id = c.po AND po.company_id = ${companyId}::UUID AND po.supplier_id = si.supplier_id
      LEFT JOIN purchase_order_bill_links l
        ON l.company_id = ${companyId}::UUID AND l.purchase_order_id = c.po AND l.supplier_invoice_id = c.bill
     WHERE (si.status = ANY(${[...billedStatuses]}::TEXT[]) OR si.id = ANY(${[...own]}::UUID[]))
       AND si.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id
                        WHERE x.supplier_invoice_id = c.bill AND pi.purchase_order_id = c.po)
  `) as DbRow[];
  if (rows.length === 0) return [];
  const headerOnly = rows.filter((r) => r.link_amount == null);
  // Per header-only bill: cents it attributes to each OTHER PO (by its lines, and by its link rows; the larger per PO).
  const elsewhere = new Map<string, Map<string, number>>();
  if (headerOnly.length > 0) {
    const bills = [...new Set(headerOnly.map((r) => String(r.bill)))];
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
    for (const r of headerOnly) {
      const id = String(r.bill);
      if (elsewhere.has(id)) continue;
      const own_ = items.filter((i) => String(i.supplier_invoice_id) === id);
      const poOfLine = new Map(own_.filter((i) => i.named_po != null).map((i) => [String(i.id), lower(i.named_po)]));
      const lineCents = new Map<string, number>();
      for (const l of postedExpenseLines(r, own_)) {
        const po = poOfLine.get(String(l.description));
        if (po) lineCents.set(po, (lineCents.get(po) ?? 0) + toCents(l.debit));
      }
      const per = new Map(lineCents);
      for (const k of links.filter((x) => String(x.bill) === id)) {
        const po = lower(k.po);
        per.set(po, Math.max(per.get(po) ?? 0, toCents(Number(k.amount))));
      }
      elsewhere.set(id, per);
    }
  }
  return rows.map((r) => {
    const po = lower(r.po);
    const others = [...(elsewhere.get(String(r.bill)) ?? new Map<string, number>()).entries()]
      .filter(([p]) => p !== po).reduce((s, [, c]) => s + c, 0);
    const cents = r.link_amount != null ? toCents(Number(r.link_amount)) : Math.max(0, toCents(Number(r.subtotal ?? 0)) - others);
    return { billId: lower(r.bill), poId: po, cents, month: fmtDate(mapInvoiceRow(r).invoiceDate).slice(0, 7) };
  }).filter((t) => t.cents > 0);
}

/**
 * `cents` over the lines by their share of the POSITIVE line totals (BigInt: no float error), the residual on the last line with a
 * positive total; a zero or negative line takes nothing, and nothing is spread when no line is positive.
 */
export function spreadCents(cents: number, lineCents: readonly number[]): number[] {
  const pos = lineCents.map((c) => Math.max(0, c));
  const total = pos.reduce((s, c) => s + c, 0);
  if (total <= 0) return lineCents.map(() => 0);
  const shares = pos.map((c) => Number((BigInt(cents) * BigInt(c)) / BigInt(total)));
  const last = pos.reduce((at, c, i) => (c > 0 ? i : at), -1);
  shares[last] = cents - shares.reduce((s, c, i) => (i === last ? s : s + c), 0);
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
