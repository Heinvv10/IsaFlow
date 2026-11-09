/**
 * TS-b on real Postgres: the real writer and year-to-date loader (calculatePayrollRun, loadPayeYearToDate) under SARS
 * PAYE-GEN-01-G21 (2027) Rev 1 p. 26 (independent contractor) and p. 28 (non-standard employment, 25%).
 *
 * A month whose PAYE did not come from the tables is no table period: the next table month is costed as a first period,
 * not trued up against it. A change of the work terms after calculation sends the run back (payrollRunRecalcGate).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { payrollTermsChangedSinceCalculation } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import type { PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00'));
});
afterAll(async () => {
  vi.useRealTimers();
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

type Terms = Partial<Pick<PayrollEmployee, 'taxStatus' | 'payBasis' | 'hoursPerWeek' | 'hoursPerDay' | 'dailyRate'>>;
/** Non-standard employment (G21 p. 28): 14 hours a week, 6 hours a day at R500 a day. */
const FLAT: Terms = { taxStatus: 'employee', payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 500 };
const STANDARD: Terms = { taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: 40, hoursPerDay: null, dailyRate: null };

async function run(f: SeveranceFixture, month: number, terms: Terms) {
  await updatePayrollEmployee(f.employee, f.company, terms);
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, status) VALUES ($1, $2, $3, 2026, 'draft')`,
    [id, f.company, month]);
  await calculatePayrollRun(id, f.company);
  await pool.query(`UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1`, [id]);
  const line = (await pool.query(
    `SELECT paye::float8 AS paye, uif_employee::float8 AS uif, sdl::float8 AS sdl, eti::float8 AS eti, sdl_applicable::float8 AS applicable, validation_results AS results
       FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [id, f.employee])).rows[0] as {
    paye: number; uif: number; sdl: number; eti: number; applicable: number; results: Array<{ code: string }>;
  };
  return { id, line };
}

describe('a month off the tables leaves the cumulative base', () => {
  it('a flat 25% month, then a table month: the table month is a first period (2 115), not trued up', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb flat then tables', 20_000);
    const march = await run(f, 3, FLAT);
    expect(march.line.paye).toBe(5_000);
    expect(march.line.results.map(r => r.code)).toContain('PAYE_OUTSIDE_TABLES');
    const april = await run(f, 4, STANDARD);
    expect(april.line.paye).toBe(2_115);
    const ytd = (await loadPayeYearToDate(f.company, crypto.randomUUID(), { month: 5, year: 2026 }, [f.employee])).get(f.employee)!;
    expect([ytd.periods, ytd.periodicTaxable, ytd.tablePaye]).toEqual([1, 20_000, 2_115]);
  });

  it('a contractor month takes no PAYE, UIF, SDL or ETI, and the next table month is a first period', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb contractor then tables', 20_000);
    const march = await run(f, 3, { taxStatus: 'independent_contractor' });
    expect([march.line.paye, march.line.uif, march.line.sdl, march.line.eti]).toEqual([0, 0, 0, 0]);
    expect((await run(f, 4, STANDARD)).line.paye).toBe(2_115);
  });

  it('a flat month keeps its SDL pay and takes UIF (an employee); a contractor month has none', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb flat sdl', 20_000);
    const flat = await run(f, 3, FLAT);
    expect([flat.line.applicable, flat.line.uif]).toEqual([20_000, 177.12]);
    const contractor = await run(f, 4, { taxStatus: 'independent_contractor' });
    expect(contractor.line.applicable).toBe(0);
  });
});

describe('the approval gate', () => {
  it('a tax status moved after calculation sends the run back', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb terms gate', 20_000);
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, status) VALUES ($1, $2, 3, 2026, 'draft')`, [id, f.company]);
    await calculatePayrollRun(id, f.company);
    expect(await payrollTermsChangedSinceCalculation(f.company, id, [f.employee])).toEqual([]);
    await updatePayrollEmployee(f.employee, f.company, { taxStatus: 'independent_contractor' });
    expect(await payrollTermsChangedSinceCalculation(f.company, id, [f.employee])).toEqual([f.employee]);
  });

  it.each([['hoursPerWeek', { hoursPerWeek: 30 }], ['dailyRate', { dailyRate: 450 }]] as const)('a changed %s sends the run back', async (_name, change) => {
    const f = await seedEmployee(pool, fixtures, `tsb gate ${_name}`, 20_000);
    await updatePayrollEmployee(f.employee, f.company, { payBasis: 'daily', dailyRate: 500, hoursPerWeek: 14, hoursPerDay: 6 });
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payroll_run_headers (id, company_id, period_month, period_year, status) VALUES ($1, $2, 3, 2026, 'draft')`, [id, f.company]);
    await calculatePayrollRun(id, f.company);
    await updatePayrollEmployee(f.employee, f.company, change);
    expect(await payrollTermsChangedSinceCalculation(f.company, id, [f.employee])).toEqual([f.employee]);
  });
});
