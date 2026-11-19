/**
 * What has been billed against purchase orders, computed on read (design decision 5): nothing is rolled up into
 * po_items or purchase_orders, so there is nothing to drift.
 *   - per PO: the sum of the link amounts on bills in approved / paid / partially_paid (`BILLED_STATUSES`), not deleted;
 *   - per PO line: quantity and posted ex-VAT amount of the linked bill lines on those bills
 *     (`billedLinesByPoItem`: the same posted amounts budget committed uses).
 * po_items has no company_id: every read goes through the company's purchase_orders / supplier_invoices.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { toCents } from '../budgets/grid/cents';
import { BILLED_STATUSES, billedLinesByPoItem } from '../budgets/remainingCommitted';

export async function billedCentsByPo(companyId: string, poIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (poIds.length === 0) return out;
  const rows = (await sql`
    SELECT l.purchase_order_id::TEXT AS po, COALESCE(SUM(l.amount), 0)::TEXT AS billed
      FROM purchase_order_bill_links l
      JOIN supplier_invoices si ON si.id = l.supplier_invoice_id AND si.company_id = l.company_id
     WHERE l.company_id = ${companyId}::UUID AND l.purchase_order_id = ANY(${[...poIds]}::UUID[])
       AND si.status = ANY(${[...BILLED_STATUSES]}::TEXT[]) AND si.deleted_at IS NULL
     GROUP BY l.purchase_order_id
  `) as DbRow[];
  for (const r of rows) out.set(String(r.po).toLowerCase(), toCents(Number(r.billed)));
  return out;
}

export interface BilledLine { qty: number; amountCents: number }

export async function billedByPoItem(companyId: string, poItemIds: readonly string[]): Promise<Map<string, BilledLine>> {
  const out = new Map<string, BilledLine>();
  if (poItemIds.length === 0) return out;
  const ids = [...poItemIds];
  const qty = (await sql`
    SELECT sii.po_item_id::TEXT AS item, SUM(sii.quantity)::TEXT AS qty
      FROM supplier_invoice_items sii
      JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id AND si.company_id = ${companyId}::UUID
     WHERE sii.po_item_id = ANY(${ids}::UUID[]) AND si.status = ANY(${[...BILLED_STATUSES]}::TEXT[]) AND si.deleted_at IS NULL
     GROUP BY sii.po_item_id
  `) as DbRow[];
  for (const r of qty) out.set(String(r.item).toLowerCase(), { qty: Number(r.qty), amountCents: 0 });
  const posted = await billedLinesByPoItem(companyId, ids.map((i) => i.toLowerCase()), []);
  for (const [item, lines] of posted) {
    const cur = out.get(item) ?? { qty: 0, amountCents: 0 };
    out.set(item, { qty: cur.qty, amountCents: lines.reduce((s, l) => s + toCents(l.amount), 0) });
  }
  return out;
}
