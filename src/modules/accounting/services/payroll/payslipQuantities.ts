/**
 * Hours and days actually captured against a run's components (BCEA s33(1)(g): hours worked and overtime hours).
 *
 * Read, never calculated: the employee's component assignments the run read (`getEmployeeComponents` on the run's
 * read date, as the calculator does) whose component the stored breakdown names, and which carry a quantity
 * (migration 967, payroll_employee_components.quantity + quantity_unit). Basic pay (SARS 3601) gives the ordinary
 * hours worked, overtime (3607) the overtime hours. Nothing captured, or a code captured in two units (summing
 * hours with days would invent a figure), is null: the slip says "Not recorded".
 */
import { sql } from '@/lib/neon';
import { getEmployeeComponents } from './payrollComponentService';
import { payrollRunReadDate } from './payrollRunReadDate';

export interface WorkedQuantity {
  quantity: number;
  unit: 'hour' | 'day';
}

export interface PayslipQuantities {
  ordinary: WorkedQuantity | null;
  overtime: WorkedQuantity | null;
}

const BASIC_PAY = '3601';
const OVERTIME = '3607';

interface QuantityRow { employee_id: string; component_id: string; sars_source_code: string; quantity: string | number; quantity_unit: string }

function total(rows: QuantityRow[]): WorkedQuantity | null {
  const units = new Set(rows.map((r) => r.quantity_unit));
  if (rows.length === 0 || units.size !== 1) return null;
  const unit = rows[0]!.quantity_unit === 'day' ? 'day' : 'hour';
  const quantity = Math.round(rows.reduce((s, r) => s + Number(r.quantity), 0) * 100) / 100;
  return quantity > 0 ? { quantity, unit } : null;
}

/** `paid` maps each employee to the component ids their stored breakdown names. */
export async function readQuantities(
  companyId: string, period: { month: number; year: number }, paid: Map<string, Set<string>>,
): Promise<Map<string, PayslipQuantities>> {
  const asOf = payrollRunReadDate(period);
  const assignments: string[] = [];
  for (const employeeId of paid.keys()) { // one after another: they share the request's transaction connection
    for (const a of await getEmployeeComponents(employeeId, companyId, asOf)) if (a.assignmentId) assignments.push(a.assignmentId);
  }
  const rows = assignments.length === 0 ? [] : (await sql`
    SELECT pec.employee_id::text AS employee_id, pec.component_id::text AS component_id,
           btrim(pc.sars_source_code) AS sars_source_code, pec.quantity, pec.quantity_unit
      FROM payroll_employee_components pec
      JOIN payroll_components pc ON pc.id = pec.component_id AND pc.company_id = ${companyId}::uuid
      JOIN payroll_employees pe ON pe.id = pec.employee_id AND pe.company_id = ${companyId}::uuid
     WHERE pec.id::text = ANY(${assignments}::text[]) AND pec.quantity IS NOT NULL
  `) as QuantityRow[];
  const out = new Map<string, PayslipQuantities>();
  for (const [employeeId, componentIds] of paid) {
    const mine = rows.filter((r) => r.employee_id === employeeId && componentIds.has(r.component_id));
    out.set(employeeId, {
      ordinary: total(mine.filter((r) => r.sars_source_code === BASIC_PAY)),
      overtime: total(mine.filter((r) => r.sars_source_code === OVERTIME)),
    });
  }
  return out;
}
