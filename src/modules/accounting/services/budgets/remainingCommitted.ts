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
import { BILLED_STATUSES, COMMITTING_PO_STATUSES, isFullyBilledBasis } from './poCommitStatus';
import { NO_ACCOUNT, postedExpenseLines } from './postedExpenseLines';
import { toCents } from './grid/cents';
import { spreadLineNets } from './lineNetSpread';

export { BILLED_STATUSES, COMMITTING_PO_STATUSES, commitsSpend } from './poCommitStatus';

/**
 * What "fully billed" is measured against, per PO (cents): the larger of the header subtotal and the lines' total, as 1022 closes
 * on (review r7 M2: one basis for every reader, writer and close decision). 0 for a PO of no line and no subtotal.
 */
export async function poBillingBasisCents(companyId: string, poIds: readonly string[]): Promise<Map<string, number>> {
  if (poIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT p.id::TEXT AS id, GREATEST(round(COALESCE(p.subtotal, 0) * 100), COALESCE((SELECT round(SUM(x.line_total) * 100)
             FROM po_items x WHERE x.purchase_order_id = p.id), 0))::BIGINT AS basis
      FROM purchase_orders p WHERE p.company_id = ${companyId}::UUID AND p.id = ANY(${[...poIds]}::UUID[])
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), Number(r.basis)]));
}

/**
 * Review r6 M5: of these POs, the ones closed by billing and fully billed at PO level (the one attribution, as billedCentsByPo
 * counts it, against `poBillingBasisCents`): they commit 0, even beside a line over-billed by its lines (R4-5); one that is not
 * commits its per-line open remainder. `own`: bills counted as billed whatever their status, as readCommitments nets them (r7 L1).
 */
