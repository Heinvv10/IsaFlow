/**
 * Month-End Workbench API.
 * GET /api/accounting/month-end-workbench?period=YYYY-MM
 *
 * Returns aggregated close-of-month status for the authenticated company.
 * Read-only — no mutations.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { mayReadPayroll } from '@/lib/auth/payrollReadGate';
import type { UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { getMonthEndWorkbench } from '@/modules/accounting/services/workbench/monthEndWorkbenchService';

function defaultPeriod(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as UserAuthedRequest).user?.id;
  if (!companyId || !userId) return apiResponse.forbidden(res, 'Company context or user identity missing.');
  const requested = typeof req.query.period === 'string' ? req.query.period : '';
  if (requested && !PERIOD_RE.test(requested)) {
    return apiResponse.badRequest(res, 'period must be YYYY-MM');
  }
  const period = requested || defaultPeriod();

  // Let withErrorHandler surface 500 on real failures — only validation
  // errors return 400. The service catches per-card errors internally via
  // Promise.allSettled, so getMonthEndWorkbench only throws for things like
  // a missing companyId or DB connectivity loss, which are 500-class.
  // The payroll card needs Payroll read in THIS company, decided from the database like withPayrollModule does; without it the
  // card is not built and the response says payrollHidden.
  const payrollRead = await mayReadPayroll(companyId, userId);
  // census-exempt(getMonthEndWorkbench, payroll-read): the payroll card is built only for a caller with Payroll read (payrollRead, from mayReadPayroll); every other card is company-level status or totals, no one person's pay
  const workbench = await getMonthEndWorkbench(companyId, period, { payrollRead });
  return apiResponse.success(res, workbench);
}

export default withAuth(withErrorHandler(handler));
