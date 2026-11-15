/**
 * The purchase-order arm of a confirmed bank match (`bank-match-confirm`, audit row 8).
 *
 * It used to post the payment and then write `purchase_orders.status = 'paid'` — a value `purchase_orders_status_check`
 * does not allow (draft/submitted/approved/partially_received/received/cancelled). Every PO match therefore died on a
 * 23514 AFTER the journal was posted: a 500, rolled back, and no line could ever be matched to a PO. It also never
 * looked at the amount, so a R5 000 line could "pay" a R500 order.
 *
 * Now the PO's own status is left alone — it tracks ordering and receiving, and nothing in it means "paid". The line
 * is tied to the order through `bank_transactions.linked_po_id`, which the Reverse (`resetBankLine`) and the auto-post
 * undo already clear, so an undone payment frees the order again. The line may not exceed what is still OUTSTANDING
 * on the order: its `total` less every other live (allocated/reconciled) line already linked to it, compared in
 * integer cents. A PO has no paid-to-date column of its own; the linked lines are the record.
 *
 * ORDER, as the supplier arm (`confirmSupplierMatch.ts`): the bank line is locked first (the canonical lock order,
 * bank line -> document), then the order FOR UPDATE — which serialises two lines paying the same order, so the second
 * reads the first's link — and every refusal is decided from those reads, BEFORE `allocateTransaction` writes. A 4xx
 * after a write would COMMIT it (`withAuth`); everything after the first write throws and answers 500.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { formatCents } from '@/lib/money/formatMoney';
import { withRowLockBudget, RowLockTimeoutError } from '../core/rowLockBudget';
import { toCents } from '../ap/billAllocatable';
import { allocateTransaction } from './bankAllocationService';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { refuseLineOfCompletedReconciliation } from './reconciledCash';

export type ConfirmPurchaseOrderMatchOutcome =
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'refused'; message: string }
  | { ok: true };

/** The statuses a payment may be matched against: an order that was approved, whatever it has received since. */
const PAYABLE_PO_STATUSES = new Set(['approved', 'partially_received', 'received']);

/**
 * @param paymentAmount The ABSOLUTE value of the bank line. The route has already refused a line pointing the wrong
 *   way (`signMismatchReason('supplier', …)`), which is why the sign is gone by the time it arrives here.
 */
export async function confirmPurchaseOrderMatch(
  companyId: string, bankTransactionId: string, purchaseOrderId: string, userId: string, paymentAmount: number,
): Promise<ConfirmPurchaseOrderMatchOutcome> {
  // Bank line first. A line in a completed reconciliation is the shared 409, before anything.
  await refuseLineOfCompletedReconciliation(companyId, await lockBankTransactionForUpdate(companyId, bankTransactionId));

  const [po] = await withRowLockBudget(async () => (await sql`
    SELECT id, supplier_id, status, total FROM purchase_orders
    WHERE id = ${purchaseOrderId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE`) as Record<string, unknown>[], () => new RowLockTimeoutError('This purchase order'));
  if (!po) return { ok: false, kind: 'not_found' };

  const status = String(po.status);
  if (!PAYABLE_PO_STATUSES.has(status)) {
    return { ok: false, kind: 'refused', message: `This purchase order is ${status.replace(/_/g, ' ')}. Only an `
      + 'approved order can be paid against — approve it first, or match the line to the supplier\'s invoice.' };
  }

  // What the order has already been paid through other statement lines, read under the order's lock.
  const [paid] = (await sql`
    SELECT COALESCE(SUM(ABS(amount)), 0) AS paid FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND linked_po_id = ${purchaseOrderId}::UUID
      AND id <> ${bankTransactionId}::UUID AND status IN ('allocated', 'reconciled')`) as Record<string, unknown>[];
  const outstandingCents = toCents(Number(po.total ?? 0)) - toCents(Number(paid?.paid ?? 0));
  const lineCents = toCents(paymentAmount);
  if (outstandingCents <= 0) {
    return { ok: false, kind: 'refused', message: 'Nothing is outstanding on this purchase order: earlier statement '
      + 'lines already pay its full total.' };
  }
  if (lineCents > outstandingCents) {
    return { ok: false, kind: 'refused', message: `This line is ${formatCents(lineCents)} but only ${formatCents(outstandingCents)} `
      + `is outstanding on the purchase order. Split the line, or match it to the supplier's invoice instead.` };
  }

  // DR Accounts Payable, CR Bank. `autoApply: 'none'`: the user named a purchase order, which is not a bill, so the
  // payment document is created but no unrelated open bill is settled with it (`list_unapplied_payments` reports it).
  await allocateTransaction(
    companyId, bankTransactionId, '', userId, undefined, 'supplier', String(po.supplier_id),
    undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
  );
  // After the first write: a miss here is a fault (500, rolled back), never a 4xx.
  const linked = (await sql`
    UPDATE bank_transactions SET linked_po_id = ${purchaseOrderId}::UUID, updated_at = NOW()
    WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}::UUID AND status = 'allocated'
    RETURNING id`) as Record<string, unknown>[];
  if (linked.length === 0) {
    throw new Error(`Bank transaction ${bankTransactionId} was not allocated by its purchase-order match`);
  }
  log.info('Confirmed match: purchase order', { bankTransactionId, purchaseOrderId }, 'accounting');
  return { ok: true };
}
