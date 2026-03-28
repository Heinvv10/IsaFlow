/**
 * Leave Balances API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { employeeId, year } = req.query;
  const yr = year ? Number(year) : new Date().getFullYear();
  if (employeeId) {
    const rows = await sql`SELECT lb.*, lt.name as leave_type_name FROM leave_balances lb JOIN leave_types lt ON lb.leave_type_id = lt.id WHERE lb.employee_id = ${String(employeeId)} AND lb.year = ${yr} ORDER BY lt.name` as Row[];
    return apiResponse.success(res, rows);
  }
  const rows = await sql`SELECT lb.*, lt.name as leave_type_name, e.first_name, e.last_name FROM leave_balances lb JOIN leave_types lt ON lb.leave_type_id = lt.id JOIN employees e ON lb.employee_id = e.id WHERE lb.year = ${yr} ORDER BY e.last_name, lt.name` as Row[];
  return apiResponse.success(res, rows);
}
export default withCompany(withErrorHandler(handler as any));
