/**
 * The supplier a writer is about to file a document under (bill, payment, batch, PO, credit note), locked and checked live (#1699
 * reviews: Codex gate at ecc452ea6b, findings 3 and 4; the breaker of aad49a02, H1 / M1 / M2).
 *
 * A supplier merge holds both supplier rows FOR UPDATE while it moves the source's bills, then soft-deletes the source
 * (merged_into_id). A writer that chose its supplier from an earlier read (the AP take-on's batch list, the Sage bill import's
 * party match) could otherwise check for a duplicate on the source after the merge moved the bill away, or file onto a row the
 * merge has just deleted. Taking the row FOR KEY SHARE first makes the writer wait for a merge in progress and keeps any later merge
 * of that row waiting until the writer's transaction ends; the check after the wait sees the merge's outcome.
 *
 * FOR KEY SHARE is what the document INSERT's foreign key takes on the same row anyway; this takes it FIRST, before any PO, bill,
 * payment or journal row the writer touches, which is the merge's order (batches, then both supplier rows FOR UPDATE, then the
 * source's POs, payments, bills). That ordering is the point, not only the liveness check: the bill create used to take its POs FOR
 * KEY SHARE and only then the supplier (at the INSERT's FK), the reverse of the merge's supplier -> POs, a 40P01 cycle measured by
 * i1699-merge-lock-order.int.test.ts. Callers: createSupplierInvoice, createSupplierPayment, createBatch, the bank-line supplier
 * payment (validateBankSupplierPayment), PO create / import / edit, supplier credit notes and returns, the AP take-on
 * and the Sage bill import. Known residual, accepted: a writer that locks SEVERAL suppliers one at a time (a batch import, a payment
 * batch takes them in id order) and a merge of two of them can meet in opposite orders; Postgres ends one with 40P01, nothing is
 * written, and the routes answer it 503 + Retry-After (respondIfLockTimeout). Each wait is bounded (withRowLockBudget, 5 s, a typed
 * retryable RowLockTimeoutError), as the merge's own supplier lock is.
 *
 * Both helpers require a request transaction (withAuth / als.run): outside one each statement commits on its own and the lock is
 * released as the SELECT returns, so the caller would believe it is serialised when it is not. They throw instead (as
 * lockCreditNoteForUpdate does). The cron writers (gap scan, expectation engine) take the same lock on their own transaction.
 */
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import type { DbRow } from '@/lib/neon';
import { ROW_LOCK_BUDGET_MS, RowLockTimeoutError, withRowLockBudget } from './rowLockBudget';

/** Shown when a writer's supplier was merged away or deleted after it was chosen (lockSupplierIfLive answered false). */
export const SUPPLIER_NOT_LIVE_REFUSAL = 'This supplier was merged into another supplier or deleted. Choose the supplier again.';

/** How many merges (A into B, B into C, ...) lockLiveSurvivor follows. */
export const MAX_SURVIVOR_HOPS = 10;

const timeout = () => new RowLockTimeoutError('A supplier being merged');

function requireRequestTransaction(fn: string): void {
  if (!als.getStore()?.client) {
    throw new Error(`${fn} requires a request transaction (withAuth / als.run). Outside one, FOR KEY SHARE is released immediately and locks nothing.`);
  }
}

/** True when the supplier is live; it then stays live and unmerged until the caller's transaction ends. */
export async function lockSupplierIfLive(companyId: string, supplierId: string): Promise<boolean> {
  requireRequestTransaction('lockSupplierIfLive');
  // After a wait the row is re-read: a merge that committed meanwhile set deleted_at, and the row no longer qualifies.
  const rows = await withRowLockBudget(async () => (await sql`
    SELECT id FROM suppliers
     WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
       FOR KEY SHARE
  `) as DbRow[], timeout);
  return rows.length > 0;
}

/**
 * The live supplier at the end of `supplierId`'s merge chain, locked FOR KEY SHARE (the row itself when it is live). Null when the
 * chain ends on a row deleted without a survivor, leaves the company, revisits a row or is longer than MAX_SURVIVOR_HOPS.
 */
export async function lockLiveSurvivor(companyId: string, supplierId: string): Promise<string | null> {
  requireRequestTransaction('lockLiveSurvivor');
  const deadline = Date.now() + ROW_LOCK_BUDGET_MS;
  const seen = new Set<string>();
  let id = supplierId;
  for (let hop = 0; hop <= MAX_SURVIVOR_HOPS && !seen.has(id); hop++) {
    seen.add(id);
    const rows = await withRowLockBudget(async () => (await sql`
      SELECT deleted_at IS NULL AS live, merged_into_id::TEXT AS merged_into_id FROM suppliers
       WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
         FOR KEY SHARE
    `) as DbRow[], timeout, { deadline });
    const row = rows[0];
    if (!row) return null;
    if (row.live === true) return id;
    if (row.merged_into_id == null) return null;
    id = String(row.merged_into_id);
  }
  return null;
}

/**
 * The supplier of a bill, peeked unlocked, then locked live (lockSupplierIfLive): for a writer that learns its payee only from the
 * bills it settles (the bank-line supplier payment) and must still take the supplier before the bills. Null: the bill is not this
 * company's (the caller's own lookup then refuses it). The caller re-checks that the bills it then locks are this supplier's.
 */
export async function lockPayeeOfBill(companyId: string, billId: string): Promise<{ supplierId: string; live: boolean } | null> {
  const rows = (await sql`
    SELECT supplier_id::TEXT AS supplier_id FROM supplier_invoices
     WHERE id = ${billId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!rows[0]?.supplier_id) return null;
  const supplierId = String(rows[0].supplier_id);
  return { supplierId, live: await lockSupplierIfLive(companyId, supplierId) };
}

/** Whether the supplier is live, for a caller that already holds its row locked (a refund's FOR UPDATE): a plain read, no lock. */
export async function isSupplierLive(companyId: string, supplierId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
  `) as DbRow[];
  return rows.length > 0;
}