export async function fullyBilledClosedPos(companyId: string, poIds: readonly string[], own: readonly string[] = []): Promise<Set<string>> {
  if (poIds.length === 0) return new Set();
  const closed = ((await sql`
    SELECT id::TEXT AS id FROM purchase_orders
     WHERE company_id = ${companyId}::UUID AND id = ANY(${[...poIds]}::UUID[]) AND status = 'closed' AND closed_by_billing
  `) as DbRow[]).map((r) => String(r.id).toLowerCase());
  if (closed.length === 0) return new Set();
  const billed = new Map<string, number>();
  for (const t of await billTies(companyId, closed, { statuses: BILLED_STATUSES, own })) {
    if (!t.deleted) billed.set(t.poId, (billed.get(t.poId) ?? 0) + t.cents);
  }
  const basis = await poBillingBasisCents(companyId, closed);
  return new Set(closed.filter((id) => isFullyBilledBasis(billed.get(id) ?? 0, basis.get(id) ?? 0)));
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
    SELECT sii.*, pi.purchase_order_id::TEXT AS item_po, pi.line_total::TEXT AS item_total FROM supplier_invoice_items sii
      LEFT JOIN po_items pi ON pi.id = sii.po_item_id
     WHERE sii.supplier_invoice_id = ANY(${bills.map((b) => String(b.id))}::UUID[])
    ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
  `) as DbRow[];
  const linked = new Set(poItemIds);
  for (const b of bills) {
    const billItems = items.filter((i) => String(i.supplier_invoice_id) === String(b.id));
    const poOf = new Map(billItems.map((i) => [String(i.id), text(i.po_item_id)]));
    const orderOf = new Map(billItems.map((i) => [text(i.po_item_id), text(i.item_po)]));
    const capOf = new Map(billItems.map((i) => [text(i.po_item_id), toCents(Number(i.item_total ?? 0))]));
    const month = fmtDate(mapInvoiceRow(b).invoiceDate).slice(0, 7);
    // Per (bill, PO), each PO line's postings are netted first, then budgets/lineNetSpread decides what each line bills (breaker r9,
    // the corrected rule): max(0, sum of the line nets) on the PO, a positive line keeping its net less a largest-remainder share of
    // the negatives, a line netting <= 0 billing nothing. The verdict is over every line of the bill naming the PO, whatever subset was
    // asked for (review r7 M1); a credit stays on its own line's account.
    const byOrder = new Map<string, Map<string, { cents: number; posting: BilledPosting }>>();
    for (const line of postedExpenseLines(b, billItems)) {
      const item = poOf.get(String(line.description));
      if (!item) continue;
      const order = orderOf.get(item) ?? item;
      const lines = byOrder.get(order) ?? new Map<string, { cents: number; posting: BilledPosting }>();
      // A line netted from several postings keeps its FIRST posting's dimensions (account, cc1 / cc2 / bu, month); nothing reads
      // a billed posting's dimensions today (openPoLineCents sums amounts only; review r10 LOW-4).
      const had = lines.get(item);
      lines.set(item, had ? { ...had, cents: had.cents + toCents(line.debit) } : { cents: toCents(line.debit), posting: {
        glAccountId: line.glAccountId === NO_ACCOUNT ? null : text(line.glAccountId), cc1Id: text(line.cc1Id), cc2Id: text(line.cc2Id),
        buId: text(line.buId), month, amount: line.debit,
      } });
      byOrder.set(order, lines);
    }
    for (const lines of byOrder.values()) {
      const items = [...lines.entries()];
      // Capped at each PO line's own total, the excess water-filled onto the lines with room (breaker r10 R10-1).
      const shares = spreadLineNets(items.map(([, l]) => l.cents), items.map(([item]) => capOf.get(item) ?? 0));
      items.forEach(([item, l], k) => {
        if (shares[k]! > 0 && linked.has(item)) out.set(item, [...(out.get(item) ?? []), { ...l.posting, amount: shares[k]! / 100 }]);
      });
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

/** A committed PO line as `readCommitments` reads it, plus the PO and supplier it belongs to; `glAccountId` null: the line names no account. */
export interface CommitmentLine extends Omit<CommitmentRow, 'glAccountId'> {
  glAccountId: string | null;
  poId: string;
  supplierId: string;
}

/**
 * Which committing PO lines to read. `accounts` null reads every line, one naming no account too (`readCommitments` always names
 * accounts: a line with none cannot meet a budget; the committed-spend report asks for the rest as well). `range` null: any order date.
 * Every filter narrows the lines read, never how a line is netted (netting is per PO line, over its PO's bills).
 */
export interface CommitmentFilter {
  accounts: readonly string[] | null;
  range: { start: string; end: string } | null;
  supplierId?: string | null;
  cc2Id?: string | null;
  poIds?: readonly string[] | null;
}

/** The committing PO lines of `filter`, each with the bills that count against it (`committedBillingByPoItem`). The one reading of committed. */
export async function readCommitmentLines(companyId: string, filter: CommitmentFilter, opts: CommittedOptions): Promise<CommitmentLine[]> {
  const exclude = (opts.excludePoItemIds ?? []).map((id) => id.toLowerCase());
  const accounts = filter.accounts === null ? null : [...filter.accounts];
  const pos = filter.poIds == null ? null : [...filter.poIds];
  const all = (await sql`
    SELECT pi.id::TEXT AS po_item_id, pi.gl_account_id::TEXT AS gl_account_id, to_char(po.order_date, 'YYYY-MM') AS month,
           pi.cc1_id::TEXT AS cc1_id, pi.cc2_id::TEXT AS cc2_id, pi.bu_id::TEXT AS bu_id, pi.line_total::TEXT AS line_total,
           po.id::TEXT AS po_id, po.supplier_id::TEXT AS supplier_id, (po.status = 'closed' AND po.closed_by_billing) AS closed_by_billing
      FROM po_items pi
      JOIN purchase_orders po ON po.id = pi.purchase_order_id
     WHERE po.company_id = ${companyId}::UUID
       AND (po.status = ANY(${[...COMMITTING_PO_STATUSES]}::TEXT[]) OR (po.status = 'closed' AND po.closed_by_billing))
       AND (${accounts}::UUID[] IS NULL OR pi.gl_account_id = ANY(${accounts}::UUID[]))
       AND (${filter.range?.start ?? null}::DATE IS NULL OR po.order_date >= ${filter.range?.start ?? null}::DATE)
       AND (${filter.range?.end ?? null}::DATE IS NULL OR po.order_date <= ${filter.range?.end ?? null}::DATE)
       AND (${filter.supplierId ?? null}::UUID IS NULL OR po.supplier_id = ${filter.supplierId ?? null}::UUID)
       AND (${filter.cc2Id ?? null}::UUID IS NULL OR pi.cc2_id = ${filter.cc2Id ?? null}::UUID)
       AND (${pos}::UUID[] IS NULL OR po.id = ANY(${pos}::UUID[]))
       AND NOT (pi.id = ANY(${exclude}::UUID[]))
  `) as DbRow[];
  const own = [opts.excludeInvoiceId, ...(opts.alsoBilledInvoiceIds ?? [])].filter((v): v is string => !!v).map((v) => v.toLowerCase());
  const settled = await fullyBilledClosedPos(companyId, [...new Set(all.filter((r) => r.closed_by_billing === true).map((r) => String(r.po_id)))], own);
  const rows = all.filter((r) => !settled.has(String(r.po_id).toLowerCase()));
  const billed = await committedBillingByPoItem(companyId, rows.map((r) => String(text(r.po_item_id))), own);
  return rows.map((r) => {
    const id = String(text(r.po_item_id));
    return {
      poItemId: id, glAccountId: text(r.gl_account_id), month: String(r.month),
      cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id),
      lineTotal: Number(r.line_total), billed: billed.get(id) ?? [],
      poId: String(text(r.po_id)), supplierId: String(text(r.supplier_id)),
    };
  });
}

export async function readCommitments(
  companyId: string, accounts: string[], start: string, end: string, opts: CommittedOptions,
): Promise<CommitmentRow[]> {
  const lines = await readCommitmentLines(companyId, { accounts, range: { start, end } }, opts);
  return lines.map((l) => ({
    poItemId: l.poItemId, glAccountId: String(l.glAccountId), month: l.month, cc1Id: l.cc1Id, cc2Id: l.cc2Id, buId: l.buId, lineTotal: l.lineTotal, billed: l.billed,
  }));
}
