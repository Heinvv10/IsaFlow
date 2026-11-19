/**
 * GET /api/employee-portal/irp5: the signed-in employee's own IRP5 certificates, one per FILED EMP501 version
 * (wave 6 SS-c; employeePortalIrp5.listOwnCertificates), and their pay frequency (weekly and fortnightly pay has no
 * certificate here yet). Read-only. 401 without a portal session. No-store.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withEmployeePortalAuth, type EmployeePortalRequest } from '@/lib/auth/employeePortalAuth';
import { listOwnCertificates } from '@/modules/accounting/services/payroll/employeePortalIrp5';

async function handler(req: EmployeePortalRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, employeeId } = req.employeePortal;
  return apiResponse.success(res, await listOwnCertificates(companyId, employeeId));
}

export default withErrorHandler(withEmployeePortalAuth(handler));
