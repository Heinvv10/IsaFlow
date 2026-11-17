/**
 * GET /api/payroll/settings/pay-week  { payWeekStartDow, payWeekday, fortnightAnchor, locked: { week, anchor } }
 *                                      write roles (owner / admin / manager)
 * PUT /api/payroll/settings/pay-week  { payWeekStartDow, payWeekday, fortnightAnchor|null }
 *                                      owner / admin, own session, never Login-as
 *
 * The company's pay week for weekly and fortnightly runs (wave 6 FQd; grill F17; payrollPayWeekSettings). Day numbers
 * are ISO (1 = Monday). Judged whole before any write (400); a change to a setting fixed by a final weekly or
 * fortnightly run this tax year is 409 PAY_WEEK_LOCKED with nothing written. Each change is audited.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { payslipEmailActor } from '@/lib/payslipEmailApi';
import { judgePayWeekSettings, RunPeriodRefused, type PayWeekSettings } from '@/modules/accounting/services/payroll/payrollPayWeek';
import { PayWeekLockedError, readPayWeekState, setPayWeekSettings } from '@/modules/accounting/services/payroll/payrollPayWeekSettings';

const KEYS = ['payWeekStartDow', 'payWeekday', 'fortnightAnchor'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  if (req.method === 'GET') return apiResponse.success(res, await readPayWeekState(companyId));
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
  if (!['owner', 'admin'].includes(companyRole)) {
    return apiResponse.forbidden(res, 'Only an owner or admin can change the pay week.');
  }
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Object.keys(body).some((k) => !KEYS.includes(k)) || KEYS.some((k) => !(k in body))) {
    return apiResponse.badRequest(res, 'The body is { payWeekStartDow, payWeekday, fortnightAnchor } only');
  }
  let next: PayWeekSettings;
  try {
    next = judgePayWeekSettings({ payWeekStartDow: body.payWeekStartDow, payWeekday: body.payWeekday, fortnightAnchor: body.fortnightAnchor });
  } catch (err) {
    if (err instanceof RunPeriodRefused) return apiResponse.badRequest(res, err.message);
    throw err;
  }
  const actor = await payslipEmailActor(req, res);
  if (!actor) return;
  try {
    return apiResponse.success(res, await setPayWeekSettings(companyId, next, actor));
  } catch (err) {
    if (err instanceof PayWeekLockedError) return apiResponse.conflict(res, err.message, { reason: err.code });
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
