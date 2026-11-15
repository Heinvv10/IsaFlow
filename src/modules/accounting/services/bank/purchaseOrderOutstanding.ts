/**
 * What is still OUTSTANDING on a purchase order, and which orders may be paid at all — the ONE rule the PO match picker
 * (`fetchPurchaseOrderCandidates`) and the confirm (`confirmPurchaseOrderMatch`) both read, so the picker never offers
 * an order the confirm refuses (audit row 8).
 *
 * A purchase order has no paid-to-date column. The statement lines confirmed against it are the record: each carries
 * `bank_transactions.linked_po_id`, set only by the confirm after `allocateTransaction` (so only on a posted feed row),
 * and cleared by the Reverse (`resetBankLine`) and the auto-post undo. Outstanding = `total` less the absolute amount of
 * every such line still `allocated`/`reconciled`.
 */
import { sql } from '@/lib/neon';

/** An order that was approved, whatever it has received since. Draft, submitted and cancelled orders are not paid. */
export const PAYABLE_PO_STATUSES: readonly string[] = ['approved', 'partially_received', 'received'];

/**
 * The outstanding amount of the purchase order aliased `po` (it must expose `id`, `company_id`, `total`), as a NUMERIC
 * SQL expression. `excludeBankTxId` leaves that statement line out of the sum (the confirm's own line); NULL counts all.
 *
 * Read it in a statement issued AFTER the order is locked: a select-list subquery runs on the statement's snapshot, so
 * inside the `FOR UPDATE` statement itself it would miss a peer's link committed while that statement waited.
 */
export function purchaseOrderOutstandingSql(excludeBankTxId: string | null) {
  return sql.unsafe(
    `(COALESCE(po.total, 0) - COALESCE((SELECT SUM(ABS(b.amount)) FROM bank_transactions b
        WHERE b.company_id = po.company_id AND b.linked_po_id = po.id
          AND b.status IN ('allocated', 'reconciled') AND b.id IS DISTINCT FROM $1::UUID), 0))`,
    [excludeBankTxId],
  );
}
