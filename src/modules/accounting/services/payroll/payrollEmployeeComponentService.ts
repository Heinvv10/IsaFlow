import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { isUuidParam } from '@/lib/validation';
import { endOfMonthIso } from './leaveAccrualService';
import { changeAssignmentDates, type ComponentChangeActor } from './payrollComponentDateEdit';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';

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

export async function assignComponentToEmployee(
  companyId: string,
  employeeId: string,
  componentId: string,
  amount: number,
  effectiveFrom: Date,
  effectiveTo?: Date,
  isRecurring: boolean = true,
): Promise<EmployeeComponentAssignment> {
  await assertEmployeeInCompany(employeeId, companyId);
  await assertComponentInCompany(componentId, companyId);

  log.info('Assigning component to employee', { companyId, employeeId, componentId, isRecurring }, 'payrollEmployeeComponentService');

  const effectiveFromStr = effectiveFrom.toISOString().slice(0, 10);
  // Once-off → auto-cap effective_to at end of effective_from's month so the
  // assignment dies after the period it was captured for. Caller-supplied
  // effectiveTo wins if provided.
  const effectiveToStr = effectiveTo
    ? effectiveTo.toISOString().slice(0, 10)
    : isRecurring
    ? null
    : endOfMonthIso(effectiveFrom.getUTCFullYear(), effectiveFrom.getUTCMonth() + 1);

  const rows = (await sql`
    INSERT INTO payroll_employee_components (
      employee_id, component_id, amount, effective_from, effective_to, is_recurring
    ) VALUES (
      ${employeeId}::uuid,
      ${componentId}::uuid,
      ${amount},
      ${effectiveFromStr},
      ${effectiveToStr},
      ${isRecurring}
    )
    RETURNING *
  `) as Row[];

  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapAssignment(rows[0]);
}

/**
 * End an assignment (the profile's End, DELETE …/components, MCP end_employee_component). Returns whether a row was
 * actually ended: a stale, mistyped or foreign `assignmentId` matches nothing in the company and changes nothing, and
 * a caller that reported success on that would tell an agent an old salary had been ended while it stayed live.
 *
 * The rules and guards are Edit dates' (changeAssignmentDates, payrollComponentDateEdit): End only shortens; a
 * once-off no run has paid is cancelled (voided); refused for a voided row, an end before the start, a change to what
 * a paid run paid, or one that makes a replaced once-off be paid again. Audited with `actor`.
 */
export async function endEmployeeComponent(
  companyId: string,
  assignmentId: string,
  effectiveTo: Date,
  actor: ComponentChangeActor,
): Promise<boolean> {
  return changeAssignmentDates(companyId, assignmentId, { kind: 'end', to: fmtDate(effectiveTo) }, actor);
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
