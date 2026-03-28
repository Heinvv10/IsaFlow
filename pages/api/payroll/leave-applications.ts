/**
 * Leave Applications API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateLeaveApplication } from '@/modules/accounting/services/leaveService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const { employeeId, status } = req.query;
    let rows: Row[];
    if (employeeId) {
      rows = await sql`SELECT la.*, e.first_name, e.last_name, lt.name as leave_type_name FROM leave_applications la JOIN employees e ON la.employee_id = e.id JOIN leave_types lt ON la.leave_type_id = lt.id WHERE la.employee_id = ${String(employeeId)} ORDER BY la.start_date DESC` as Row[];
    } else if (status) {
      rows = await sql`SELECT la.*, e.first_name, e.last_name, lt.name as leave_type_name FROM leave_applications la JOIN employees e ON la.employee_id = e.id JOIN leave_types lt ON la.leave_type_id = lt.id WHERE la.status = ${String(status)} ORDER BY la.start_date DESC` as Row[];
    } else {
      rows = await sql`SELECT la.*, e.first_name, e.last_name, lt.name as leave_type_name FROM leave_applications la JOIN employees e ON la.employee_id = e.id JOIN leave_types lt ON la.leave_type_id = lt.id ORDER BY la.created_at DESC LIMIT 200` as Row[];
    }
    return apiResponse.success(res, rows);
  }
  if (req.method === 'POST') {
    const body = req.body;
    // Get leave balance for validation
    const balances = await sql`SELECT closing_balance FROM leave_balances WHERE employee_id = ${body.employeeId} AND leave_type_code = ${body.leaveType} AND year = EXTRACT(YEAR FROM CURRENT_DATE) LIMIT 1` as Row[];
    const available = Number(balances[0]?.closing_balance ?? 0);
    const validation = validateLeaveApplication({ ...body, availableBalance: available });
    if (!validation.success) return apiResponse.validationError(res, Object.fromEntries((validation.errors || []).map(e => [e.field, e.message])));
    // Get leave type ID
    const types = await sql`SELECT id FROM leave_types WHERE code = ${body.leaveType} LIMIT 1` as Row[];
    if (!types[0]) return apiResponse.badRequest(res, 'Invalid leave type');
    const inserted = await sql`
      INSERT INTO leave_applications (employee_id, leave_type_id, leave_type_code, start_date, end_date, days, reason, created_by)
      VALUES (${body.employeeId}, ${String(types[0].id)}, ${body.leaveType}, ${body.startDate}, ${body.endDate}, ${body.days}, ${body.reason || null}, ${String(req.user.id)})
      RETURNING *
    ` as Row[];
    log.info('Leave application created', { employeeId: body.employeeId, type: body.leaveType, days: body.days }, 'payroll');
    return apiResponse.created(res, { ...inserted[0], warnings: validation.warnings });
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}
export default withCompany(withErrorHandler(handler as any));
