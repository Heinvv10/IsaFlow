/**
 * Edit dates (PATCH /api/payroll/employees/:id/components?aid=…, the Pay Components card): change an assignment's
 * effective_from and effective_to, on an open or an ended row. How a run refused for a manual pro-rata
 * (payrollRecurringProRata) is fixed, e.g. a salary moved to the 1st of next month with the part month assigned as a
 * once-off.
 *
 * In one transaction: the company's payroll-approval lock (as approvePayrollRun takes it, bounded at 5s), so no run is
 * approved while the row changes; then the row FOR UPDATE inside the company. Refused before any write
 * (EmployeeComponentRefused, a 400): a date that is not a calendar date or an end before the start; a voided row; a
 * once-off left open-ended or spanning more than one month; a window overlapping another live row of the same
 * employee and component; a change to what a paid run paid (payrollComponentPaidMonths). An accepted change is
 * written to audit_log (entity payroll_employee_component) with the dates before and after; a failed audit write
 * rolls the change back. False when the id matches no assignment in the company.
 */
import { withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isRealCalendarDate, isUuidParam } from '@/lib/validation';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { EmployeeComponentRefused } from './payrollEmployeeComponentService';
import {
  lockCompanyPayrollForComponentChange, paidPeriodChanged, paidPeriodsOf, periodLabel, windowOf, type AssignmentWindow,
} from './payrollComponentPaidMonths';

export interface ComponentDatesActor { userId: string; userEmail?: string }

function refuseShape(before: AssignmentWindow, after: AssignmentWindow): void {
  if (before.to !== null && before.to < before.from) {
    throw new EmployeeComponentRefused('This assignment was cancelled (its end is before its start) and cannot be edited; assign a new one.');
  }
  if (!after.recurring && after.to === null) {
    throw new EmployeeComponentRefused('A once-off needs an end date: it is paid once, in its own month.');
  }
  if (!after.recurring && after.to !== null && after.to.slice(0, 7) !== after.from.slice(0, 7)) {
    throw new EmployeeComponentRefused('A once-off must start and end in one month: it is paid once, in that month.');
  }
}

export async function updateEmployeeComponentDates(
  companyId: string,
  assignmentId: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  actor: ComponentDatesActor,
): Promise<boolean> {
  if (!isRealCalendarDate(effectiveFrom)) throw new EmployeeComponentRefused('effectiveFrom must be a real date (YYYY-MM-DD)');
  if (effectiveTo !== null && !isRealCalendarDate(effectiveTo)) {
    throw new EmployeeComponentRefused('effectiveTo must be a real date (YYYY-MM-DD), or empty for open-ended');
  }
  if (effectiveTo !== null && effectiveTo < effectiveFrom) throw new EmployeeComponentRefused('effectiveTo cannot be before effectiveFrom');
  if (!isUuidParam(assignmentId)) return false;

  return withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);

    const rows = (await tx`
      SELECT pec.id, pec.employee_id, pec.component_id, pec.effective_from, pec.effective_to, pec.is_recurring
      FROM payroll_employee_components pec
      JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
      WHERE pec.id = ${assignmentId}::uuid
      FOR UPDATE OF pec
    `) as DbRow[];
    const row = rows[0];
    if (!row) return false;
    const before = windowOf(row);
    const after: AssignmentWindow = { from: effectiveFrom, to: effectiveTo, recurring: before.recurring };
    refuseShape(before, after);

    const overlap = (await tx`
      SELECT to_char(effective_from, 'YYYY-MM-DD') AS f, to_char(effective_to, 'YYYY-MM-DD') AS t
      FROM payroll_employee_components
      WHERE employee_id = ${row.employee_id}::uuid AND component_id = ${row.component_id}::uuid AND id <> ${assignmentId}::uuid
        AND (effective_to IS NULL OR effective_to >= effective_from)
        AND effective_from <= COALESCE(${effectiveTo}::date, 'infinity'::date)
        AND (effective_to IS NULL OR effective_to >= ${effectiveFrom}::date)
      ORDER BY effective_from LIMIT 1
    `) as DbRow[];
    if (overlap[0]) {
      throw new EmployeeComponentRefused(
        `These dates overlap the employee's other assignment of this component (${overlap[0].f} to ${overlap[0].t ?? 'open-ended'}): `
        + 'both would be paid. Change or end that one first.');
    }

    const changed = paidPeriodChanged(await paidPeriodsOf(tx, companyId, String(row.employee_id)), before, after);
    if (changed) {
      throw new EmployeeComponentRefused(
        `${periodLabel(changed)} is already paid (approved run) and these dates change what it paid. `
        + 'Reopen that run first, or capture the correction in an open period.');
    }

    await tx`
      UPDATE payroll_employee_components
      SET effective_from = ${effectiveFrom}::date, effective_to = ${effectiveTo}::date
      WHERE id = ${assignmentId}::uuid
    `;
    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update',
      entityType: 'payroll_employee_component', entityId: assignmentId,
      changes: { fields: [
        { field: 'effective_from', old: before.from, new: effectiveFrom, label: 'Effective from' },
        { field: 'effective_to', old: before.to, new: effectiveTo, label: 'Effective to' },
      ] },
    });
    log.info('Edited employee component dates', { companyId, assignmentId, before, effectiveFrom, effectiveTo }, 'payrollComponentDateEdit');
    return true;
  });
}
