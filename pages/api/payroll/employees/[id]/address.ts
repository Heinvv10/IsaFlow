/**
 * GET /api/payroll/employees/[id]/address — the employee's residential and postal address, or null (wave 7 EA1, W5).
 * PUT — capture or change it: { residential: {...}, postal: { sameAsResidential: true } | { sameAsResidential: false,
 *     line1, line2?, line3?, line4?, postalCode?, countryCode } }, checked against the SARS BRS V25.3.0 rules for codes
 *     3211-3217, 3285 and 3288-3294 (payrollEmployeeAddressInput.ts); 422 with field errors, written nothing.
 * Who: owner / admin / manager with Payroll read (GET) or write (PUT) (withPayrollDetailAccess), a person in their own
 *     session only: Login-as is 403 IMPERSONATION_FORBIDDEN, a token 403 AGENT_FORBIDDEN. The employee portal shows
 *     the address read-only; there is no self-service edit (Hein's ruling 10).
 * Every refusal is raised before any write. The request log holds none of the body (logBodyFields: []): every field
 *     is personal information. History: GET /api/accounting/entity-changes, type payroll_employee (masked).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { withPayrollModule } from '@/lib/auth/withPayrollModule';
import { requireUuidParam } from '@/lib/schemas/common';
import { assertHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import { getEmployeeAddress, setEmployeeAddress } from '@/modules/accounting/services/payroll/payrollEmployeeAddress';
import { parseEmployeeAddress } from '@/modules/accounting/services/payroll/payrollEmployeeAddressInput';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const employeeId = requireUuidParam(req, res, 'id');
  if (!employeeId) return;
  try {
    await assertHumanSession('read or change an employee\'s address');
  } catch (err) {
    if (respondIfBankControlRefused(res, err)) return;
    throw err;
  }
  if (req.method === 'GET') {
    const address = await getEmployeeAddress(companyId, employeeId);
    return address === undefined ? apiResponse.notFound(res, 'Employee') : apiResponse.success(res, address);
  }
  const parsed = parseEmployeeAddress(req.body);
  if (!parsed.ok) return apiResponse.validationError(res, parsed.fieldErrors);
  const stored = await setEmployeeAddress(companyId, employeeId, parsed.address);
  return stored === undefined ? apiResponse.notFound(res, 'Employee') : apiResponse.success(res, stored);
}

export default withAuth(withErrorHandler(withPayrollModule(withCsrf(withPayrollDetailAccess(handler))), { logBodyFields: [] }));
