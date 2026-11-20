/**
 * What stops a purchase order's lines or status being changed by the MCP maintenance tools: goods received against it, and bills
 * tied to it. Read under the PO row lock the caller holds. Company-scoped (po_items / grn_items have no company_id: tenancy goes
 * through the PO / the bill).
 *
 * "Tied" is wider than a link row: `supplier_invoice_items.po_item_id` has NO foreign key, so a bill line naming one of the PO's
 * lines (written by the REST create, which does not always make a link row) would be orphaned by replacing the lines. Deleted bills
 * do not count. A bill that names the PO ONLY by its header counts (as `header`) only when the link tool could link the pair; see
 * `poBillTie`.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { withRowLockBudget } from '../core/rowLockBudget';
import { PurchaseOrderLockTimeoutError } from './purchaseOrderErrors';
import { TIE_REFUSAL, tieRefusalText } from './purchaseOrderTies';

/** A receipt that stands: a goods received note of the PO that is not cancelled (a cancelled one received nothing). */
export async function poHasReceipts(companyId: string, poId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM goods_received_notes
     WHERE purchase_order_id = ${poId}::UUID AND company_id = ${companyId}::UUID AND status <> 'cancelled' LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}

/**
 * Any note at all, a cancelled one too. A cancelled note is kept as the record with its items (migration 1021: never deleted or
 * edited), and grn_items.po_item_id references the PO's lines, so those lines can no longer be replaced or the PO deleted.
 */
export async function poHasAnyNote(companyId: string, poId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM goods_received_notes WHERE purchase_order_id = ${poId}::UUID AND company_id = ${companyId}::UUID LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}

export const RECEIPT_REFUSAL = 'Goods have been received against this purchase order (a receipt is on record)';
export const CANCELLED_NOTE_LINES_REFUSAL =
  'A cancelled goods received note of this purchase order is kept as the record and names its lines';
export const LINKS_REFUSAL = TIE_REFUSAL;

/**
 * What a refusal says about the bills that tie the PO, or null when none does: they are NAMED (number, id, kind: link | line |
 * header; ten shown, the rest counted), because a tie without a link row is invisible otherwise. ONE wording for every kind:
 * `unlink_bill_from_purchase_order` is the one exit.
 */
export const billTieRefusal = tieRefusalText;

/** The refusal text for a PO whose lines / status must not move while a receipt or bill link stands, or null. */
export async function receiptOrLinkRefusal(companyId: string, poId: string, what: string): Promise<string | null> {
  if (await poHasReceipts(companyId, poId)) return `${RECEIPT_REFUSAL}, so ${what}; cancel its goods received notes first (cancel_goods_received)`;
  return billTieRefusal(companyId, poId, what);
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
 * One rule for every MCP writer of an APPROVED purchase order (update, import open, set status -> approved): under the BLOCK budget policy
 * each line needs an expense account. A line with none is "No budget" (never over), so it would escape the very check that approval
 * runs. The import's `skip_budget_check_for_import` lets such lines through, reported as would-have-failed.
 *
 * NOT the app's Approve action (`purchaseOrderApprove`): it deliberately accepts account-less lines as "No budget" (P5-3 census 7: the
 * PO create route writes lines with no account), so refusing them there would stop approvals the app's own screens produce. The MCP
 * tools are stricter because an agent loads or edits lines in bulk and can name the account.
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
