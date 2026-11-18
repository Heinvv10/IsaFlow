/**
 * Wave 6 FQc integration fixtures: a weekly company (GL accounts, Basic Salary 3601, a once-off 3602, a young ETI employee
 * and an R6 000 a week one), June 2026's four weekly runs, approval as approvePayrollRun leaves it, and a line read.
 * Every write goes on the case's transaction-bound client (w6-fqb1.helpers twoRunsInMonth), so the rollback removes it.
 */
import type { PoolClient } from 'pg';
import type { Tenant } from './w6-fqb1.helpers';

/** June 2026's four weeks, Saturday to Friday, paid on the Friday (period_end: no app code writes run_date). */
export const WEEKS = [['2026-05-30', '2026-06-05'], ['2026-06-06', '2026-06-12'], ['2026-06-13', '2026-06-19'], ['2026-06-20', '2026-06-26']] as const;

export interface People { young: string; big: string; salary: string; extra: string }

/** A weekly company: GL accounts, Basic Salary (3601) and a once-off 3602, a young ETI employee and an R6 000 a week one. */
export async function seedWeekly(c: PoolClient, t: Tenant): Promise<People> {
  for (const [code, type] of [['5200', 'expense'], ['1110', 'asset'], ['2140', 'liability'], ['2150', 'liability'], ['2160', 'liability'], ['2175', 'liability']] as const) {
    await c.query(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, account_subtype, is_system_account)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7) ON CONFLICT DO NOTHING`,
      [t.company, code, `FQc ${code}`, type, type === 'liability' ? 'credit' : 'debit', code === '1110' ? 'bank' : null, code === '1110']);
  }
  const comp = async (name: string, code: string) => String((await c.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type) VALUES ($1, $2, $3, 'earning') RETURNING id`,
    [t.company, name, code])).rows[0].id);
  const salary = await comp('Basic Salary', '3601');
  const extra = await comp('Overtime', '3602');
  const employee = async (num: string, born: string, start: string, idNumber: string | null, weekly: number) => {
    const id = String((await c.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number,
         id_number, hours_per_week, medical_aid_main_member, pay_frequency)
       VALUES ($1, $2, 'Wanda', $2, $3::date, $4::date, '0123456789', $5, 40, false, 'weekly') RETURNING id`,
      [t.company, num, start, born, idNumber])).rows[0].id);
    await c.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, $4::date)`,
      [id, salary, weekly, start]);
    return id;
  };
  // A valid SA ID matching the date of birth (ETI Act s6(b)); 24 in June 2026, employed since September 2025.
  const young = await employee('FQC-YOUNG', '2002-05-20', '2025-09-01', '0205205009082', 1500);
  const big = await employee('FQC-BIG', '1980-01-01', '2020-01-01', null, 6000);
  return { young, big, salary, extra };
}

export async function weeklyRun(c: PoolClient, t: Tenant, [start, end]: readonly [string, string], month = 6): Promise<string> {
  return String((await c.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, pay_frequency, period_start, period_end)
     VALUES ($1, $2, 2026, 'draft', 'weekly', $3::date, $4::date) RETURNING id`, [t.company, month, start, end])).rows[0].id);
}

export async function approve(c: PoolClient, runId: string): Promise<void> {
  // As approvePayrollRun leaves it: approved with its approval time (the year to date reads final runs).
  await c.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1`, [runId]);
}

export interface Line { gross: number; paye: number; uif: number; eti: number; codes: string[] }
export async function line(c: PoolClient, runId: string, employee: string): Promise<Line> {
  const r = (await c.query(
    `SELECT gross_pay::float8 AS gross, paye::float8 AS paye, uif_employee::float8 AS uif, eti::float8 AS eti,
            ARRAY(SELECT v->>'code' FROM jsonb_array_elements(validation_results) v) AS codes
       FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [runId, employee])).rows[0];
  return r as Line;
}
