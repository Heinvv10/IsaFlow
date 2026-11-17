/**
 * Off-cycle payroll runs (wave 6 OC)
 * POST /api/payroll/runs/off-cycle  - Create a bonus or termination run beside a month's approved regular run
 *   body { month, year, reason: 'bonus' | 'termination', runDate: 'YYYY-MM-DD',
 *          employees: [{ employeeId, componentId?, amount? }] }   (write roles only)
 * Every refusal is judged before the first write (payrollOffCycleRun): 400 malformed, 409 not allowed now.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  createOffCycleRun, OffCycleRunRefusedError, type OffCycleEmployeeInput,
} from '@/modules/accounting/services/payroll/payrollOffCycleRun';
import type { OffCycleReason } from '@/modules/accounting/services/payroll/payrollTypesRun';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const { month, year, reason, runDate, employees } = (req.body ?? {}) as Record<string, unknown>;
  const monthNum = Number(month);
  const yearNum = Number(year);
  if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) return apiResponse.badRequest(res, 'month must be an integer between 1 and 12');
  if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) return apiResponse.badRequest(res, 'year must be a 4-digit year');
  if (!Array.isArray(employees)) return apiResponse.badRequest(res, 'employees must be a list');
  try {
    const run = await createOffCycleRun(companyId, {
      period: { month: monthNum, year: yearNum },
      reason: reason as OffCycleReason,
      runDate: runDate as string,
      employees: employees as OffCycleEmployeeInput[],
    }, (req as CompanyAuthedRequest).user?.id ?? null);
    return apiResponse.created(res, run);
  } catch (err) {
    if (err instanceof OffCycleRunRefusedError) {
      return err.status === 400
        ? apiResponse.badRequest(res, err.message, { code: err.code })
        : apiResponse.conflict(res, err.message, { code: err.code });
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
