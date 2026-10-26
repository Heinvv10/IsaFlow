import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollComponent, EmployeeComponent } from './payrollTypes';
import { paidOutsidePayrollRefusal } from './retirementFund';

type Row = DbRow;

function mapComponent(r: Row): PayrollComponent {
  return {
    id: String(r.id),
    name: String(r.name),
    sarsSourceCode: String(r.sars_source_code),
    componentType: String(r.component_type) as PayrollComponent['componentType'],
    isTaxable: Boolean(r.is_taxable),
    isUifApplicable: Boolean(r.is_uif_applicable),
    isSdlApplicable: Boolean(r.is_sdl_applicable),
    paidOutsidePayroll: r.paid_outside_payroll === true,
  };
}

export async function listComponents(companyId: string): Promise<PayrollComponent[]> {
  const rows = (await sql`
    SELECT * FROM payroll_components
    WHERE company_id = ${companyId}::uuid AND is_active = TRUE
    ORDER BY component_type, name
  `) as Row[];
  return rows.map(mapComponent);
}

export async function getEmployeeComponents(
  employeeId: string,
  companyId: string,
  periodDate: Date,
): Promise<EmployeeComponent[]> {
  const dateStr = periodDate.toISOString().split('T')[0];
  const rows = (await sql`
    SELECT
      pec.amount,
      pc.id, pc.name, pc.sars_source_code, pc.component_type,
      pc.is_taxable, pc.is_uif_applicable, pc.is_sdl_applicable, pc.paid_outside_payroll
    FROM payroll_employee_components pec
    JOIN payroll_components pc ON pc.id = pec.component_id
    JOIN payroll_employees pe ON pe.id = pec.employee_id
    WHERE pec.employee_id = ${employeeId}::uuid
      AND pe.company_id = ${companyId}::uuid
      AND pec.effective_from <= ${dateStr}
      AND (pec.effective_to IS NULL OR pec.effective_to >= ${dateStr})
      AND pc.is_active = TRUE
    ORDER BY pc.component_type, pc.name
  `) as Row[];

  return rows.map(r => ({
    component: mapComponent(r),
    amount: Number(r.amount),
  }));
}

/** `paid_outside_payroll` on a component that cannot carry it (the route answers 400 with the message). */
export class PaidOutsidePayrollRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaidOutsidePayrollRefusedError';
  }
}

/** A new component: earnings and deductions only, the types the calculator processes (employer contributions are refused). */
export async function createComponent(
  companyId: string,
  data: Omit<PayrollComponent, 'id' | 'componentType'> & { componentType: 'earning' | 'deduction' },
): Promise<PayrollComponent> {
  const paidOutsidePayroll = data.paidOutsidePayroll === true;
  const refused = paidOutsidePayroll ? paidOutsidePayrollRefusal(data.componentType, data.sarsSourceCode) : null;
  if (refused) throw new PaidOutsidePayrollRefusedError(refused);
  log.info('Creating payroll component', { companyId, name: data.name }, 'payrollComponentService');
  const rows = (await sql`
    INSERT INTO payroll_components (
      company_id, name, sars_source_code, component_type,
      is_taxable, is_uif_applicable, is_sdl_applicable, paid_outside_payroll
    ) VALUES (
      ${companyId}::uuid, ${data.name}, ${data.sarsSourceCode}, ${data.componentType},
      ${data.isTaxable}, ${data.isUifApplicable}, ${data.isSdlApplicable}, ${paidOutsidePayroll}
    )
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapComponent(rows[0]);
}
