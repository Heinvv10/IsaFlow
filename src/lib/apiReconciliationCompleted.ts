/**
 * D12: the ONE route answer for a write refused because it would change a COMPLETED bank reconciliation —
 * `ReconciliationCompletedError` (`bank/reconciliationSessionLock.ts`), 409 with its own "is completed — reopen it
 * first" wording. A 4xx is safe only because every raise site decides it before the request's first write (`withAuth`
 * COMMITs below 500). `respondToUnhandledError` asks it too, so a route that rethrows answers the same 409; a route
 * with a blanket catch must ask it before its own 4xx.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { isReconciliationCompleted } from '@/modules/accounting/services/bank/reconciliationSessionLock';

export function respondIfReconciliationCompleted(res: NextApiResponse, err: unknown): boolean {
  if (!isReconciliationCompleted(err)) return false;
  apiResponse.conflict(res, err.message, { code: err.code });
  return true;
}
