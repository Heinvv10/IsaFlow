/**
 * Wave 6 FQa: the ONE route answer for a pay run this release cannot handle (`RunKindUnsupportedError`,
 * payroll/payrollRunKindGuard): 409 RUN_KIND_UNSUPPORTED with the guard's reasons. A 4xx is safe because the guard
 * runs before its caller's first write (`withAuth` COMMITs below 500). `respondToUnhandledError` asks it, so every
 * route that rethrows answers the same 409. A run not found (PayrollRunNotFoundError, wave 6 FQd) answers 404 here too.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { isRunKindUnsupported } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import { isPayFrequencyRefused } from '@/modules/accounting/services/payroll/payrollFrequencyGuard';
import { PayrollRunNotFoundError } from '@/modules/accounting/services/payroll/payrollRunLock';

export function respondIfRunKindUnsupported(res: NextApiResponse, err: unknown): boolean {
  // Wave 6 FQd: a run that is not this company's, or a draft deleted since the page was opened (a stale link, an open
  // tab, a request that waited on its lock): 404, raised before any write.
  if (err instanceof PayrollRunNotFoundError) {
    apiResponse.notFound(res, 'Payroll run');
    return true;
  }
  // Wave 6 FQc (payrollFrequencyGuard): 400 for terms a weekly run cannot cost, 409 for the month or a mid-year change.
  if (isPayFrequencyRefused(err)) {
    const send = err.status === 400 ? apiResponse.badRequest : apiResponse.conflict;
    send(res, err.message, { code: err.code, reasons: err.reasons });
    return true;
  }
  if (!isRunKindUnsupported(err)) return false;
  apiResponse.conflict(res, err.message, { code: err.code, action: err.action, reasons: err.reasons });
  return true;
}
