/**
 * GET /api/employee-portal/me: the signed-in employee's name and number and the employer's name (wave 6 SS).
 * Read by the session's own ids only. 401 without a valid employee portal session. No-store.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { withEmployeePortalAuth, type EmployeePortalRequest } from '@/lib/auth/employeePortalAuth';

async function handler(req: EmployeePortalRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId, employeeId } = req.employeePortal;
  const row = ((await sql`
    SELECT e.first_name, e.last_name, e.employee_number, c.name AS employer
      FROM payroll_employees e JOIN companies c ON c.id = e.company_id
     WHERE e.id = ${employeeId}::uuid AND e.company_id = ${companyId}::uuid
  `) as Array<Record<string, string>>)[0];
  if (!row) return apiResponse.notFound(res, 'Employee');
  return apiResponse.success(res, {
    employeeName: `${row.first_name} ${row.last_name}`.trim(), employeeNumber: row.employee_number, employer: row.employer,
  });
}

export default withErrorHandler(withEmployeePortalAuth(handler));
