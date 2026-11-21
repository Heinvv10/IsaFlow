/**
 * Committed spend for remaining budget (budgets P5 spec §3a, decision 8a): open PO lines less what
 * bills linked to them have already billed, per PO line, floored at 0 by the core.
 *
 * - PO lines: POs with status approved / partially_received / received, in their order-date month,
 *   with an account among the keys' (a line with no account cannot meet a budget). `line_total`
 *   is qty × unit price, ex-VAT, on both PO writers (census T1.5).
 * - Billed (`committedBillingByPoItem`): line billing below, plus HEADER billing (`remainingHeaderBilled`, PR #1703): a bill
 *   tied to the PO only by its header (a `purchase_order_bill_links` row, else `purchase_order_id`), with no line naming a line
 *   of that PO, nets the link's amount (else its subtotal less what it attributes elsewhere) spread pro rata over the PO's
 *   lines. One decision per (bill, PO): lines first. Named limit: header billing nets at the PO LINE, not at the bill's own
 *   slice (account / centre / month), the same "wherever it posted" rule as line billing (decision 8a).
 * - Line billing: for every bill line linked by `po_item_id`, on a bill that is approved / paid /
 *   partially_paid (or is `excludeInvoiceId`, the bill being checked), the ex-VAT amount APPROVE
 *   POSTS for that line: the bill's lines go through `ap/supplierInvoiceExpenseLines.buildExpenseLines`
 *   in the approve path's line order (`SUPPLIER_INVOICE_LINE_ORDER_BY`). A bill whose lines are
 *   stored gross (Σ line_total ≈ total_amount) is scaled to its subtotal, the last line takes the
 *   rounding residual, and a sub-cent overshoot or a R0 line is folded/dropped there exactly as
 *   posted (census finding 3). Never the stored `line_total`, never `quantity_invoiced`. All of a PO
 *   line's linked billing releases it, wherever it posted (decision 8a; the core's `openPoLineCents`).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from '../ap/supplierInvoiceLineOrder';
import { mapInvoiceRow } from '../ap/supplierInvoiceWorkflowRow';
import { fmtDate } from '@/lib/fmtDate';
import type { BilledPosting, CommitmentRow } from './remainingBudgetCore';
import { headerBilledByPoItem } from './remainingHeaderBilled';
import { billTies } from './billAttribution';
import { BILLED_STATUSES, COMMITTING_PO_STATUSES, isFullyBilled } from './poCommitStatus';
import { NO_ACCOUNT, postedExpenseLines } from './postedExpenseLines';
import { toCents } from './grid/cents';

export { BILLED_STATUSES, COMMITTING_PO_STATUSES, commitsSpend } from './poCommitStatus';

/**
 * Review r6 M5: of these POs closed by billing, the ones fully billed at PO level (the one attribution, as billedCentsByPo counts
 * it): they commit 0, even beside a line over-billed by its lines (R4-5); one that is not commits its per-line open remainder.
 */
export async function fullyBilledClosedPos(companyId: string, pos: ReadonlyArray<{ id: string; subtotalCents: number }>): Promise<Set<string>> {
  if (pos.length === 0) return new Set();
  const billed = new Map<string, number>();
  for (const t of await billTies(companyId, pos.map((p) => p.id), { statuses: BILLED_STATUSES })) {
    if (!t.deleted) billed.set(t.poId, (billed.get(t.poId) ?? 0) + t.cents);
  }
  return new Set(pos.filter((p) => isFullyBilled(billed.get(p.id.toLowerCase()) ?? 0, p.subtotalCents)).map((p) => p.id.toLowerCase()));
}

export interface CommittedOptions {
  excludePoItemIds?: readonly string[];
  excludeInvoiceId?: string | null;
  /**
   * More bills whose PO-linked lines count as billed whatever their status: the earlier bills of a batch
   * preview, as if already approved (P5-2 MCP bulk dry run), so a PO line shared by bills, or on another
   * account than a bill's own lines, is netted once and where it lives.
   */
  alsoBilledInvoiceIds?: readonly string[];
}

const text = (v: unknown): string | null => (v == null ? null : String(v).toLowerCase());

// The posted-lines reading lives in its own module (shared with remainingHeaderBilled, no import cycle); re-exported here for
// the callers that already import it from this module.
export { postedExpenseLines } from './postedExpenseLines';

/**
 * The posted ex-VAT lines of the bills that count as billed (`BILLED_STATUSES`, plus `own`), per linked PO line
 * (lower-case ids): account and CC1 / CC2 / BU as `buildExpenseLines` posts them, the bill's month. Committed
 * (`readCommitments`) and the PO approval (`ap/purchaseOrderBudget`) both net a PO line by all of them
 * (`remainingBudgetCore.openPoLineCents`).
 */
