import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface EmployeeComponentAssignment {
  id: string;
  employeeId: string;
  componentId: string;
  amount: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
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

export async function assignComponentToEmployee(
  companyId: string,
  employeeId: string,
  componentId: string,
  amount: number,
  effectiveFrom: Date,
  effectiveTo?: Date,
): Promise<EmployeeComponentAssignment> {
  await assertEmployeeInCompany(employeeId, companyId);

  log.info('Assigning component to employee', { companyId, employeeId, componentId }, 'payrollEmployeeComponentService');

  const effectiveFromStr = effectiveFrom.toISOString().slice(0, 10);
  const effectiveToStr = effectiveTo ? effectiveTo.toISOString().slice(0, 10) : null;

  const rows = (await sql`
    INSERT INTO payroll_employee_components (
      employee_id, component_id, amount, effective_from, effective_to
    ) VALUES (
      ${employeeId}::uuid,
      ${componentId}::uuid,
      ${amount},
      ${effectiveFromStr},
      ${effectiveToStr}
    )
    RETURNING *
  `) as Row[];

  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapAssignment(rows[0]);
}

export async function endEmployeeComponent(
  companyId: string,
  assignmentId: string,
  effectiveTo: Date,
): Promise<void> {
  const effectiveToStr = effectiveTo.toISOString().slice(0, 10);

  log.info('Ending employee component', { companyId, assignmentId, effectiveTo: effectiveToStr }, 'payrollEmployeeComponentService');

  await sql`
    UPDATE payroll_employee_components
    SET effective_to = ${effectiveToStr}
    WHERE id = ${assignmentId}::uuid
      AND employee_id IN (
        SELECT id FROM payroll_employees
        WHERE company_id = ${companyId}::uuid
      )
  `;
}

export async function listEmployeeComponentAssignments(
  companyId: string,
  employeeId: string,
): Promise<EmployeeComponentAssignmentWithMeta[]> {
  await assertEmployeeInCompany(employeeId, companyId);

  const rows = (await sql`
    SELECT
      pec.id, pec.employee_id, pec.component_id, pec.amount,
      pec.effective_from, pec.effective_to,
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
