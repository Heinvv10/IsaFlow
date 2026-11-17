/**
 * Payroll Runs API
 * GET  /api/payroll/runs  - List payroll runs (totals only; any member)
 * POST /api/payroll/runs  - Create a new payroll run (write roles only):
 *        { month, year }                                    a monthly run for the calendar month;
 *        { frequency: 'weekly'|'fortnightly', periodStart }  a regular run for the pay-week period starting then
 *                                                           (wave 6 FQd; 400 when it is not one, 409 duplicate/overlap).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listPayrollRuns,
  createPayrollRun,
  PayrollRunDuplicateError,
} from '@/modules/accounting/services/payroll/payrollRunService';
import { createPeriodRun, PayrollRunOverlapError } from '@/modules/accounting/services/payroll/payrollRunCreatePeriod';
import { RunPeriodRefused } from '@/modules/accounting/services/payroll/payrollPayWeek';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse
): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const runs = await listPayrollRuns(companyId);
    return apiResponse.success(res, runs);
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.frequency !== undefined && body.frequency !== 'monthly') {
      return createForPeriod(req, res, companyId, body);
    }
    const { month, year } = body;
    const monthNum = Number(month);
    const yearNum = Number(year);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      return apiResponse.badRequest(res, 'month must be an integer between 1 and 12');
    }
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return apiResponse.badRequest(res, 'year must be a 4-digit fiscal year');
    }

    const userId = (req as CompanyAuthedRequest).user?.id;
    try {
      const run = await createPayrollRun(
        companyId,
        { month: monthNum, year: yearNum },
        userId,
      );
      return apiResponse.created(res, run);
    } catch (err) {
      if (err instanceof PayrollRunDuplicateError) {
        return apiResponse.conflict(res, err.message, { month: err.month, year: err.year });
      }
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

async function createForPeriod(
  req: AuthenticatedNextApiRequest, res: NextApiResponse, companyId: string, body: Record<string, unknown>,
): Promise<void> {
  const { frequency, periodStart } = body;
  if (frequency !== 'weekly' && frequency !== 'fortnightly') {
    return apiResponse.badRequest(res, "frequency must be 'monthly', 'weekly' or 'fortnightly'");
  }
  if (Object.keys(body).some((k) => k !== 'frequency' && k !== 'periodStart')) {
    return apiResponse.badRequest(res, 'A weekly or fortnightly run takes { frequency, periodStart } only');
  }
  try {
    const run = await createPeriodRun(companyId, frequency, periodStart, (req as CompanyAuthedRequest).user?.id);
    return apiResponse.created(res, run);
  } catch (err) {
    if (err instanceof RunPeriodRefused) return apiResponse.badRequest(res, err.message);
    if (err instanceof PayrollRunDuplicateError) return apiResponse.conflict(res, err.message, { reason: 'PAY_PERIOD_EXISTS' });
    if (err instanceof PayrollRunOverlapError) return apiResponse.conflict(res, err.message, { reason: err.code });
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
