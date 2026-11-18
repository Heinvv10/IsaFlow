/**
 * Wave 6 FQa: the ONE route answer for a pay run this release cannot handle (`RunKindUnsupportedError`,
 * payroll/payrollRunKindGuard): 409 RUN_KIND_UNSUPPORTED with the guard's reasons. A 4xx is safe because the guard
 * runs before its caller's first write (`withAuth` COMMITs below 500). `respondToUnhandledError` asks it, so every
 * route that rethrows answers the same 409.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { isRunKindUnsupported } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import { PspComponentRefused, PspStatusChangedSinceApproval } from '@/modules/accounting/services/payroll/pspLineRules';

export function respondIfRunKindUnsupported(res: NextApiResponse, err: unknown): boolean {
  if (!isRunKindUnsupported(err)) return false;
  apiResponse.conflict(res, err.message, { code: err.code, action: err.action, reasons: err.reasons });
  return true;
}

/** Wave 6 PSP: a component a PSP cannot carry, or a reopened month's changed PSP treatment (pspComponentGuard), refused before any write: 409. */
export function respondIfPspComponentRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof PspComponentRefused) && !(err instanceof PspStatusChangedSinceApproval)) return false;
  apiResponse.conflict(res, err.message, { code: err.code });
  return true;
}
