import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import {executeCompensationCaller,type CompensationExecutionOptions} from '../controls/payrollCompensationLegacyAdapter';

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

export async function assignComponentToEmployee(
  companyId: string,
  employeeId: string,
  componentId: string,
  amount: number,
  effectiveFrom: Date,
  effectiveTo?: Date,
  isRecurring: boolean = true,
  options: CompensationExecutionOptions = {},
): Promise<EmployeeComponentAssignment> {
  const result=await executeCompensationCaller(companyId,{version:1,source:{kind:'manual'},actions:[{kind:'assign',employeeId,componentId,amount:String(amount),effectiveFrom:fmtDate(effectiveFrom),effectiveTo:effectiveTo?fmtDate(effectiveTo):null,isRecurring}]},options);
  const rows=await sql`SELECT a.* FROM payroll_employee_components a JOIN payroll_employees e ON e.id=a.employee_id AND e.company_id=${companyId}::uuid
    WHERE a.id=${result.assignmentIds[0]}::uuid` as Row[];
  if(!rows[0])throw new Error('Controlled compensation assignment disappeared');
  return mapAssignment(rows[0]);
}

/** Close one owned assignment through its approved immutable compensation intent. */
export async function endEmployeeComponent(
  companyId: string,
  assignmentId: string,
  effectiveTo: Date,
  options: CompensationExecutionOptions = {},
): Promise<boolean> {
  const result=await executeCompensationCaller(companyId,{version:1,source:{kind:'manual'},actions:[{kind:'end',assignmentId,effectiveTo:fmtDate(effectiveTo)}]},options);
  return result.ended===1;
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
