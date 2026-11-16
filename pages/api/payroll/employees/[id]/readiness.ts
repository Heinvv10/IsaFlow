/**
 * GET /api/payroll/employees/[id]/readiness: { bank, runs, hasFinalRun } for the profile's "Ready to pay" card in
 * one read (wave 6 UXR), in place of the bank-details, runs and has-final-run reads. No figure and no account number
 * leaves it. Payroll-detail roles only; another company's employee is 404; human sessions only (as the bank read);
 * no-store; rate-limited per user.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { requireUuidParam } from '@/lib/schemas/common';
import { assertHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import { readEmployeeReadiness } from '@/modules/accounting/services/payroll/employeeReadinessRead';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const employeeId = requireUuidParam(req, res, 'id');
  if (!employeeId) return;
  try {
    await assertHumanSession('read employee readiness');
  } catch (err) {
    if (respondIfBankControlRefused(res, err)) return;
    throw err;
  }
  if (!(await checkReportRateLimit(companyId, `employee-readiness:u:${user.id}`, INTERACTIVE_REPORT_LIMIT))) {
    log.warn('Readiness read rate limit exceeded', { companyId, userId: user.id }, 'employee-readiness');
    return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
  }
  const read = await readEmployeeReadiness(companyId, employeeId);
  if (!read) return apiResponse.notFound(res, 'Employee');
  return apiResponse.success(res, read);
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
