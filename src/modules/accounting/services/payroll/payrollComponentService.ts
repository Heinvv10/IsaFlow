import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollComponent, EmployeeComponent } from './payrollTypes';

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

/**
 * The employee's components a run (or the termination base) reads on `asOf`, a calendar day 'YYYY-MM-DD', bound as
 * given: no Date, so no zone can move it. A pay run passes payrollRunReadDate(period), the last day of its period.
 *
 * A row is read when its window covers `asOf`. A once-off (is_recurring false) is also read when its window starts in
 * `asOf`'s month and ends before `asOf` (10-27 November, the 28th alone, weekly overtime), unless a supersede cut it:
 * superseded_at, set by payPackageService (migration 953). A neighbouring row is NOT read as a supersede: contiguous
 * once-offs are all paid. Except between rows that existed before 953 (supersede_inferred): there the old rule holds,
 * a live pre-953 row of the same component starting the day after a pre-953 once-off ends supersedes it. End on a never-paid once-off voids it (payrollComponentDateEdit). A window that began in
 * an earlier month and ends before `asOf` is not read again: it was paid in the month whose last day it covered. A
 * leaver's recurring row ending on their end date is read in that month (the last month pays in full, Hein). A
 * voided row (ends before it starts) is never read.
 */
export async function getEmployeeComponents(
  employeeId: string,
  companyId: string,
  asOf: string,
): Promise<EmployeeComponent[]> {
  const rows = (await sql`
    SELECT
      pec.amount, pec.is_recurring,
      pc.id, pc.name, pc.sars_source_code, pc.component_type,
      pc.is_taxable, pc.is_uif_applicable, pc.is_sdl_applicable
    FROM payroll_employee_components pec
    JOIN payroll_components pc ON pc.id = pec.component_id
    JOIN payroll_employees pe ON pe.id = pec.employee_id
    WHERE pec.employee_id = ${employeeId}::uuid
      AND pe.company_id = ${companyId}::uuid
      AND pec.effective_from <= ${asOf}::date
      AND (pec.effective_to IS NULL OR pec.effective_to >= pec.effective_from)
      AND (
        pec.effective_to IS NULL OR pec.effective_to >= ${asOf}::date
        -- A leaver's recurring row ending on their end date pays the whole last month, as before (Hein 2026-11-02).
        OR (pec.is_recurring AND pec.effective_to = pe.end_date AND pec.effective_to >= date_trunc('month', ${asOf}::date)::date)
        OR (
          pec.is_recurring = FALSE
          AND pec.effective_from >= date_trunc('month', ${asOf}::date)::date
          AND pec.superseded_at IS NULL
          AND NOT (pec.supersede_inferred AND EXISTS (
            SELECT 1 FROM payroll_employee_components nxt
            WHERE nxt.id <> pec.id
              AND nxt.employee_id = pec.employee_id
              AND nxt.component_id = pec.component_id
              AND nxt.supersede_inferred
              AND nxt.effective_from = pec.effective_to + 1
              AND (nxt.effective_to IS NULL OR nxt.effective_to >= nxt.effective_from)
          ))
        )
      )
      AND pc.is_active = TRUE
    ORDER BY pc.component_type, pc.name
  `) as Row[];

  return rows.map(r => ({
    component: mapComponent(r),
    amount: Number(r.amount),
    isRecurring: r.is_recurring !== false,
  }));
}

/** A new component: earnings and deductions only, the types the calculator processes (employer contributions are refused). */
export async function createComponent(
  companyId: string,
  data: Omit<PayrollComponent, 'id' | 'componentType'> & { componentType: 'earning' | 'deduction' },
): Promise<PayrollComponent> {
  log.info('Creating payroll component', { companyId, name: data.name }, 'payrollComponentService');
  const rows = (await sql`
    INSERT INTO payroll_components (
      company_id, name, sars_source_code, component_type,
      is_taxable, is_uif_applicable, is_sdl_applicable
    ) VALUES (
      ${companyId}::uuid, ${data.name}, ${data.sarsSourceCode}, ${data.componentType},
      ${data.isTaxable}, ${data.isUifApplicable}, ${data.isSdlApplicable}
    )
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapComponent(rows[0]);
}
