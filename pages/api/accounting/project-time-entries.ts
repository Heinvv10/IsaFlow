/**
 * Project Time Entries API
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { mayReadPayroll } from '@/lib/auth/payrollReadGate';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateTimeEntry, calculateBillableAmount } from '@/modules/accounting/services/reports/projectAccountingService';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;
  if (req.method === 'GET') {
    const { projectId, employeeId } = req.query;
    // census-exempt(sql): joins payroll_employees for first / last NAME only; the entry's rate and billable amount (a person's pay
    // rate) are stripped below for anyone without Payroll read
    let rows: Row[];
    if (projectId) {
      rows = await sql`SELECT t.*, e.first_name, e.last_name, p.name as project_name FROM project_time_entries t LEFT JOIN payroll_employees e ON t.employee_id = e.id LEFT JOIN projects p ON t.project_id = p.id WHERE t.project_id = ${String(projectId)} AND t.company_id = ${companyId}::UUID ORDER BY t.entry_date DESC LIMIT 200` as Row[];
    } else if (employeeId) {
      rows = await sql`SELECT t.*, p.name as project_name FROM project_time_entries t LEFT JOIN projects p ON t.project_id = p.id WHERE t.employee_id = ${String(employeeId)} AND t.company_id = ${companyId}::UUID ORDER BY t.entry_date DESC LIMIT 200` as Row[];
    } else {
      rows = await sql`SELECT t.*, e.first_name, e.last_name, p.name as project_name FROM project_time_entries t LEFT JOIN payroll_employees e ON t.employee_id = e.id LEFT JOIN projects p ON t.project_id = p.id WHERE t.company_id = ${companyId}::UUID ORDER BY t.entry_date DESC LIMIT 200` as Row[];
    }
    // The rate an hour is charged at, and hours x rate, are one person's pay: Payroll's, not every project writer's (#1656, round 7).
    if (!(await mayReadPayroll(companyId, user.id))) rows = rows.map(({ hourly_rate: _rate, billable_amount: _amount, ...rest }) => rest);
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const body = req.body;
    const validation = validateTimeEntry(body);
    if (!validation.success) return apiResponse.validationError(res, Object.fromEntries((validation.errors || []).map(e => [e.field, e.message])));

    const billableAmount = body.billable ? calculateBillableAmount(body.hours, body.hourlyRate || 0) : 0;

    // Verify project belongs to this company
    const projCheck = await sql`SELECT id FROM projects WHERE id = ${body.projectId}::UUID AND company_id = ${companyId}::UUID` as Row[];
    if (!projCheck[0]) return apiResponse.badRequest(res, 'Project not found in this company');

    const inserted = await sql`
      INSERT INTO project_time_entries (company_id, project_id, task_id, employee_id, entry_date, hours, hourly_rate, billable_amount, description, is_billable, created_by)
      VALUES (${companyId}::UUID, ${body.projectId}, ${body.taskId || null}, ${body.employeeId}, ${body.date}, ${body.hours}, ${body.hourlyRate || 0}, ${billableAmount}, ${body.description}, ${body.billable ?? true}, ${String(req.user.id)})
      RETURNING *
    ` as Row[];

    log.info('Time entry created', { projectId: body.projectId, hours: body.hours }, 'accounting');
    return apiResponse.created(res, inserted[0]);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
