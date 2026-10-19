/**
 * Payroll Run Calculate API
 * POST /api/payroll/runs/[id]/calculate  - Run payroll calculation for a run
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { PayrollRunLockedError } from '@/modules/accounting/services/payroll/payrollRunLock';
import {
  PayrollRunJournalPostedError,
} from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { UnsupportedTaxYearError } from '@/modules/accounting/services/payroll/taxTables';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return apiResponse.badRequest(res, 'Invalid run ID');
  }

  try {
    const summary = await calculatePayrollRun(id, companyId);
    return apiResponse.success(res, summary);
  } catch (err) {
    if (err instanceof PayrollRunLockedError) {
      return apiResponse.badRequest(res, err.message, { lockedStatus: err.status });
    }
    // Both are refusals raised before anything is written, and both messages
    // tell the user what to do next. Without this they reach withErrorHandler
    // as a 500 and the instruction is lost.
    // A held loan row is a lock timeout (D11): 503 + Retry-After, not the 400 of a refusal.
    if (respondIfLockTimeout(res, err)) return;
    if (err instanceof PayrollRunJournalPostedError) {
      return apiResponse.badRequest(res, err.message, { code: err.code });
    }
    // Raised before anything is written; the message says what is missing.
    if (err instanceof UnsupportedTaxYearError) {
      return apiResponse.badRequest(res, err.message, { code: 'UNSUPPORTED_TAX_YEAR', taxYear: err.taxYear });
    }
    throw err;
  }
}

// A viewer must not recalculate a run (W3-01 review): the same roles as approve.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
