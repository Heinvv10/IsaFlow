import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollEmployee } from './payrollTypes';
import { recordEmployeeChange } from './payrollEmployeeHistoryService';

type Row = DbRow;

function mapRow(r: Row): PayrollEmployee {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    employeeNumber: String(r.employee_number),
    firstName: String(r.first_name),
    lastName: String(r.last_name),
    idNumber: r.id_number ? String(r.id_number) : undefined,
    taxNumber: r.tax_number ? String(r.tax_number) : undefined,
    employmentType: String(r.employment_type) as PayrollEmployee['employmentType'],
    startDate: new Date(String(r.start_date)),
    endDate: r.end_date ? new Date(String(r.end_date)) : undefined,
    dateOfBirth: r.date_of_birth ? new Date(String(r.date_of_birth)) : undefined,
    uifExcluded: Boolean(r.uif_excluded),
    medicalAidMainMember: Boolean(r.medical_aid_main_member),
    medicalAidDependantsCount: Number(r.medical_aid_dependants_count) || 0,
    costCentreId: r.cost_centre_id == null ? null : String(r.cost_centre_id),
    payScaleId: r.pay_scale_id == null ? null : String(r.pay_scale_id),
  };
}

export async function listPayrollEmployees(companyId: string): Promise<PayrollEmployee[]> {
  const rows = (await sql`
    SELECT * FROM payroll_employees
    WHERE company_id = ${companyId}::uuid AND status = 'active'
    ORDER BY last_name, first_name
  `) as Row[];
  return rows.map(mapRow);
}

export async function getPayrollEmployee(
  id: string,
  companyId: string,
): Promise<PayrollEmployee | null> {
  const rows = (await sql`
    SELECT * FROM payroll_employees
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  return rows.length > 0 && rows[0] ? mapRow(rows[0]) : null;
}

export async function createPayrollEmployee(
  companyId: string,
  data: Omit<PayrollEmployee, 'id' | 'companyId'>,
): Promise<PayrollEmployee> {
  log.info('Creating payroll employee', { companyId, employeeNumber: data.employeeNumber }, 'payrollEmployeeService');
  const rows = (await sql`
    INSERT INTO payroll_employees (
      company_id, employee_number, first_name, last_name,
      id_number, tax_number, employment_type, start_date, end_date,
      date_of_birth, uif_excluded, medical_aid_main_member, medical_aid_dependants_count
    ) VALUES (
      ${companyId}::uuid, ${data.employeeNumber}, ${data.firstName}, ${data.lastName},
      ${data.idNumber ?? null}, ${data.taxNumber ?? null},
      ${data.employmentType}, ${data.startDate.toISOString().split('T')[0]},
      ${data.endDate ? data.endDate.toISOString().split('T')[0] : null},
      ${data.dateOfBirth ? data.dateOfBirth.toISOString().split('T')[0] : null},
      ${data.uifExcluded}, ${data.medicalAidMainMember}, ${data.medicalAidDependantsCount}
    )
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapRow(rows[0]);
}

export async function updatePayrollEmployee(
  id: string,
  companyId: string,
  data: Partial<Omit<PayrollEmployee, 'id' | 'companyId'>>,
  userId?: string,
): Promise<PayrollEmployee | null> {
  log.info('Updating payroll employee', { id, companyId }, 'payrollEmployeeService');

  const beforeRows = (await sql`
    SELECT employment_type FROM payroll_employees
     WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as Row[];
  const before = beforeRows[0];

  const rows = (await sql`
    UPDATE payroll_employees SET
      first_name                   = COALESCE(${data.firstName ?? null}, first_name),
      last_name                    = COALESCE(${data.lastName ?? null}, last_name),
      tax_number                   = COALESCE(${data.taxNumber ?? null}, tax_number),
      id_number                    = COALESCE(${data.idNumber ?? null}, id_number),
      employment_type              = COALESCE(${data.employmentType ?? null}, employment_type),
      uif_excluded                 = COALESCE(${data.uifExcluded ?? null}, uif_excluded),
      medical_aid_main_member      = COALESCE(${data.medicalAidMainMember ?? null}, medical_aid_main_member),
      medical_aid_dependants_count = COALESCE(${data.medicalAidDependantsCount ?? null}, medical_aid_dependants_count),
      updated_at                   = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as Row[];

  const updated = rows.length > 0 && rows[0] ? mapRow(rows[0]) : null;

  if (userId && before && updated && data.employmentType !== undefined) {
    await recordEmployeeChange({
      companyId,
      employeeId: id,
      fieldName: 'employment_type',
      oldValue: before.employment_type == null ? null : String(before.employment_type),
      newValue: updated.employmentType,
      userId,
    });
  }

  return updated;
}

export async function listTaxNumbersForCompany(
  companyId: string,
  excludeId?: string,
): Promise<string[]> {
  const rows = (await sql`
    SELECT tax_number FROM payroll_employees
    WHERE company_id = ${companyId}::uuid
      AND tax_number IS NOT NULL
      AND status = 'active'
      AND (${excludeId ?? null}::uuid IS NULL OR id != ${excludeId ?? null}::uuid)
  `) as Row[];
  return rows.map(r => String(r.tax_number));
}
