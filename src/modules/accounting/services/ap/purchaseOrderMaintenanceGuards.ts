/**
 * What stops a purchase order's lines or status being changed by the MCP maintenance tools: goods received against it, and bills
 * tied to it. Read under the PO row lock the caller holds. Company-scoped (po_items / grn_items have no company_id: tenancy goes
 * through the PO / the bill).
 *
 * "Tied" is wider than a link row: `supplier_invoice_items.po_item_id` has NO foreign key, so a bill line naming one of the PO's
 * lines (written by the REST create, which does not always make a link row) would be orphaned by replacing the lines. Deleted bills
 * do not count. A bill that names the PO ONLY by its header (no link row, no line on a PO line) is NOT a tie: there is nothing of it to
 * orphan, and no tool could clear it (unlink needs a link row), so counting it was a dead end ("unlink them first" / "not linked");
 * the link table is the list of bill <-> PO ties (design mcp-po-bill-links.md, decision 3: the header follows the links).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { withRowLockBudget } from '../core/rowLockBudget';
import { PurchaseOrderLockTimeoutError } from './purchaseOrderErrors';

export async function poHasReceipts(companyId: string, poId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM goods_received_notes WHERE purchase_order_id = ${poId}::UUID AND company_id = ${companyId}::UUID LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}

export async function poHasBillLinks(companyId: string, poId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT (
      EXISTS (SELECT 1 FROM purchase_order_bill_links WHERE company_id = ${companyId}::UUID AND purchase_order_id = ${poId}::UUID)
      OR EXISTS (SELECT 1 FROM supplier_invoice_items sii
                   JOIN po_items pi ON pi.id = sii.po_item_id AND pi.purchase_order_id = ${poId}::UUID
                   JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id AND si.company_id = ${companyId}::UUID AND si.deleted_at IS NULL)
    ) AS tied
  `) as DbRow[];
  return rows[0]?.tied === true;
}

export const RECEIPT_REFUSAL = 'Goods have been received against this purchase order (a receipt is on record)';
export const LINKS_REFUSAL = 'Bills are linked to this purchase order';

/** The refusal text for a PO whose lines / status must not move while a receipt or bill link stands, or null. */
export async function receiptOrLinkRefusal(companyId: string, poId: string, what: string): Promise<string | null> {
  if (await poHasReceipts(companyId, poId)) return `${RECEIPT_REFUSAL}, so ${what}; unlink or cancel the receipt first`;
  if (await poHasBillLinks(companyId, poId)) return `${LINKS_REFUSAL}, so ${what}; unlink them first (unlink_bill_from_purchase_order)`;
  return null;
}

export interface LockedPo { poNumber: string; status: string; externalRef: string | null; orderMonth: string }

/** The PO row `FOR UPDATE` (5 s, `PURCHASE_ORDER_LOCK_TIMEOUT`), company-scoped; null when it is not this company's. */
export async function lockPoForMaintenance(companyId: string, poId: string): Promise<LockedPo | null> {
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT po_number, status, external_ref, to_char(order_date, 'YYYY-MM') AS month
      FROM purchase_orders WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID
       FOR UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError());
  const r = rows[0];
  return r ? { poNumber: String(r.po_number), status: String(r.status), externalRef: r.external_ref == null ? null : String(r.external_ref), orderMonth: String(r.month) } : null;
}

/**
 * One rule for every writer of an APPROVED purchase order (update, import open, set status -> approved): under the BLOCK budget policy
 * each line needs an expense account. A line with none is "No budget" (never over), so it would escape the very check that approval
 * runs. The import's `skip_budget_check_for_import` lets such lines through, reported as would-have-failed.
 */
export const ACCOUNTLESS_REFUSAL = 'Under the block budget policy every line of an approved purchase order needs an expense account: a line with none cannot be checked against a budget';

/** Lines of the PO (stored) with no account: the set-status check. */
export async function poHasAccountlessLines(companyId: string, poId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM po_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE pi.purchase_order_id = ${poId}::UUID AND pi.gl_account_id IS NULL LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}
