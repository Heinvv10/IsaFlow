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
import { withRowLockBudget } from '../core/rowLockBudget';
import { gateFor } from '../budgets/budgetCheck';
import type { BudgetCheckContext } from '../budgets/budgetCheckTypes';
import { APPROVABLE_PO_STATUSES, checkPurchaseOrderBudget, poHeaderOf, type PoHeader } from './purchaseOrderBudget';

/** 404: no such PO in this company. */
export class PurchaseOrderNotFoundError extends Error {
  readonly code = 'PURCHASE_ORDER_NOT_FOUND';
  constructor() {
    super('Purchase order not found');
    this.name = 'PurchaseOrderNotFoundError';
  }
}

/** 400: the PO's status does not take an approval. */
export class PurchaseOrderNotApprovableError extends Error {
  readonly code = 'PURCHASE_ORDER_NOT_APPROVABLE';
  constructor(readonly status: string) {
    super(`Only draft or submitted purchase orders can be approved (this one is ${status.replace(/_/g, ' ')})`);
    this.name = 'PurchaseOrderNotApprovableError';
  }
}

/** 503 + Retry-After (a `*_LOCK_TIMEOUT` code): another request held the PO row past the budget. */
export class PurchaseOrderLockTimeoutError extends Error {
  readonly code = 'PURCHASE_ORDER_LOCK_TIMEOUT';
  constructor() {
    super('This purchase order is being changed by another request — retry in a moment.');
    this.name = 'PurchaseOrderLockTimeoutError';
  }
}

async function lockPurchaseOrder(companyId: string, poId: string): Promise<PoHeader | null> {
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT id, po_number, status, to_char(order_date, 'YYYY-MM') AS month
      FROM purchase_orders WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID
       FOR UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError());
  return rows[0] ? poHeaderOf(rows[0]) : null;
}

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
    if (!updated[0]) throw new Error(`Purchase order ${poId} changed while it was being approved`);
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
