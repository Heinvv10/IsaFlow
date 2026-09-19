/**
 * Which throws `bank-match-confirm` may answer with a 4xx, and with which one.
 *
 * ── WHY THIS IS A CORRECTNESS RULE, NOT PRESENTATION ────────────────────────
 *
 * `withAuth` decides COMMIT vs ROLLBACK on `statusCode >= 500`. So the status
 * this returns is the transaction's fate:
 *
 *   · a refusal decided BEFORE the route's first write must be 4xx. Nothing has
 *     been written, the commit is a no-op, and the message was authored for the
 *     person who triggered it — `internalError` would replace it with "An
 *     internal error occurred" and take the remedy with it.
 *   · everything else must be 500. By then `allocateTransaction` has posted a
 *     journal, touched `bank_transactions` and may have written a payment
 *     document, and answering 4xx COMMITs exactly the half-finished match the
 *     route exists to avoid leaving behind.
 *
 * So the default is NULL — "not classified, let the caller answer 500". A
 * refusal is added here only by someone who can show it is decided before the
 * first write.
 *
 * Split out of the route for the 300-line cap, and it earns the file: the list
 * is the whole rule, `tests/unit/api/bankMatchConfirmRefusalStatus.test.ts`
 * pins every member to its status, and the route is left with the branching it
 * is actually about.
 */

import { isRetryableContention } from '../core/retryableContention';
import { isFeedNotPostedRefusal } from './bankFeedStateGuard';
import { isBankAllocationRefusal } from './bankAllocationRefusal';
import { isSupplierRefundRefusal } from '../ap/supplierRefundDocument';

export interface BankMatchRefusal {
  status: 409 | 400;
  message: string;
  /** True for the one case worth an info log rather than silence. */
  contended: boolean;
}

/**
 * The 4xx answer for a pre-write refusal, or `null` when the throw is not one.
 */
export function classifyBankMatchRefusal(err: unknown): BankMatchRefusal | null {
  const message = err instanceof Error ? err.message : '';

  // CONTENTION first, and 409 — the status this codebase gives "a peer holds
  // the row, retry". The ordinary case is a UI double-click and the message is
  // written to be read by whoever double-clicked.
  //
  // `isRetryableContention`, not `isBankTransactionLockTimeout`, and this is
  // wider than the route used to be. The narrow predicate saw only the BANK
  // LINE's lock, so every other pre-write contention on this path reached the
  // 500 fallback: the payment lock `confirmSupplierInvoiceMatch` already takes
  // through `planSupplierPaymentApplication`, and the CONTACT lock the refund
  // ceiling takes. `bank-transactions-action` has answered the same set 409 for
  // exactly this reason, and its comment already claimed this route agreed.
  if (isRetryableContention(err)) return { status: 409, message, contended: true };

  // A pending/removed feed row — bare from `matchTransaction`, or wrapped by
  // `allocateTransaction` — refused from the locked row before any write.
  if (isFeedNotPostedRefusal(err)) return { status: 409, message, contended: false };

  // `allocateTransaction`'s own two, both decided from the row it has just
  // locked and before it writes.
  if (isBankAllocationRefusal(err)) return { status: 400, message, contended: false };

  // A refund larger than the contact's on-account credit. Both refund planners
  // run the whole check before `createJournalEntry`, so nothing is written when
  // this arrives.
  //
  // It was reaching the fallback, and the user saw "An internal error occurred"
  // for a refusal whose message names the supplier, both amounts and what to do
  // instead. ONE class covers both sides — `ar/customerRefundDocument` raises
  // the same one deliberately — so a route cannot answer one side correctly and
  // forget the other.
  if (isSupplierRefundRefusal(err)) return { status: 400, message, contended: false };

  return null;
}
