/**
 * PAYE 4a follow-ups G4: cumulative (run-to-date) PAYE through the real routes
 * on real Postgres (Hein 2026-10-22). Method and sources: payeCumulative.ts
 * (SARS PAYE-GEN-01-G21 (2027) Rev 1 p. 8 and p. 32-33). Expected figures as
 * in tests/unit/services/payroll/payeCumulative.test.ts (2027 statutory table,
 * employee born 1980, no medical aid).
 *
 * The year-to-date is read from the employee's lines on DECLARABLE runs
 * (approved, paid) of the same tax year, before this run's period; the run
 * being calculated, a reopened run and any later period are not in it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import { calculateUIF } from '@/modules/accounting/services/payroll/uifEngine';
import {
  approveRun, cleanSeveranceFixtures, reopenRun, runLine, seedRetrenchedEmployee, type SeveranceFixture,
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

describe('G4: cumulative PAYE, month by month', () => {
  it('a flat R20 000 all year: 2 115 every month (= x12); IRP5 4102 = the sum of the run PAYE', async () => {
    const f = await seedEmployee('P4fu flat year', 20_000);
    const paye: number[] = [];
    for (const p of PERIODS) paye.push((await payMonth(f, p.year, p.month)).paye);
    expect(paye).toEqual(Array(12).fill(2_115));
    const row = (await getIrp5EmployeeTotals(f.company, 2027, { employeeId: f.employee })).rows[0]!;
    expect(row.paye).toBe(25_380);
  });

  it('R20 000, R30 000 from September, a R20 000 bonus in February: the increase is spread, the year deducts its liability', async () => {
    const f = await seedEmployee('P4fu increase and bonus', 20_000);
    await setSalary(f, 2026, 9, 30_000);
    await bonus(f, 2027, 2, 20_000);
    const lines = [];
    for (const p of PERIODS) {
      const { id, paye } = await payMonth(f, p.year, p.month);
      lines.push({ paye, line: await runLine(pool, id, f.employee) });
    }
    expect(lines.map(l => l.paye)).toEqual([2115, 2115, 2115, 2115, 2115, 2115, 4477, 4681, 4681, 4681, 4681, 9881]);
    // Each line stores its split for the next period's year-to-date (migration 913).
    const feb = (await pool.query(
      `SELECT periodic_taxable::float8 AS p, annual_taxable::float8 AS a FROM payroll_run_lines l
         JOIN payroll_run_headers h ON h.id = l.run_id WHERE l.employee_id = $1 AND h.period_year = 2027 AND h.period_month = 2`,
      [f.employee])).rows[0]!;
    expect(feb).toEqual({ p: 30_000, a: 20_000 });
    const row = (await getIrp5EmployeeTotals(f.company, 2027, { employeeId: f.employee })).rows[0]!;
    expect(row.paye).toBe(45_772);
    expect(row.paye).toBe(lines.reduce((t, l) => t + l.paye, 0));
    // UIF, SDL and ETI are untouched: UIF from its own engine, nil SDL (R380 000 a year is under the
    // R500 000 threshold) and nil ETI (born 1980).
    for (const { line } of lines) {
      expect(line.uif_employee).toBe(calculateUIF(line.gross, 2027).employeeContribution);
      expect(line.sdl).toBe(0);
    }
    expect((await pool.query('SELECT SUM(eti)::float8 AS eti FROM payroll_run_lines WHERE employee_id = $1', [f.employee])).rows[0]!.eti).toBe(0);
  });

  it('#752\'s figures hold in October for a flat R28 000 (the annual equivalent is unchanged): 4 161 + 3 848', async () => {
    const f = await seedEmployee('P4fu 752 October', 28_000);
    await bonus(f, 2026, 10, 14_800);
    let october = 0;
    for (const p of PERIODS.slice(0, 8)) october = (await payMonth(f, p.year, p.month)).paye;
    expect(october).toBe(4_161 + 3_848);
  });

  it('an earlier bonus stays in the base: the December bonus is taxed on top of the May one', async () => {
    const f = await seedEmployee('P4fu second bonus', 20_000);
    await bonus(f, 2026, 5, 10_000);
    await bonus(f, 2026, 12, 20_000);
    const paye = [];
    for (const p of PERIODS.slice(0, 10)) paye.push((await payMonth(f, p.year, p.month)).paye);
    expect(paye[2]).toBe(2_115 + 2_192);
    expect(paye[9]).toBe(2_115 + 5_200);
  });

  it('an over-deduction is floored at nil and carried: it absorbs the tax when pay rises again', async () => {
    const f = await seedEmployee('P4fu over-deduction', 40_000);
    await setSalary(f, 2026, 6, 5_000);
    await setSalary(f, 2026, 8, 40_000);
    const paye = [];
    for (const p of PERIODS.slice(0, 6)) paye.push((await payMonth(f, p.year, p.month)).paye);
    // August: AE = 170 000 × 12 / 6 = 340 000, 50 972 × 6/12 = 25 486 − 23 054.25 deducted (x12: 7 684.75).
    expect(paye).toEqual([7684.75, 7684.75, 7684.75, 0, 0, 2431.75]);
  });

  it('a mid-year joiner: periods count from the start month, so the first month is x12', async () => {
    const f = await seedEmployee('P4fu joiner', 20_000);
    await pool.query("UPDATE payroll_employees SET start_date = '2026-07-01' WHERE id = $1", [f.employee]);
    await pool.query("UPDATE payroll_employee_components SET effective_from = '2026-07-01' WHERE employee_id = $1", [f.employee]);
    const july = await payMonth(f, 2026, 7);
    const august = await payMonth(f, 2026, 8);
    expect([july.paye, august.paye]).toEqual([2_115, 2_115]);
  });

  it('the final month of a short tax period: R15 000 × 6, R25 000 in September, leaving 30 September', async () => {
    const f = await seedEmployee('P4fu leaver', 15_000);
    await setSalary(f, 2026, 9, 25_000);
    await pool.query("UPDATE payroll_employees SET end_date = '2026-09-30' WHERE id = $1", [f.employee]);
    const paye = [];
    for (const p of PERIODS.slice(0, 7)) paye.push((await payMonth(f, p.year, p.month)).paye);
    // G21 p. 8: tax(115 000 × 12 / 7) × 7 / 12 = 10 305, less 6 × 1 215 deducted (x12 would take 3 381).
    expect(paye).toEqual([1215, 1215, 1215, 1215, 1215, 1215, 3015]);
  });

  it('a reopened, recalculated earlier run counts neither itself nor a later run', async () => {
    const f = await seedEmployee('P4fu reopen', 20_000);
    await setSalary(f, 2026, 4, 30_000);
    const march = await payMonth(f, 2026, 3);
    const april = await payMonth(f, 2026, 4);
    const may = await payMonth(f, 2026, 5);
    // April: AE = 50 000 × 6 = 300 000, 40 572 × 2/12 − 2 115; May: 45 772 × 3/12 − 6 762.
    expect([march.paye, april.paye, may.paye]).toEqual([2_115, 4_647, 4_681]);
    expect((await reopenRun(f, april.id)).statusCode).toBe(200);
    const calc = await f.call(calculate as Route, 'POST', `/api/payroll/runs/${april.id}/calculate`, april.id);
    expect(calc.statusCode).toBe(200);
    expect((await runLine(pool, april.id, f.employee)).paye).toBe(4_647);
  });
});

describe('G4: the year-to-date', () => {
  it('leaves directive PAYE out of the table PAYE and derives a line written before the split columns', async () => {
    const { loadPayeYearToDate } = await import('@/modules/accounting/services/payroll/payrollYearToDate');
    const f = await seedEmployee('P4fu ytd', 20_000);
    const run = (await pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status) VALUES ($1, 2026, 3, 'approved') RETURNING id`,
      [f.company])).rows[0]!.id;
    // A March line from before migration 910 (no split columns): salary 20 000, bonus 10 000 (3605),
    // severance 30 000 under a directive with PAYE 3 000. PAYE 2 115 + 2 192 + 3 000.
    const breakdown = [
      { componentId: 'a', componentName: 'Salary', sarsSourceCode: '3601', amount: 20_000, isTaxable: true, isUifApplicable: true },
      { componentId: 'b', componentName: 'Bonus', sarsSourceCode: '3605', amount: 10_000, isTaxable: true, isUifApplicable: true },
      { componentId: 'c', componentName: 'Severance', sarsSourceCode: '3901', amount: 30_000, isTaxable: true, isUifApplicable: false,
        directive: { id: crypto.randomUUID(), number: '1', paye: 3_000 } },
    ];
    await pool.query(
      `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, net_pay, component_breakdown)
       VALUES ($1, $2, 60000, 30000, 7307, 52693, $3)`, [run, f.employee, JSON.stringify(breakdown)]);
    const ytd = await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 4 }, [f.employee]);
    expect(ytd.get(f.employee)).toEqual({ periods: 1, periodicTaxable: 20_000, annualPayments: 10_000, tablePaye: 4_307 });
    // April: a severance-only line on an approved run (no periodic pay: not a period worked);
    // May: a run only calculated (not declarable: not in it).
    const april = (await pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status) VALUES ($1, 2026, 4, 'approved') RETURNING id`,
      [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, periodic_taxable, annual_taxable, paye, net_pay, component_breakdown)
       VALUES ($1, $2, 30000, 0, 0, 0, 3000, 27000, $3)`, [april, f.employee, JSON.stringify([breakdown[2]])]);
    const may = (await pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status) VALUES ($1, 2026, 5, 'calculated') RETURNING id`,
      [f.company])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, periodic_taxable, annual_taxable, paye, net_pay)
       VALUES ($1, $2, 20000, 20000, 20000, 0, 2115, 17885)`, [may, f.employee]);
    const june = await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 6 }, [f.employee]);
    expect(june.get(f.employee)).toEqual({ periods: 1, periodicTaxable: 20_000, annualPayments: 10_000, tablePaye: 4_307 });
    // Not before the period itself, and not other tax years.
    expect((await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 3 }, [f.employee])).get(f.employee)).toBeUndefined();
    expect((await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2027, month: 3 }, [f.employee])).get(f.employee)).toBeUndefined();
  });
});
