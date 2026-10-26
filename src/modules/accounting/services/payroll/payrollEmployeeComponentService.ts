import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
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

/** A real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d;
}

/**
 * The dates are the date column's own 'YYYY-MM-DD', stored as given: no Date
 * and so no timezone to shift them. They were Dates rendered with
 * toISOString(), and the MCP tool's local-midnight Date lost a day east of
 * UTC: a once-off dated the 1st was stored on the previous day and closed at
 * the previous month-end, so it dropped out of its run (PAYE 4c).
 */
export async function assignComponentToEmployee(
  companyId: string,
  employeeId: string,
  componentId: string,
  amount: number,
  effectiveFrom: string,
  effectiveTo?: string,
  isRecurring: boolean = true,
): Promise<EmployeeComponentAssignment> {
  for (const [field, day] of [['effectiveFrom', effectiveFrom], ['effectiveTo', effectiveTo]] as const) {
    if (day !== undefined && !isCalendarDay(day)) throw new Error(`${field} must be a calendar date written YYYY-MM-DD (got ${String(day)})`);
  }
  await assertEmployeeInCompany(employeeId, companyId);

  log.info('Assigning component to employee', { companyId, employeeId, componentId, isRecurring }, 'payrollEmployeeComponentService');

  // Once-off → auto-cap effective_to at end of effective_from's month so the
  // assignment dies after the period it was captured for. Caller-supplied
  // effectiveTo wins if provided.
  const [fromYear, fromMonth] = effectiveFrom.split('-').map(Number) as [number, number];
  const effectiveToStr = effectiveTo ?? (isRecurring ? null : endOfMonthIso(fromYear, fromMonth));

  const rows = (await sql`
    INSERT INTO payroll_employee_components (
      employee_id, component_id, amount, effective_from, effective_to, is_recurring
    ) VALUES (
      ${employeeId}::uuid,
      ${componentId}::uuid,
      ${amount},
      ${effectiveFrom},
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
  effectiveTo: Date,
): Promise<boolean> {
  const effectiveToStr = fmtDate(effectiveTo);

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
      pc.component_type
    FROM payroll_employee_components pec
    JOIN payroll_components pc ON pc.id = pec.component_id
    WHERE pec.employee_id = ${employeeId}::uuid
    ORDER BY pec.effective_from DESC, pc.name
  `) as Row[];

  return rows.map(r => ({
    ...mapAssignment(r),
    componentName: String(r.component_name),
    componentType: String(r.component_type),
  }));
}
