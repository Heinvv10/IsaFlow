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
import { LINKABLE_BILL_STATUSES, LINKABLE_PO_STATUSES } from './purchaseOrderBillLinkTypes';

export async function poHasReceipts(companyId: string, poId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM goods_received_notes WHERE purchase_order_id = ${poId}::UUID AND company_id = ${companyId}::UUID LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}

/**
 * How a bill is tied to the PO, or null:
 *   - `linked`: a link row, or a (not deleted) bill line naming one of the PO's lines;
 *   - `header`: a bill that names the PO ONLY in its header, no link row, and that `link_bills_to_purchase_order` COULD link: PO in a
 *     linkable status, bill approved / paid / partially_paid and not deleted, same supplier. Such a bill is billing the PO (the
 *     three-way match reads the header PO's lines) but has no link row yet (it was made while the PO was only submitted and the
 *     approval writes no link); the way out is to link it, then unlink if it was wrong. A header reference the link tool could NOT
 *     make a link of (a draft / submitted / cancelled PO, a draft or cancelled bill, another supplier) is not a tie: nothing bills the
 *     PO, and nothing could clear it.
 */
export async function poBillTie(companyId: string, poId: string): Promise<'linked' | 'header' | null> {
  const rows = (await sql`
    SELECT (
      EXISTS (SELECT 1 FROM purchase_order_bill_links WHERE company_id = ${companyId}::UUID AND purchase_order_id = ${poId}::UUID)
      OR EXISTS (SELECT 1 FROM supplier_invoice_items sii
                   JOIN po_items pi ON pi.id = sii.po_item_id AND pi.purchase_order_id = ${poId}::UUID
                   JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id AND si.company_id = ${companyId}::UUID AND si.deleted_at IS NULL)
    ) AS linked,
    EXISTS (SELECT 1 FROM supplier_invoices si JOIN purchase_orders po ON po.id = si.purchase_order_id AND po.company_id = si.company_id
             WHERE si.company_id = ${companyId}::UUID AND si.purchase_order_id = ${poId}::UUID AND si.deleted_at IS NULL
               AND si.supplier_id = po.supplier_id AND si.status = ANY(${[...LINKABLE_BILL_STATUSES]}::TEXT[])
               AND po.status = ANY(${[...LINKABLE_PO_STATUSES]}::TEXT[])) AS header
  `) as DbRow[];
  return rows[0]?.linked === true ? 'linked' : rows[0]?.header === true ? 'header' : null;
}

export const poHasBillLinks = async (companyId: string, poId: string): Promise<boolean> => (await poBillTie(companyId, poId)) !== null;

export const RECEIPT_REFUSAL = 'Goods have been received against this purchase order (a receipt is on record)';
export const LINKS_REFUSAL = 'Bills are linked to this purchase order';

/** The refusal text for a PO whose lines / status must not move while a receipt or bill link stands, or null. */
export async function receiptOrLinkRefusal(companyId: string, poId: string, what: string): Promise<string | null> {
  if (await poHasReceipts(companyId, poId)) return `${RECEIPT_REFUSAL}, so ${what}; unlink or cancel the receipt first`;
  const tie = await poBillTie(companyId, poId);
  if (tie === 'linked') return `${LINKS_REFUSAL}, so ${what}; unlink them first (unlink_bill_from_purchase_order)`;
  if (tie === 'header') return `A bill names this purchase order in its header but is not linked to it, so ${what}; link it first (link_bills_to_purchase_order), then unlink it if it is not billing this order, or clear the bill's purchase order`;
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
