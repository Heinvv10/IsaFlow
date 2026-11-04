/**
 * Committed spend for remaining budget (budgets P5 spec §3a, decision 8a): open PO lines less what
 * bills linked to them have already billed, per PO line, floored at 0 by the core.
 *
 * - PO lines: POs with status approved / partially_received / received, in their order-date month,
 *   with an account among the keys' (a line with no account cannot meet a budget). `line_total`
 *   is qty × unit price, ex-VAT, on both PO writers (census T1.5).
 * - Billed: for every bill line linked by `po_item_id`, on a bill that is approved / paid /
 *   partially_paid (or is `excludeInvoiceId`, the bill being checked), the ex-VAT amount APPROVE
 *   POSTS for that line: the bill's lines go through `ap/supplierInvoiceExpenseLines.buildExpenseLines`
 *   in the approve path's line order (`SUPPLIER_INVOICE_LINE_ORDER_BY`). A bill whose lines are
 *   stored gross (Σ line_total ≈ total_amount) is scaled to its subtotal, the last line takes the
 *   rounding residual, and a sub-cent overshoot or a R0 line is folded/dropped there exactly as
 *   posted (census finding 3). Never the stored `line_total`, never `quantity_invoiced`.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { buildExpenseLines } from '../ap/supplierInvoiceExpenseLines';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from '../ap/supplierInvoiceLineOrder';
import { mapInvoiceRow } from '../ap/supplierInvoiceWorkflowRow';
import type { SupplierInvoiceItem } from '../../types/ap.types';
import type { CommitmentRow } from './remainingBudgetCore';

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

/** The fields buildExpenseLines reads; `description` carries the line id so each posted line maps back to its item. */
function itemOf(r: DbRow): SupplierInvoiceItem {
  return {
    id: String(r.id), supplierInvoiceId: String(r.supplier_invoice_id), description: String(r.id),
    quantity: Number(r.quantity), unitPrice: Number(r.unit_price), taxRate: Number(r.tax_rate), taxAmount: Number(r.tax_amount),
    lineTotal: Number(r.line_total), glAccountId: r.gl_account_id ? String(r.gl_account_id) : undefined,
    createdAt: String(r.created_at),
  };
}

/** Ex-VAT posted amount per PO line, over the bills that count as billed. */
async function billedByPoItem(companyId: string, poItemIds: string[], own: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
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
    for (const line of buildExpenseLines({ ...mapInvoiceRow(b), items: billItems.map(itemOf) }, 'unused')) {
      const po = poOf.get(String(line.description));
      if (po && linked.has(po)) out.set(po, Math.round(((out.get(po) ?? 0) + line.debit) * 100) / 100);
    }
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
  const billed = await billedByPoItem(companyId, rows.map((r) => String(text(r.po_item_id))), own);
  return rows.map((r) => {
    const id = String(text(r.po_item_id));
    return {
      poItemId: id, glAccountId: String(text(r.gl_account_id)), month: String(r.month),
      cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id),
      lineTotal: Number(r.line_total), billed: billed.get(id) ?? 0,
    };
  });
}
