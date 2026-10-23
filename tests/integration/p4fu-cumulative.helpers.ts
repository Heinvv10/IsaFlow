/**
 * PAYE 4a follow-ups G4 fixtures: an employee in employment through tax year
 * 2027, with salary changes and annual payments, on the P3 severance fixture
 * (born 1980, no medical aid, R-salary from 2020).
 */
import type { Pool } from 'pg';
import { seedRetrenchedEmployee, type SeveranceFixture } from './p3-severance.helpers';

/** Tax year 2027: March 2026 (month 1) to February 2027 (month 12). */
export const PERIODS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2].map((m) => ({ month: m, year: m >= 3 ? 2026 : 2027 }));

/** An employee in employment (not leaving), salary from 2020 at `monthly`; added to `fixtures` for cleanup. */
export async function seedEmployee(pool: Pool, fixtures: SeveranceFixture[], name: string, monthly: number): Promise<SeveranceFixture> {
  const f = await seedRetrenchedEmployee(pool, '2030-12-31', name, monthly);
  await pool.query("UPDATE payroll_employees SET end_date = NULL, status = 'active' WHERE id = $1", [f.employee]);
  fixtures.push(f);
  return f;
}

/** Salary from the first of (year, month): ends the open salary row, starts a new one. */
export async function setSalary(pool: Pool, f: SeveranceFixture, year: number, month: number, amount: number): Promise<void> {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const row = (await pool.query(
    `SELECT pec.id, pec.component_id FROM payroll_employee_components pec
       JOIN payroll_components c ON c.id = pec.component_id
      WHERE pec.employee_id = $1 AND c.sars_source_code = '3601' AND pec.effective_to IS NULL`, [f.employee])).rows[0]!;
  await pool.query(`UPDATE payroll_employee_components SET effective_to = ($2::date - 1) WHERE id = $1`, [row.id, from]);
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, $3, $4)`,
    [f.employee, row.component_id, amount, from]);
}

/** An annual payment (3605) of `amount` in (year, month) only. */
export async function bonus(pool: Pool, f: SeveranceFixture, year: number, month: number, amount: number): Promise<void> {
  const comp = (await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
     VALUES ($1, $2, '3605', 'earning') RETURNING id`, [f.company, `Bonus ${year}-${month}`])).rows[0]!.id;
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, ($4::date + INTERVAL '1 month - 1 day')::date)`, [f.employee, comp, amount, from]);
}