// A soft-deleted bill nets nothing: its journal is reversed out of actuals (PR #1703 R4-2 ruling; billed excludes it too).
export async function billedLinesByPoItem(companyId: string, poItemIds: string[], own: string[]): Promise<Map<string, BilledPosting[]>> {
  const out = new Map<string, BilledPosting[]>();
  if (poItemIds.length === 0) return out;
  const bills = (await sql`
    SELECT si.* FROM supplier_invoices si
     WHERE si.company_id = ${companyId}::UUID
       AND (si.status = ANY(${[...BILLED_STATUSES]}::TEXT[]) OR si.id = ANY(${own}::UUID[]))
       AND si.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM supplier_invoice_items x WHERE x.supplier_invoice_id = si.id AND x.po_item_id = ANY(${poItemIds}::UUID[]))
  `) as DbRow[];
  if (bills.length === 0) return out;
  const items = (await sql`
    SELECT sii.*, pi.purchase_order_id::TEXT AS item_po FROM supplier_invoice_items sii
      LEFT JOIN po_items pi ON pi.id = sii.po_item_id
     WHERE sii.supplier_invoice_id = ANY(${bills.map((b) => String(b.id))}::UUID[])
    ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
  `) as DbRow[];
  const linked = new Set(poItemIds);
  for (const b of bills) {
    const billItems = items.filter((i) => String(i.supplier_invoice_id) === String(b.id));
    const poOf = new Map(billItems.map((i) => [String(i.id), text(i.po_item_id)]));
    const orderOf = new Map(billItems.map((i) => [text(i.po_item_id), text(i.item_po)]));
    const month = fmtDate(mapInvoiceRow(b).invoiceDate).slice(0, 7);
    const mine = new Map<string, BilledPosting[]>();
    for (const line of postedExpenseLines(b, billItems)) {
      const po = poOf.get(String(line.description));
      if (!po || !linked.has(po)) continue;
      mine.set(po, [...(mine.get(po) ?? []), {
        glAccountId: line.glAccountId === NO_ACCOUNT ? null : text(line.glAccountId), cc1Id: text(line.cc1Id), cc2Id: text(line.cc2Id),
        buId: text(line.buId), month, amount: line.debit,
      }]);
    }
    // A bill never nets a PO below nothing, the billAttribution floor (breaker r5 / r6 A2): a bill whose postings to one PO's
    // lines sum below 0 across that PO (a discount line naming one) nets none of them; one that nets 0 or more keeps every posting,
    // a negative line included (+500 on A and -500 on B of one PO stay, so a header bill still nets that PO exactly).
    const net = new Map<string, number>();
    for (const [item, postings] of mine) {
      const order = orderOf.get(item) ?? item;
      net.set(order, (net.get(order) ?? 0) + postings.reduce((sum, p) => sum + toCents(p.amount), 0));
    }
    for (const [item, postings] of mine) {
      if ((net.get(orderOf.get(item) ?? item) ?? 0) < 0) continue;
      out.set(item, [...(out.get(item) ?? []), ...postings]);
    }
  }
  return out;
}

/**
 * Everything that nets these PO lines' committed spend (lower-case ids): their line billing (`billedLinesByPoItem`) and the
 * header billing of their POs (`remainingHeaderBilled`). Committed (`readCommitments`) and the PO approval
 * (`ap/purchaseOrderBudget`) both use this one figure.
 */
export async function committedBillingByPoItem(companyId: string, poItemIds: string[], own: string[]): Promise<Map<string, BilledPosting[]>> {
  const out = await billedLinesByPoItem(companyId, poItemIds, own);
  for (const [id, postings] of await headerBilledByPoItem(companyId, poItemIds, own, BILLED_STATUSES, (ids) => billedLinesByPoItem(companyId, ids, own))) {
    out.set(id, [...(out.get(id) ?? []), ...postings]);
  }
  return out;
}

export async function readCommitments(
  companyId: string, accounts: string[], start: string, end: string, opts: CommittedOptions,
): Promise<CommitmentRow[]> {
  const exclude = (opts.excludePoItemIds ?? []).map((id) => id.toLowerCase());
  const all = (await sql`
    SELECT pi.id::TEXT AS po_item_id, pi.gl_account_id::TEXT AS gl_account_id, to_char(po.order_date, 'YYYY-MM') AS month,
           pi.cc1_id::TEXT AS cc1_id, pi.cc2_id::TEXT AS cc2_id, pi.bu_id::TEXT AS bu_id, pi.line_total::TEXT AS line_total,
           po.id::TEXT AS po_id, po.status = 'closed' AS closed, po.subtotal::TEXT AS subtotal
      FROM po_items pi
      JOIN purchase_orders po ON po.id = pi.purchase_order_id
     WHERE po.company_id = ${companyId}::UUID
       AND (po.status = ANY(${[...COMMITTING_PO_STATUSES]}::TEXT[]) OR (po.status = 'closed' AND po.closed_by_billing))
       AND pi.gl_account_id = ANY(${accounts}::UUID[])
       AND po.order_date >= ${start}::DATE AND po.order_date <= ${end}::DATE
       AND NOT (pi.id = ANY(${exclude}::UUID[]))
  `) as DbRow[];
  const closed = [...new Map(all.filter((r) => r.closed === true).map((r) => [String(r.po_id), { id: String(r.po_id), subtotalCents: toCents(Number(r.subtotal ?? 0)) }])).values()];
  const settled = await fullyBilledClosedPos(companyId, closed);
  const rows = all.filter((r) => !settled.has(String(r.po_id).toLowerCase()));
  const own = [opts.excludeInvoiceId, ...(opts.alsoBilledInvoiceIds ?? [])].filter((v): v is string => !!v).map((v) => v.toLowerCase());
  const billed = await committedBillingByPoItem(companyId, rows.map((r) => String(text(r.po_item_id))), own);
  return rows.map((r) => {
    const id = String(text(r.po_item_id));
    return {
      poItemId: id, glAccountId: String(text(r.gl_account_id)), month: String(r.month),
      cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id),
      lineTotal: Number(r.line_total), billed: billed.get(id) ?? [],
    };
  });
}
