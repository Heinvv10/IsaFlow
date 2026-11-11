/** Shared fixtures for the TS-b integration suites: a run over one employee with given terms, a second employee in the same company. */
import type { Pool } from 'pg';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import type { PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';
import type { SeveranceFixture } from './p3-severance.helpers';

export type Terms = Partial<Pick<PayrollEmployee, 'taxStatus' | 'payBasis' | 'hoursPerWeek' | 'hoursPerDay' | 'dailyRate' | 'hourlyRate' | 'employmentType'>>;
/** Non-standard employment (G21 p. 28): 14 hours a week, 6 hours a day at R500 a day. */
export const FLAT: Terms = { taxStatus: 'employee', payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 500 };
export const STANDARD: Terms = { taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: 40, hoursPerDay: null, dailyRate: null };

export interface LineRow {
  paye: number; uif: number; sdl: number; eti: number; applicable: number; results: Array<{ code: string; severity?: string; treatment?: string }>;
}

export async function newRun(pool: Pool, f: SeveranceFixture, month: number): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, status) VALUES ($1, $2, $3, 2026, 'draft')`, [id, f.company, month]);
  return id;
}

export async function lineOf(pool: Pool, runId: string, employee: string): Promise<LineRow> {
  return (await pool.query(
    `SELECT paye::float8 AS paye, uif_employee::float8 AS uif, sdl::float8 AS sdl, eti::float8 AS eti, sdl_applicable::float8 AS applicable,
            validation_results AS results FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [runId, employee])).rows[0] as LineRow;
}

/** Set the terms, calculate the month, mark the run approved; returns its id and the employee's line. */
export async function run(pool: Pool, f: SeveranceFixture, month: number, terms: Terms, employee = f.employee) {
  await updatePayrollEmployee(employee, f.company, terms);
  const id = await newRun(pool, f, month);
  await calculatePayrollRun(id, f.company);
  await pool.query(`UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1`, [id]);
  return { id, line: await lineOf(pool, id, employee) };
}

/** Another employee of f's company on the basic salary component (3601) from 2020. */
export async function addEmployee(pool: Pool, f: SeveranceFixture, tag: string, monthly: number): Promise<string> {
  const id = String((await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number, medical_aid_main_member)
     VALUES ($1, $2, 'Extra', $2, '2020-01-01', '1980-01-01', $3, false) RETURNING id`,
    [f.company, `TSB-${tag}`, String(1234560000 + Math.floor(Math.random() * 9999))])).rows[0]!.id);
  const comp = String((await pool.query("SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'", [f.company])).rows[0]!.id);
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, '2020-01-01')`, [id, comp, monthly]);
  return id;
}
