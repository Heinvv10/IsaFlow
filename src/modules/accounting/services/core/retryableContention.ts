/**
 * One predicate for "a peer held the row; nothing was written; retry".
 *
 * The four routes that reach a settlement service through a NARROW call — 
 * `bank-match-confirm`, `ar/receipt-match/confirm`, `customer-allocations`,
 * `supplier-allocations` — each know which one or two of these events their own
 * call can raise, and classify on exactly those. The routes this file exists
 * for are the opposite shape: `bank-transactions-action` dispatches nine verbs
 * into `bankReconciliationService`, and `allocateTransaction` reaches
 * `planSupplierPaymentApplication` and `planReceiptApplication` THROUGH
 * `recordSupplierBankPayment` / `autoApplyCustomerReceipt`. A census of the
 * files that import the plan functions does not see those routes at all, which
 * is how they kept answering 400 for eight rounds while their siblings answered
 * 409 for the identical instant of contention.
 *
 * So a route that catches everything gets the UNION, not a guess at which
 * subset its verb can raise.
 *
 * Every member is raised by a lock that was NEVER ACQUIRED — the two lock
 * timeouts by the `FOR UPDATE` itself, the two `retryable` refusals by
 * `fetch{Invoice,Bill}Candidates` in the plan phase, before `apply*` writes.
 * That makes the event pre-write for THE CALL THAT RAISED IT, and for nothing
 * else. It is NOT a property of the request. `withAuth` COMMITs every 4xx, and
 * whether a 409 on this is safe depends on the shape in which it surfaces:
 *
 *   1. ABORTED — raised on the request transaction itself. 55P03/40P01 abort
 *      it, the COMMIT degrades to a rollback, and nothing survives however
 *      much the request wrote first (`bank-transactions-action` →
 *      `reverseReconciledTransaction`, whose bank-line lock precedes its own
 *      savepoint).
 *   2. CONFINED — raised inside a `withSavepoint` whose ROLLBACK TO succeeded.
 *      The request transaction is LIVE, and everything written before that
 *      savepoint COMMITs behind the 4xx. Safe only when nothing was written
 *      before it — true of the four action routes' verbs; false of a loop that
 *      has already posted earlier items. `applyRules` re-threw a held bill on
 *      line B after posting line A: 400, line A committed (K-071 r14).
 *
 * So: "pre-write, OR confined to a savepoint that rolled back" — and a caller
 * MUST establish which before it answers 409. A loop over savepointed items
 * should not re-throw at all: it skips and counts every member, as `applyRules`
 * does — or re-throws only when no item was written, as `undoRun` does.
 *
 * NOT included: `PaymentPostedDuringVoidError`. It is equally retryable, but it
 * is raised only by `voidPaymentDocument`, which no HTTP route reaches —
 * `voidSupplierPayment` names it in a comment and does not call it. Adding an
 * unreachable arm would make this predicate untestable at the routes.
 */

import { isBankTransactionLockTimeout } from '../bank/bankTxLock';
import { isPaymentLockTimeout } from './paymentLock';
import { isRetryableReceiptRefusal } from '../ar/receiptRefusal';
import { isRetryableSupplierPaymentRefusal } from '../ap/supplierPaymentRefusal';

/**
 * TRUE for every contention event a bank- or payment-action route can catch.
 * Answer it `apiResponse.conflict` and keep the service's wording — each member
 * already ends in "retry in a moment", which is the remedy the caller needs.
 */
export function isRetryableContention(err: unknown): boolean {
  return isBankTransactionLockTimeout(err)
    || isPaymentLockTimeout(err)
    || isRetryableReceiptRefusal(err)
    || isRetryableSupplierPaymentRefusal(err);
}
