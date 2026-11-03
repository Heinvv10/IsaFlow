import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isUuidParam } from '@/lib/validation';
import { endOfMonthIso } from './leaveAccrualService';
import { changeAssignmentDates } from './payrollComponentDateEdit';
import { auditComponentChange, type ComponentChangeActor } from './payrollComponentAudit';
import { lockCompanyPayrollForComponentChange } from './payrollComponentPaidMonths';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { refuseOnceOffSpan } from './payrollOnceOffGuard';
import { refuseAssignmentWrite } from './payrollAssignmentWriteGuard';

type Row = DbRow;

export interface EmployeeComponentAssignment {
  id: string;
  employeeId: string;
  componentId: string;
  amount: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isRecurring: boolean;
}

export type EmployeeComponentAssignmentWithMeta = EmployeeComponentAssignment & {
  componentName: string;
  componentType: string;
  /** False: the component was switched off, and a run does not pay it (getEmployeeComponents) though the row is open. */
  componentActive: boolean;
};

function mapAssignment(r: Row): EmployeeComponentAssignment {
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    componentId: String(r.component_id),
    amount: Number(r.amount),
    effectiveFrom: r.effective_from instanceof Date ? r.effective_from : new Date(String(r.effective_from)),
    effectiveTo: r.effective_to
      ? r.effective_to instanceof Date ? r.effective_to : new Date(String(r.effective_to))
      : null,
    isRecurring: r.is_recurring === false ? false : true,
  };
}

async function assertEmployeeInCompany(employeeId: string, companyId: string): Promise<void> {
  const rows = (await sql`
    SELECT id FROM payroll_employees
    WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (rows.length === 0) {
    throw new Error(`Payroll employee ${employeeId} not found in company`);
  }
}

export { EmployeeComponentRefused };

/** A user in two companies sees both through RLS and the foreign key is not tenant-aware, so only this predicate holds. */
export async function assertComponentInCompany(componentId: string, companyId: string): Promise<void> {
  const rows = isUuidParam(componentId) ? (await sql`
    SELECT id FROM payroll_components
    WHERE id = ${componentId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[] : [];
  if (rows.length === 0) throw new EmployeeComponentRefused('That pay component was not found in this company');
}

/**
 * A calendar day travels as a plain `YYYY-MM-DD` string from the caller to the column. A `Date` has a zone
 * and `toISOString()` reports it in UTC, which stored a local-midnight date one day early east of UTC.
 */
function dayOf(value: string, field: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  let real = false;
  if (day && +day[1]! >= 1) {
    // setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999. Same rule as isRealCalendarDate.
    const dt = new Date(0);
    dt.setUTCFullYear(+day[1]!, +day[2]! - 1, +day[3]!);
    real = dt.getUTCFullYear() === +day[1]! && dt.getUTCMonth() === +day[2]! - 1 && dt.getUTCDate() === +day[3]!;
  }
  if (!real) throw new EmployeeComponentRefused(`${field} must be a real date (YYYY-MM-DD)`);
  return value;
}

/**
 * Assign a component. The dates are plain 'YYYY-MM-DD' strings (#1057). Under the company's payroll-approval lock
 * (taken first, as approval, End and Edit dates take it), so no run is approved while an assignment appears; audited
 * with `actor` in the same transaction (payrollComponentAudit), so the approval gate sees it.
 */
export async function assignComponentToEmployee(
  companyId: string,
  employeeId: string,
  componentId: string,
  amount: number,
  effectiveFrom: string,
  effectiveTo: string | undefined,
  isRecurring: boolean,
  actor: ComponentChangeActor,
): Promise<EmployeeComponentAssignment> {
  const effectiveFromStr = dayOf(effectiveFrom, 'effectiveFrom');
  // Once-off → auto-cap effective_to at end of effective_from's month so the
  // assignment dies after the period it was captured for. Caller-supplied
  // effectiveTo wins if provided.
  const effectiveToStr = effectiveTo
    ? dayOf(effectiveTo, 'effectiveTo')
    : isRecurring
    ? null
    : endOfMonthIso(Number(effectiveFromStr.slice(0, 4)), Number(effectiveFromStr.slice(5, 7)));
  if (!isRecurring) refuseOnceOffSpan(effectiveFromStr, effectiveToStr);

  return withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    await assertEmployeeInCompany(employeeId, companyId);
    await assertComponentInCompany(componentId, companyId);
    await refuseAssignmentWrite(tx, companyId, { employeeId, componentId, from: effectiveFromStr, to: effectiveToStr, recurring: isRecurring });

    log.info('Assigning component to employee', { companyId, employeeId, componentId, isRecurring }, 'payrollEmployeeComponentService');

    const rows = (await tx`
      INSERT INTO payroll_employee_components (
        employee_id, component_id, amount, effective_from, effective_to, is_recurring, supersede_inferred
      ) VALUES (
        ${employeeId}::uuid,
        ${componentId}::uuid,
        ${amount},
        ${effectiveFromStr},
        ${effectiveToStr},
        ${isRecurring},
        FALSE -- written by this release: superseded_at decides (migration 953)
      )
      RETURNING *
    `) as Row[];

    if (!rows[0]) throw new Error('INSERT returned no row');
    await auditComponentChange(tx, companyId, String(rows[0].id), null,
      { from: effectiveFromStr, to: effectiveToStr, recurring: isRecurring }, 'assign', actor);
    return mapAssignment(rows[0]);
  });
}

/**
 * End an assignment (the profile's End, DELETE …/components, MCP end_employee_component). Returns whether a row was
 * actually ended: a stale, mistyped or foreign `assignmentId` matches nothing in the company and changes nothing, and
 * a caller that reported success on that would tell an agent an old salary had been ended while it stayed live.
 *
 * The rules and guards are Edit dates' (changeAssignmentDates, payrollComponentDateEdit): End only shortens; an
 * assignment no paid run read is CANCELLED (voided) when it is a once-off, when `effectiveTo` is before its start, or
 * when `cancel` is asked; refused for a voided row, a cancel of a paid row, or a change to what a paid run paid.
 * Audited with `actor`.
 */
export async function endEmployeeComponent(
  companyId: string,
  assignmentId: string,
  effectiveTo: string,
  actor: ComponentChangeActor,
  opts: { cancel?: boolean } = {},
): Promise<boolean> {
  return changeAssignmentDates(
    companyId, assignmentId, { kind: 'end', to: dayOf(effectiveTo, 'effectiveTo'), cancel: opts.cancel === true }, actor,
  );
}

export async function listEmployeeComponentAssignments(
  companyId: string,
  employeeId: string,
): Promise<EmployeeComponentAssignmentWithMeta[]> {
  await assertEmployeeInCompany(employeeId, companyId);

  const rows = (await sql`
    SELECT
      pec.id, pec.employee_id, pec.component_id, pec.amount,
      pec.effective_from, pec.effective_to, pec.is_recurring,
      pc.name AS component_name,
      pc.component_type,
      pc.is_active AS component_active
    FROM payroll_employee_components pec
    JOIN payroll_components pc ON pc.id = pec.component_id
    WHERE pec.employee_id = ${employeeId}::uuid
    ORDER BY pec.effective_from DESC, pc.name
  `) as Row[];

  return rows.map(r => ({
    ...mapAssignment(r),
    componentName: String(r.component_name),
    componentType: String(r.component_type),
    componentActive: Boolean(r.component_active),
  }));
}
