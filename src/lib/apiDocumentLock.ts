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
import { isHeldRowError, isLockTimeoutError } from '@/lib/lockTimeout';
import { isReceiptHeldRow } from '@/modules/accounting/services/ar/receiptRefusal';
import { isSupplierPaymentHeldRow } from '@/modules/accounting/services/ap/supplierPaymentRefusal';

/**
 * ONE predicate for every row-lock timeout (D8 round 9), `@/lib/lockTimeout`'s since round 11: each class carries a
 * `code` ending in `_LOCK_TIMEOUT` — DOCUMENT_NUMBER_, BANK_TX_, PAYMENT_, JOURNAL_REVERSAL_, ROW_
 * (core/rowLockBudget), CREDIT_NOTE_, … — so a new class is answered without a list to forget it in. The list it
 * replaced missed BankTransactionLockTimeoutError: dismiss's bank-line lock answered 500.
 */
export const NEUTRAL_HELD_MESSAGE = 'Another request is changing this record — retry in a moment.';

/**
 * The text a per-item collector may show for a failed item: a held row shows the typed error's own authored wording, or
 * the neutral message for a raw driver error (SQLSTATE 55P03 / 40P01 — never the driver text); any other error is
 * returned unchanged.
 */
export function itemFailureMessage(err: unknown, fallback: string): string {
  const own = err instanceof Error ? err.message : fallback;
  if (!isHeldRowError(err)) return own;
  const typed = isLockTimeoutError(err) || isCaptureEventLocked(err) || isReceiptHeldRow(err) || isSupplierPaymentHeldRow(err);
  return typed ? own : NEUTRAL_HELD_MESSAGE;
}

export function respondIfLockTimeout(res: NextApiResponse, err: unknown): boolean {
  if (!isHeldRowError(err)) return false;
  // A typed error carries its own retry wording. A raw driver error (SQLSTATE 55P03 / 40P01) must not leak its text
  // ("deadlock detected", relation names), so it gets a neutral message.
  if (isLockTimeoutError(err)) respondRowHeld(res, err.message, err.code);
  else if (isCaptureEventLocked(err)) respondRowHeld(res, (err as Error).message, 'CAPTURE_EVENT_LOCKED');
  else if (isReceiptHeldRow(err) || isSupplierPaymentHeldRow(err)) respondRowHeld(res, (err as Error).message, 'ROW_LOCK_TIMEOUT');
  else respondRowHeld(res, NEUTRAL_HELD_MESSAGE, 'ROW_LOCK_TIMEOUT');
  return true;
}

const isCaptureEventLocked = (err: unknown): boolean =>
  err instanceof Error && (err as { code?: unknown }).code === 'CAPTURE_EVENT_LOCKED';

/**
 * The same 503 + Retry-After for a service that reports a held row as a RESULT rather than a throw (D8 round 18: the
 * manual evidence attach's `contended`). A held row is a lock timeout, never a 409.
 */
export function respondRowHeld(res: NextApiResponse, message: string, code: string): void {
  res.setHeader('Retry-After', '2');
  apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, message, { code });
}
