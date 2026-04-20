/**
 * GET  /api/payroll/employees/[id]/termination — fetch stored termination details + live preview.
 * PUT  /api/payroll/employees/[id]/termination — save termination details.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { getPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import {
  computeTerminationPreview,
  getAnnualLeaveBalance,
  getTerminationDetails,
  setTerminationDetails,
  yearsOfService,
  type TerminationReason,
  type TerminationDetailsInput,
} from '@/modules/accounting/services/payroll/payrollTerminationService';
import { getEmployeeComponents } from '@/modules/accounting/services/payroll/payrollComponentService';

async function hasApprovedSeveranceDirective(companyId: string, employeeId: string, endDateIso: string | null): Promise<boolean> {
  if (!endDateIso) return false;
  const rows = await sql`
    SELECT 1
    FROM   tax_directives
    WHERE  company_id     = ${companyId}::uuid
      AND  employee_id    = ${employeeId}::uuid
      AND  directive_type = 'severance'
      AND  status         = 'approved'
      AND  effective_date <= ${endDateIso}::date
      AND  (expiry_date IS NULL OR expiry_date >= ${endDateIso}::date)
    LIMIT 1
  `;
  return rows.length > 0;
}

const VALID_REASONS: readonly TerminationReason[] = [
  'resignation', 'dismissal', 'retrenchment', 'retirement', 'end_of_contract', 'death',
];

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const employeeId = req.query.id as string;
  if (!employeeId) return apiResponse.badRequest(res, 'Employee id required');

  const employee = await getPayrollEmployee(employeeId, companyId);
  if (!employee) return apiResponse.notFound(res, 'Employee');

  if (req.method === 'GET') {
    const details = await getTerminationDetails(companyId, employeeId);
    const balanceYear = employee.endDate?.getFullYear() ?? new Date().getFullYear();
    const leaveBalance = await getAnnualLeaveBalance(companyId, employeeId, balanceYear);

    const periodDate = employee.endDate ?? new Date();
    const components = await getEmployeeComponents(employeeId, companyId, periodDate);
    const monthlySalary = components
      .filter((c) => c.component.componentType === 'earning')
      .reduce((s, c) => s + c.amount, 0);

    const preview = details?.reason && employee.endDate
      ? computeTerminationPreview({
          monthlySalary,
          unusedLeaveDays: details.includeLeavePayout ? leaveBalance : 0,
          noticePeriodDays: details.noticePeriodDays ?? 0,
          servedNoticeDays: details.servedNoticeDays ?? 0,
          severanceWeeksPerYear: details.severanceWeeksPerYear ?? 0,
          yearsOfService: yearsOfService(
            employee.startDate.toISOString().slice(0, 10),
            employee.endDate.toISOString().slice(0, 10),
          ),
          includeLeavePayout: details.includeLeavePayout,
          reason: details.reason,
        })
      : null;

    const endDateIso = employee.endDate?.toISOString().slice(0, 10) ?? null;
    const directiveApproved = await hasApprovedSeveranceDirective(companyId, employeeId, endDateIso);

    return apiResponse.success(res, {
      details: details ?? {
        reason: null,
        noticePeriodDays: null,
        servedNoticeDays: null,
        severanceWeeksPerYear: null,
        includeLeavePayout: true,
      },
      context: {
        endDate: endDateIso,
        monthlySalary,
        annualLeaveBalance: leaveBalance,
        yearsOfService: employee.endDate
          ? yearsOfService(
              employee.startDate.toISOString().slice(0, 10),
              employee.endDate.toISOString().slice(0, 10),
            )
          : null,
        hasApprovedSeveranceDirective: directiveApproved,
      },
      preview,
    });
  }

  if (req.method === 'PUT') {
    const body = (req.body ?? {}) as Partial<TerminationDetailsInput>;
    if (body.reason !== null && body.reason !== undefined && !VALID_REASONS.includes(body.reason)) {
      return apiResponse.badRequest(res, `reason must be one of: ${VALID_REASONS.join(', ')}`);
    }
    const input: TerminationDetailsInput = {
      reason: body.reason ?? null,
      noticePeriodDays: body.noticePeriodDays ?? null,
      servedNoticeDays: body.servedNoticeDays ?? null,
      severanceWeeksPerYear: body.severanceWeeksPerYear ?? null,
      includeLeavePayout: body.includeLeavePayout ?? true,
    };
    await setTerminationDetails(companyId, employeeId, input);
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
