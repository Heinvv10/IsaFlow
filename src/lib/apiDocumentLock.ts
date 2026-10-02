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

/**
 * ONE predicate for every row-lock timeout (D8 round 9), `@/lib/lockTimeout`'s since round 11: each class carries a
 * `code` ending in `_LOCK_TIMEOUT` — DOCUMENT_NUMBER_, BANK_TX_, PAYMENT_, JOURNAL_REVERSAL_, ROW_
 * (core/rowLockBudget), CREDIT_NOTE_, … — so a new class is answered without a list to forget it in. The list it
 * replaced missed BankTransactionLockTimeoutError: dismiss's bank-line lock answered 500.
 */
export function respondIfLockTimeout(res: NextApiResponse, err: unknown): boolean {
  if (!isLockTimeoutError(err)) return false;
  res.setHeader('Retry-After', '2');
  apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, err.message, { code: err.code });
  return true;
}
