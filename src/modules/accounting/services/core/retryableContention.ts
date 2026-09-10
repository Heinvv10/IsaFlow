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
 * Every member is pre-write by construction: the two lock timeouts are raised
 * by the `FOR UPDATE` that never acquired the row, and the two `retryable`
 * refusals by `plan*AllocationLines` locking an invoice or a bill — the plan
 * phase writes nothing and returns before `apply*`. That is what makes the 4xx
 * `withAuth` COMMITs safe: there is nothing committed behind it.
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
