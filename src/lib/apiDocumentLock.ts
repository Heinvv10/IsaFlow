/**
 * Turn a document-numbering / row-lock timeout into a 503 the caller can act on.
 *
 * `DocumentNumberLockTimeoutError`, `TimeEntryLockTimeoutError`,
 * `DocumentClaimLockTimeoutError` and `RecurringTemplateLockTimeoutError` were
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
import { DocumentNumberLockTimeoutError } from '@/modules/accounting/services/core/companySettingsService';
import { TimeEntryLockTimeoutError } from '@/modules/accounting/services/practice/timeEntryLock';
import { DocumentClaimLockTimeoutError } from '@/modules/accounting/services/core/documentClaimLock';
import { RecurringTemplateLockTimeoutError } from '@/modules/accounting/services/core/recurringTemplateLock';

export function respondIfLockTimeout(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof DocumentNumberLockTimeoutError)
    && !(err instanceof TimeEntryLockTimeoutError)
    && !(err instanceof DocumentClaimLockTimeoutError)
    && !(err instanceof RecurringTemplateLockTimeoutError)) {
    return false;
  }
  res.setHeader('Retry-After', '2');
  apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, err.message, { code: err.code });
  return true;
}
