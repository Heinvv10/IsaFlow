/**
 * set_purchase_order_status (design docs/design/mcp-po-maintenance.md, decision 4): move an IMPORTED purchase order (one that
 * carries `external_ref`) to draft | approved | closed | cancelled, for the source system's later changes (Sage Pending -> Invoiced,
 * a cancelled one revived). Posts nothing; audited old -> new with the reason.
 *
 * Refused (before any write): not imported, no change, a goods receipt on record, a received status either side
 * (`partially_received` / `received` come only from receipts), and a move that would orphan bill links (-> draft or -> cancelled
 * while a link stands: links are valid on approved and closed POs, so those moves stay open).
 *   -> approved: the Approve action's budget check runs NORMALLY on its lines (channel mcp; the import's skip flag does not apply
 *      to a status fix), before the write, under the budget gate taken FIRST; approved_by / approved_at are stamped.
 *   -> closed: from APPROVED only (closing a never-approved PO would make it linkable; the import creates closed POs directly). The
 *      status it came from is recorded in `closed_from_status` (migration 1007), as close_purchase_order does.
 *   -> anything else: closed_from_status is cleared (its CHECK holds a value only while closed); -> draft also clears approved_by /
 *      approved_at. LEAVING closed also clears `closed_by_billing` (1016's trigger, whoever writes the status), so a later unlink
 *      cannot reopen a PO someone deliberately reopened and closed again (review M3); closing here never sets it (a close by hand).
 * Locks: the budget gate (-> approved, block policy) -> the PO row `FOR UPDATE`. No bill row is locked.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { openBudgetGate } from '../budgets/budgetCheck';
import { checkPurchaseOrderBudget } from './purchaseOrderBudget';
import { PurchaseOrderChangedError, PurchaseOrderMaintenanceRefusal, PurchaseOrderNotFoundError } from './purchaseOrderErrors';
import { ACCOUNTLESS_REFUSAL, lockPoForMaintenance, billTieRefusal, poHasAccountlessLines, poHasReceipts } from './purchaseOrderMaintenanceGuards';

export const SETTABLE_PO_STATUSES = ['draft', 'approved', 'closed', 'cancelled'] as const;
export type SettablePoStatus = (typeof SETTABLE_PO_STATUSES)[number];

export interface SetStatusOptions { userId: string; via: string; budgetFigures: boolean }

export interface SetStatusResult {
  poId: string;
  poNumber: string;
  statusBefore: string;
  status: SettablePoStatus;
  closedFromStatus: string | null;
  budgetWarnings: string[];
}

const refuse = (m: string) => new PurchaseOrderMaintenanceRefusal(m);
const words = (s: string) => s.replace(/_/g, ' ');

export async function setImportedPurchaseOrderStatus(
  companyId: string, poId: string, target: SettablePoStatus, reason: string, opts: SetStatusOptions,
): Promise<SetStatusResult> {
  const why = reason.trim();
  if (why === '') throw refuse('Give a reason to change a purchase order status');
  return withSavepoint('set_purchase_order_status', async () => {
    const gate = target === 'approved' ? await openBudgetGate(companyId, 'take') : null; // FIRST, as every approve path
    const po = await lockPoForMaintenance(companyId, poId);
    if (!po) throw new PurchaseOrderNotFoundError();
    if (po.externalRef === null) {
      throw refuse('Only a purchase order imported from another system (it carries an external_ref) can have its status set; use update / cancel_purchase_order / close_purchase_order for the others');
    }
    if (po.status === target) throw refuse(`This purchase order is already ${words(target)}`);
    if (po.status === 'partially_received' || po.status === 'received') {
      throw refuse(`This purchase order is ${words(po.status)}: its status comes from its goods receipts and cannot be set here`);
    }
    if (target === 'closed' && po.status !== 'approved') {
      throw refuse(`A purchase order is closed from approved only (this one is ${words(po.status)}): approve it first, so it is not made billable without ever having been approved`);
    }
    if (await poHasReceipts(companyId, poId)) {
      throw refuse('Goods have been received against this purchase order (a receipt is on record), so its status cannot be set; unlink or cancel the receipt first');
    }
    if (target === 'draft' || target === 'cancelled') {
      const tied = await billTieRefusal(companyId, poId, `it cannot go to ${target}`);
      if (tied) throw refuse(tied);
    }

    if (target === 'approved' && gate?.policy === 'block' && await poHasAccountlessLines(companyId, poId)) throw refuse(ACCOUNTLESS_REFUSAL);

    let budgetWarnings: string[] = [];
    let budgetPolicy: string | null = null;
    if (target === 'approved' && gate) {
      const check = await checkPurchaseOrderBudget(
        companyId, { id: poId, poNumber: po.poNumber, status: po.status, month: po.orderMonth }, gate,
        { channel: 'mcp', lock: 'held', gate, figures: opts.budgetFigures }, opts.userId,
      );
      budgetWarnings = check.warnings;
      budgetPolicy = check.policy;
    }
    const closedFrom = target === 'closed' ? po.status : null;
    const updated = (await sql`
      UPDATE purchase_orders SET
        status = ${target}, closed_from_status = ${closedFrom}::TEXT,
        approved_by = CASE WHEN ${target === 'approved'}::BOOLEAN THEN ${opts.userId}::TEXT WHEN ${target === 'draft'}::BOOLEAN THEN NULL ELSE approved_by END,
        approved_at = CASE WHEN ${target === 'approved'}::BOOLEAN THEN NOW() WHEN ${target === 'draft'}::BOOLEAN THEN NULL ELSE approved_at END,
        updated_at = NOW(), updated_by = ${opts.userId}
       WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID AND status = ${po.status} RETURNING id
    `) as DbRow[];
    if (!updated[0]) throw new PurchaseOrderChangedError();
    await logAuditOrThrow({
      companyId, userId: opts.userId, action: target === 'approved' ? 'approve' : 'update', entityType: 'purchase_order', entityId: poId,
      entityRef: po.poNumber.slice(0, 100),
      changes: {
        fields: [{ field: 'status', old: po.status, new: target, label: 'Status' }],
        metadata: {
          reason: why.slice(0, 500), source: opts.via, status_set: 'true',
          ...(closedFrom ? { status_before: closedFrom } : {}),
          ...(budgetPolicy ? { budgetPolicy, ...(budgetWarnings.length > 0 ? { budgetWarnings: String(budgetWarnings.length) } : {}) } : {}),
        },
      },
    });
    return { poId, poNumber: po.poNumber, statusBefore: po.status, status: target, closedFromStatus: closedFrom, budgetWarnings };
  });
}
