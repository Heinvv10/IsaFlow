/**
 * GET /api/payroll/pre-validation?taxYear=YYYY | ?employeeId=<uuid> | ?runId=<uuid> — wave 6 PV.
 *
 * The IRP5 validation engine over the PAYE tax year to date, for every employee with a final line (or the one
 * employee, or one run's employees with that run's lines counted), returned as issues by employee with the field to
 * fix. Read-only and never a block. Payroll-detail roles only (it names people and their ID/tax-number faults);
 * cookie session only (withAuth takes no bearer token); another company's employee or run is 404; no-store;
 * rate-limited per user. The query is parsed strictly: any other key, a second scope or a malformed value is 400.
 * Refused, before any read, under a platform-admin Login-as session (403 IMPERSONATION_FORBIDDEN, as payslips, bank
 * details and the line explanation refuse payroll detail) and to a session with no GoTrue session id (403
 * AGENT_FORBIDDEN): only a person signed in as themselves sees who has which ID and tax-number faults.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { withNoStore } from '@/lib/auth/withNoStore';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { log } from '@/lib/logger';
import { checkReportRateLimit, INTERACTIVE_REPORT_LIMIT } from '@/lib/rateLimit';
import { preValidateTaxYear } from '@/modules/accounting/services/payroll/preValidationService';
import { parsePreValidationQuery } from '@/modules/accounting/services/payroll/preValidationQuery';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, user } = req as CompanyAuthedRequest;
  if (await currentSessionActor() === 'unknown') {
    return apiResponse.error(res, ErrorCode.FORBIDDEN, 'Only a person signed in as themselves can see IRP5 pre-validation; an agent or a job cannot.',
      { reason: 'AGENT_FORBIDDEN' });
  }
  try {
    await assertNotImpersonating();
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    throw err;
  }
  const scope = parsePreValidationQuery(req.query);
  if (typeof scope === 'string') return apiResponse.badRequest(res, scope);
  if (!(await checkReportRateLimit(companyId, `pre-validation:u:${user.id}`, INTERACTIVE_REPORT_LIMIT))) {
    log.warn('Pre-validation rate limit exceeded', { companyId, userId: user.id }, 'pre-validation');
    return apiResponse.tooManyRequests(res, 'Too many requests. Please try again shortly.');
  }
  const result = await preValidateTaxYear(companyId, scope);
  if (result === null) return apiResponse.notFound(res, scope.runId ? 'Pay run' : 'Employee');
  return apiResponse.success(res, result);
}

export default withAuth(withNoStore(withErrorHandler(withCsrf(withPayrollDetailAccess(handler)))));
