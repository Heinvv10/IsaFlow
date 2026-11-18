/**
 * GET /api/payroll/employees/[id]/pay-frequency  { payFrequency }                        write roles
 * PUT /api/payroll/employees/[id]/pay-frequency  { payFrequency: monthly|weekly|fortnightly }  owner / admin, own session,
 *                                                                                      never Login-as
 *
 * How often the employee is paid (wave 6 FQd; payrollEmployeePayFrequency). Judged before any write: 400 for a value
 * outside the three; 403 for anyone but an owner or admin; what calculate would refuse, answered as calculate's
 * refusal is (respondIfRunKindUnsupported: 400 PAY_FREQUENCY_REFUSED for terms a weekly/fortnightly run cannot cost,
 * 409 PAY_FREQUENCY_REFUSED mid-tax-year, 409 PAY_PERIOD_OVERLAP). Another company's employee is 404.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { respondIfRunKindUnsupported } from '@/lib/apiRunKindUnsupported';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { payslipEmailActor, UUID } from '@/lib/payslipEmailApi';
import { PAY_FREQUENCIES, type PayFrequency } from '@/modules/accounting/services/payroll/payrollTypesRun';
import {
  EmployeePayFrequencyForbidden, readEmployeePayFrequency, setEmployeePayFrequency,
} from '@/modules/accounting/services/payroll/payrollEmployeePayFrequency';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const id = req.query.id;
  if (typeof id !== 'string' || !UUID.test(id)) return apiResponse.badRequest(res, 'id must be a UUID');
  if (req.method === 'GET') {
    const payFrequency = await readEmployeePayFrequency(companyId, id);
    return payFrequency === undefined ? apiResponse.notFound(res, 'PayrollEmployee', id) : apiResponse.success(res, { payFrequency });
  }
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Object.keys(body).length !== 1
    || !(PAY_FREQUENCIES as readonly unknown[]).includes(body.payFrequency)) {
    return apiResponse.badRequest(res, "The body is { payFrequency: 'monthly' | 'weekly' | 'fortnightly' }");
  }
  const actor = await payslipEmailActor(req, res);
  if (!actor) return;
  try {
    const saved = await setEmployeePayFrequency(companyId, id, body.payFrequency as PayFrequency, actor,
      companyRole === 'owner' || companyRole === 'admin');
    return saved ? apiResponse.success(res, saved) : apiResponse.notFound(res, 'PayrollEmployee', id);
  } catch (err) {
    if (err instanceof EmployeePayFrequencyForbidden) return apiResponse.forbidden(res, err.message);
    if (respondIfRunKindUnsupported(res, err)) return;
    if (respondIfLockTimeout(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
