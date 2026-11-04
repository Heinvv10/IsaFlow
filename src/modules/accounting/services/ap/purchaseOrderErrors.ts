/**
 * The purchase-order actions' typed refusals and their shared row lock (budgets P5-3: Approve, Cancel). Every code
 * is in the MCP `REFUSAL_CODES` (fixed wording, at most the PO's own status); each is raised before any write.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { withRowLockBudget } from '../core/rowLockBudget';
import { poHeaderOf, type PoHeader } from './purchaseOrderBudget';

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

/** 400: the PO cannot be cancelled by the Cancel action (not approved, or goods already received against it). */
export class PurchaseOrderNotCancellableError extends Error {
  readonly code = 'PURCHASE_ORDER_NOT_CANCELLABLE';
  constructor(message: string) {
    super(message);
    this.name = 'PurchaseOrderNotCancellableError';
  }
}

/** 409: the PO's status moved under a write that held its row lock (a guard that cannot fire; the K-137 belt). */
export class PurchaseOrderChangedError extends Error {
  readonly code = 'PURCHASE_ORDER_CHANGED';
  constructor() {
    super('The purchase order changed while it was being saved — reload it and try again.');
    this.name = 'PurchaseOrderChangedError';
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

/** The PO row `FOR UPDATE` (5 s → `PurchaseOrderLockTimeoutError`), company-scoped; null when not this company's. */
export async function lockPurchaseOrder(companyId: string, poId: string): Promise<PoHeader | null> {
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT id, po_number, status, to_char(order_date, 'YYYY-MM') AS month
      FROM purchase_orders WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID
       FOR UPDATE
  `) as DbRow[], () => new PurchaseOrderLockTimeoutError());
  return rows[0] ? poHeaderOf(rows[0]) : null;
}
