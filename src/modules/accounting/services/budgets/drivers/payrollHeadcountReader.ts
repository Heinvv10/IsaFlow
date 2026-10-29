/**
 * The per_head driver's payroll input (P4 decision 7, confirmed by Hein 2026-10-29): the ONLY
 * budgets file that reads payroll tables. Read-only, and it selects only what the headcount rule
 * needs: each employee's id, start and end dates, status and own cost centre
 * (`payroll_employees`, migrations 380 + 450), and the cost-centre split
 * (`payroll_employee_cost_allocations`, migration 451). Never names, ID or tax numbers, or pay.
 *
 * Tenancy: company_id on BOTH tables. RLS alone does not do it: payroll's app_user policy admits
 * every company the user belongs to, not just the active one.
 *
 * start_date is NOT NULL (380). The `IS NOT NULL` predicate is a no-op today; were the column ever
 * relaxed, an employee with no start date has no month to place them in, so they are not counted
 * (as an `inactive` one is not), rather than failing the whole recompute. Likewise an end date
 * before the start date (payroll has no CHECK for it, and the engine refuses one): no day employed,
 * so not counted, and logged by employee id so it can be corrected in payroll.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { HeadcountAllocation, HeadcountEmployee } from './headcount';

export interface PayrollHeadcountInputs {
  employees: HeadcountEmployee[];
  allocations: HeadcountAllocation[];
}

export async function readPayrollHeadcount(companyId: string): Promise<PayrollHeadcountInputs> {
  const employees = (await sql`
    SELECT pe.id::text AS id, to_char(pe.start_date, 'YYYY-MM-DD') AS start_date, to_char(pe.end_date, 'YYYY-MM-DD') AS end_date,
           pe.status, pe.cost_centre_id::text AS cost_centre_id
      FROM payroll_employees pe
     WHERE pe.company_id = ${companyId}::UUID AND pe.start_date IS NOT NULL
     ORDER BY pe.id
  `) as DbRow[];
  const allocations = (await sql`
    SELECT a.employee_id::text AS employee_id, a.cost_centre_id::text AS cost_centre_id, a.percentage::text AS percentage
      FROM payroll_employee_cost_allocations a
      JOIN payroll_employees pe ON pe.id = a.employee_id AND pe.company_id = ${companyId}::UUID
     WHERE a.company_id = ${companyId}::UUID
     ORDER BY a.employee_id, a.cost_centre_id
  `) as DbRow[];
  const all: HeadcountEmployee[] = employees.map((r) => ({
    id: String(r.id), startDate: String(r.start_date), endDate: r.end_date === null ? null : String(r.end_date),
    status: String(r.status), costCentreId: r.cost_centre_id === null ? null : String(r.cost_centre_id),
  }));
  const backwards = all.filter((e) => e.endDate !== null && e.endDate < e.startDate).map((e) => e.id);
  if (backwards.length > 0) {
    log.warn('payroll employees end before they start: not counted in budget headcount', { companyId, employeeIds: backwards });
  }
  return {
    employees: all.filter((e) => !backwards.includes(e.id)),
    allocations: allocations.map((r) => ({
      employeeId: String(r.employee_id), costCentreId: String(r.cost_centre_id), percentage: Number(r.percentage),
    })),
  };
}
