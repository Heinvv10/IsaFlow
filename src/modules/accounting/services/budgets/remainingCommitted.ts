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
import { NO_ACCOUNT, postedExpenseLines } from './postedExpenseLines';

/** PO statuses whose lines commit spend; bill statuses whose linked lines release it. */
export const COMMITTING_PO_STATUSES = ['approved', 'partially_received', 'received'] as const;
export const BILLED_STATUSES = ['approved', 'paid', 'partially_paid'] as const;

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
export async function billedLinesByPoItem(companyId: string, poItemIds: string[], own: string[]): Promise<Map<string, BilledPosting[]>> {
  const out = new Map<string, BilledPosting[]>();
  if (poItemIds.length === 0) return out;
  const bills = (await sql`
    SELECT si.* FROM supplier_invoices si
     WHERE si.company_id = ${companyId}::UUID
       AND (si.status = ANY(${[...BILLED_STATUSES]}::TEXT[]) OR si.id = ANY(${own}::UUID[]))
       AND EXISTS (SELECT 1 FROM supplier_invoice_items x WHERE x.supplier_invoice_id = si.id AND x.po_item_id = ANY(${poItemIds}::UUID[]))
  `) as DbRow[];
  if (bills.length === 0) return out;
  const items = (await sql`
    SELECT sii.* FROM supplier_invoice_items sii
     WHERE sii.supplier_invoice_id = ANY(${bills.map((b) => String(b.id))}::UUID[])
    ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
  `) as DbRow[];
  const linked = new Set(poItemIds);
  for (const b of bills) {
    const billItems = items.filter((i) => String(i.supplier_invoice_id) === String(b.id));
    const poOf = new Map(billItems.map((i) => [String(i.id), text(i.po_item_id)]));
    const month = fmtDate(mapInvoiceRow(b).invoiceDate).slice(0, 7);
    for (const line of postedExpenseLines(b, billItems)) {
      const po = poOf.get(String(line.description));
      if (!po || !linked.has(po)) continue;
      out.set(po, [...(out.get(po) ?? []), {
        glAccountId: line.glAccountId === NO_ACCOUNT ? null : text(line.glAccountId), cc1Id: text(line.cc1Id), cc2Id: text(line.cc2Id),
        buId: text(line.buId), month, amount: line.debit,
      }]);
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
  const rows = (await sql`
    SELECT pi.id::TEXT AS po_item_id, pi.gl_account_id::TEXT AS gl_account_id, to_char(po.order_date, 'YYYY-MM') AS month,
           pi.cc1_id::TEXT AS cc1_id, pi.cc2_id::TEXT AS cc2_id, pi.bu_id::TEXT AS bu_id, pi.line_total::TEXT AS line_total
      FROM po_items pi
      JOIN purchase_orders po ON po.id = pi.purchase_order_id
     WHERE po.company_id = ${companyId}::UUID
       AND po.status = ANY(${[...COMMITTING_PO_STATUSES]}::TEXT[])
       AND pi.gl_account_id = ANY(${accounts}::UUID[])
       AND po.order_date >= ${start}::DATE AND po.order_date <= ${end}::DATE
       AND NOT (pi.id = ANY(${exclude}::UUID[]))
  `) as DbRow[];
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
