/**
 * Approving a purchase order (budgets P5-3; spec §0 decision 8c, §3b call site 3, §3c). The ONE writer of
 * `purchase_orders.status = 'approved'` from a draft or submitted PO: the PUT refuses that status (census item 2;
 * the goods-received service only keeps an already approved PO approved).
 *
 * Order (block policy; warn / off take no budget lock):
 *   1. the company budget gate (`budget_check:<company>`, seed 954, bounded 5 s → 503) — FIRST, as the bill paths;
 *   2. the PO row `FOR UPDATE` (bounded 5 s → `PURCHASE_ORDER_LOCK_TIMEOUT` 503), so two approvals of one PO and
 *      the PUT's line replacement serialise;
 *   3. the status refusal, then the budget check on the PO's lines (reads only, no row locks);
 *   4. the status UPDATE (approved_by / approved_at / updated_by stamped), the PO's audit row.
 * Everything runs in one savepoint: a refusal leaves nothing behind, and its `refused` budget event is written by
 * the caller after the savepoint rolled back (`respondIfBudgetRefused`), as for bills.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { logAuditOrThrow } from '../core/auditTrailService';
import { gateFor } from '../budgets/budgetCheck';
import type { BudgetCheckContext } from '../budgets/budgetCheckTypes';
import { APPROVABLE_PO_STATUSES, checkPurchaseOrderBudget } from './purchaseOrderBudget';
import {
  lockPurchaseOrder, PurchaseOrderChangedError, PurchaseOrderNotApprovableError, PurchaseOrderNotFoundError,
} from './purchaseOrderErrors';

export {
  PurchaseOrderChangedError, PurchaseOrderLockTimeoutError, PurchaseOrderNotApprovableError, PurchaseOrderNotFoundError,
} from './purchaseOrderErrors';

export interface ApprovedPurchaseOrder {
  purchaseOrder: DbRow;
  /** The over-budget lines a warn-mode approval went ahead with. */
  budgetWarnings?: string[];
}

/**
 * Approves a draft or submitted PO under the budget check. `budget`: the caller's channel and lock mode (the route:
 * `ui` + `take`, with the person's reason / override and company role). Throws `PurchaseOrderNotFoundError`,
 * `PurchaseOrderNotApprovableError`, the budget refusals (`BudgetReasonRequiredError`, `BudgetExceededError`,
 * `BudgetCheckLockTimeoutError`), `PurchaseOrderLockTimeoutError` or `ImpersonationForbiddenError`; none of them
 * leaves a write behind.
 */
export async function approvePurchaseOrder(
  companyId: string, poId: string, userId: string, budget: BudgetCheckContext,
): Promise<ApprovedPurchaseOrder> {
  await assertNotImpersonating(); // R-032 L5, as bill approval: first, before any read or write
  return withSavepoint('approve_purchase_order', async () => {
    const gate = await gateFor(companyId, budget); // block: the company budget lock FIRST
    const po = await lockPurchaseOrder(companyId, poId); // then the PO row
    if (!po) throw new PurchaseOrderNotFoundError();
    if (!APPROVABLE_PO_STATUSES.includes(po.status)) throw new PurchaseOrderNotApprovableError(po.status);
    const check = await checkPurchaseOrderBudget(companyId, po, gate, budget, userId);
    const updated = (await sql`
      UPDATE purchase_orders
         SET status = 'approved', approved_by = ${userId}, approved_at = NOW(), updated_at = NOW(), updated_by = ${userId}
       WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID AND status = ANY(${[...APPROVABLE_PO_STATUSES]}::TEXT[])
      RETURNING *
    `) as DbRow[];
    // The row is held FOR UPDATE since the status read, so the guard cannot miss; it is the K-137 belt all the same.
    if (!updated[0]) throw new PurchaseOrderChangedError();
    await logAuditOrThrow({
      companyId, userId, action: 'approve', entityType: 'purchase_order', entityId: poId, entityRef: po.poNumber.slice(0, 100),
      changes: {
        fields: [{ field: 'status', old: po.status, new: 'approved', label: 'Status' }],
        metadata: { budgetPolicy: check.policy, ...(check.outcome ? { budgetCheck: check.outcome } : {}) },
      },
    });
    return { purchaseOrder: updated[0], ...(check.warnings.length > 0 ? { budgetWarnings: check.warnings } : {}) };
  });
}
