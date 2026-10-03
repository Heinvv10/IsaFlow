/**
 * Turn a document-numbering / row-lock timeout into a 503 the caller can act on.
 *
 * `DocumentNumberLockTimeoutError`, `TimeEntryLockTimeoutError`,
 * `DocumentClaimLockTimeoutError`, `RecurringTemplateLockTimeoutError` and
 * (later) `SystemRoleLockTimeoutError` were
 * typed at the service layer but nothing mapped them, so the user saw the
 * generic 500
 * `withErrorHandler` produces — whose message is masked outright in production —
 * indistinguishable from a real bug and with nothing saying "retry".
 *
 * 503, not a 4xx, and deliberately so: all four are raised from Postgres
 * 55P03, which leaves the request transaction ABORTED. `withAuth` COMMITs on any
 * status below 500 and ROLLBACKs at or above it, so answering 409 here would ask
 * it to commit a transaction that cannot commit. 503 rolls back, carries
 * `Retry-After`, and still tells the caller this is transient.
 *
 * Returns true when it answered, so a route can `if (respondIfLockTimeout(...))
 * return;` inside its catch and rethrow everything else.
 */

import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { isLockTimeoutError } from '@/lib/lockTimeout';
import { isReceiptHeldRow } from '@/modules/accounting/services/ar/receiptRefusal';
import { isSupplierPaymentHeldRow } from '@/modules/accounting/services/ap/supplierPaymentRefusal';

/**
 * ONE predicate for every row-lock timeout (D8 round 9), `@/lib/lockTimeout`'s since round 11: each class carries a
 * `code` ending in `_LOCK_TIMEOUT` — DOCUMENT_NUMBER_, BANK_TX_, PAYMENT_, JOURNAL_REVERSAL_, ROW_
 * (core/rowLockBudget), CREDIT_NOTE_, … — so a new class is answered without a list to forget it in. The list it
 * replaced missed BankTransactionLockTimeoutError: dismiss's bank-line lock answered 500.
 */
export function respondIfLockTimeout(res: NextApiResponse, err: unknown): boolean {
  if (isLockTimeoutError(err)) {
    respondRowHeld(res, err.message, err.code);
    return true;
  }
  // D11: the capture inbox's discard waits on the event row under its own typed error (`CaptureEventLockedError`).
  if (err instanceof Error && (err as { code?: unknown }).code === 'CAPTURE_EVENT_LOCKED') {
    respondRowHeld(res, err.message, 'CAPTURE_EVENT_LOCKED');
    return true;
  }
  // D11: a settlement plan reports a held bill / invoice / provisional as a refusal carrying `held` (the code the
  // typed lock errors would have), not a throw of its own. A `retryable` refusal that is NOT held is a state conflict
  // ("changed while it was being reversed") and falls through to its route's 409.
  if (isReceiptHeldRow(err) || isSupplierPaymentHeldRow(err)) {
    respondRowHeld(res, (err as Error).message, 'ROW_LOCK_TIMEOUT');
    return true;
  }
  return false;
}

/**
 * The same 503 + Retry-After for a service that reports a held row as a RESULT rather than a throw (D8 round 18: the
 * manual evidence attach's `contended`). A held row is a lock timeout, never a 409.
 */
export function respondRowHeld(res: NextApiResponse, message: string, code: string): void {
  res.setHeader('Retry-After', '2');
  apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, message, { code });
}
