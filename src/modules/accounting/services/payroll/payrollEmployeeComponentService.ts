import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isUuidParam } from '@/lib/validation';
import { endOfMonthIso } from './leaveAccrualService';

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

/** Raised before the insert, so the caller can answer it as a 400 (a 4xx commits). */
export class EmployeeComponentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeComponentRefused';
  }
}

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
  const real = day && new Date(Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!)).toISOString().slice(0, 10) === value;
  if (!real) throw new EmployeeComponentRefused(`${field} must be a real date (YYYY-MM-DD)`);
  return value;
}

export async function assignComponentToEmployee(
  companyId: string,
  employeeId: string,
  componentId: string,
  amount: number,
  effectiveFrom: string,
  effectiveTo?: string,
  isRecurring: boolean = true,
): Promise<EmployeeComponentAssignment> {
  await assertEmployeeInCompany(employeeId, companyId);
  await assertComponentInCompany(componentId, companyId);

  log.info('Assigning component to employee', { companyId, employeeId, componentId, isRecurring }, 'payrollEmployeeComponentService');

  const effectiveFromStr = dayOf(effectiveFrom, 'effectiveFrom');
  // Once-off → auto-cap effective_to at end of effective_from's month so the
  // assignment dies after the period it was captured for. Caller-supplied
  // effectiveTo wins if provided.
  const effectiveToStr = effectiveTo
    ? dayOf(effectiveTo, 'effectiveTo')
    : isRecurring
    ? null
    : endOfMonthIso(Number(effectiveFromStr.slice(0, 4)), Number(effectiveFromStr.slice(5, 7)));

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
 * Close an assignment. Returns whether a row was actually closed.
 *
 * The boolean is not decoration. The UPDATE is scoped through the employee's
 * company, so a stale, mistyped-but-well-formed, or foreign `assignmentId`
 * matches NOTHING and the statement succeeds having changed nothing. A caller
 * that reported success on that would tell an agent an old salary had been
 * ended while it stayed live — and the next costed run would pay it.
 */
export async function endEmployeeComponent(
  companyId: string,
  assignmentId: string,
  effectiveTo: string,
): Promise<boolean> {
  const effectiveToStr = dayOf(effectiveTo, 'effectiveTo');

  log.info('Ending employee component', { companyId, assignmentId, effectiveTo: effectiveToStr }, 'payrollEmployeeComponentService');

  const rows = (await sql`
    UPDATE payroll_employee_components
    SET effective_to = ${effectiveToStr}
    WHERE id = ${assignmentId}::uuid
      AND employee_id IN (
        SELECT id FROM payroll_employees
        WHERE company_id = ${companyId}::uuid
      )
    RETURNING id
  `) as Row[];
  return rows.length > 0;
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
