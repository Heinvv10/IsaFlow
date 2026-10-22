/**
 * PAYE 4a follow-ups G4, breaker round 1 on PR B, ported: months approved out
 * of order. PAYE is cumulative over the declarable months BEFORE a run, so a
 * January calculated after February was approved leaves February's PAYE short
 * of January, and with nothing after February the year stays short (R340
 * here). Not refused (a back-fill or a correction of an earlier month must
 * stay possible; a paid run cannot be reopened): the late month's lines carry
 * PAYE_LATER_PERIODS_APPROVED, naming the later months and the remedy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import {
  approveRun, cleanSeveranceFixtures, runLine, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

/** Tax year 2027: March 2026 (month 1) to February 2027 (month 12). */
const PERIODS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2].map((m) => ({ month: m, year: m >= 3 ? 2026 : 2027 }));

/** An employee in employment (not leaving), salary from 2020 at `monthly`. */
async function seedEmployee(name: string, monthly: number): Promise<SeveranceFixture> {
  const f = await seedRetrenchedEmployee(pool, '2030-12-31', name, monthly);
  await pool.query("UPDATE payroll_employees SET end_date = NULL, status = 'active' WHERE id = $1", [f.employee]);
  fixtures.push(f);
  return f;
}

/** Salary from the first of (year, month): ends the open salary row, starts a new one. */
async function setSalary(f: SeveranceFixture, year: number, month: number, amount: number) {
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

async function bonus(f: SeveranceFixture, year: number, month: number, amount: number) {
  const comp = (await pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
     VALUES ($1, $2, '3605', 'earning') RETURNING id`, [f.company, `Bonus ${year}-${month}`])).rows[0]!.id;
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, ($4::date + INTERVAL '1 month - 1 day')::date)`, [f.employee, comp, amount, from]);
}

/** Create, calculate and approve the run for (year, month); returns its id and the employee's PAYE. */
async function payMonth(f: SeveranceFixture, year: number, month: number): Promise<{ id: string; paye: number }> {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year } });
  if (made.statusCode !== 201) throw new Error(`create ${year}-${month}: ${made.statusCode} ${JSON.stringify(made.body)}`);
  const id = String(made.body.data!.id);
  const calc = await f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
  if (calc.statusCode !== 200) throw new Error(`calculate: ${calc.statusCode} ${JSON.stringify(calc.body)}`);
  const ok = await approveRun(f, id);
  if (ok.statusCode !== 200) throw new Error(`approve ${year}-${month}: ${ok.statusCode} ${JSON.stringify(ok.body)}`);
  return { id, paye: (await runLine(pool, id, f.employee)).paye };
}

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function mk(f: SeveranceFixture, year: number, month: number): Promise<string> {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year } });
  if (made.statusCode !== 201) throw new Error(`create: ${made.statusCode}`);
  return String(made.body.data!.id);
}
async function calcApprove(f: SeveranceFixture, id: string): Promise<number> {
  const calc = await f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
  if (calc.statusCode !== 200) throw new Error(`calc ${calc.statusCode}`);
  const ok = await approveRun(f, id);
  if (ok.statusCode !== 200) throw new Error(`approve ${ok.statusCode}`);
  return (await runLine(pool, id, f.employee)).paye;
}

describe('G4: months approved out of order', () => {
  it('January approved after February: the January line warns, naming February; the shortfall is the R340 the warning describes', async () => {
    const inOrderEmployee = await seedEmployee('P4fu order: in order', 20_000);
    await setSalary(inOrderEmployee, 2027, 1, 60_000);
    let inOrder = 0;
    const inOrderIds: string[] = [];
    for (const p of PERIODS) {
      const { id, paye } = await payMonth(inOrderEmployee, p.year, p.month);
      inOrder += paye;
      inOrderIds.push(id);
    }
    const codes = async (id: string, employee: string) =>
      ((await runLine(pool, id, employee)).validation_results as Array<{ code: string; message: string }>);
    for (const id of inOrderIds) expect((await codes(id, inOrderEmployee.employee)).map(c => c.code)).not.toContain('PAYE_LATER_PERIODS_APPROVED');

    const f = await seedEmployee('P4fu order: January late', 20_000);
    await setSalary(f, 2027, 1, 60_000);
    const ids: Record<string, string> = {};
    for (const p of PERIODS) ids[`${p.year}-${p.month}`] = await mk(f, p.year, p.month);
    let total = 0;
    for (const p of PERIODS) if (p.month !== 1) total += await calcApprove(f, ids[`${p.year}-${p.month}`]!);
    total += await calcApprove(f, ids['2027-1']!);
    const warning = (await codes(ids['2027-1']!, f.employee)).find(c => c.code === 'PAYE_LATER_PERIODS_APPROVED');
    expect(warning?.message).toMatch(/2027-02/);
    expect(Math.round((inOrder - total) * 100) / 100).toBe(340);
  });
});
