/**
 * TS-b on real Postgres, the gates and the contractor's reach: the approval refusal for unresolved terms, the stale-run gate
 * for EVERY work term, the SDL s4(b) threshold and the UI-19 (a contractor is no UIF contributor, and his fees are not remuneration).
 * PAYE-GEN-01-G21 (2027) Rev 1 p. 26 (contractor), p. 28 (classification).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { payrollTermsChangedSinceCalculation } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { runLinesRefusal } from '@/modules/accounting/services/payroll/payrollRunRecalcGate';
import { generateUifDeclaration, getUifDeclaration } from '@/modules/accounting/services/payroll/uifDeclarationService';
import { addEmployee, newRun, run, type Terms } from './ts-b.helpers';

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

const number = async (id: string) => String((await pool.query('SELECT employee_number FROM payroll_employees WHERE id = $1', [id])).rows[0]!.employee_number);

describe('approval refuses unresolved terms (employment_terms_unresolved)', () => {
  async function refusalFor(terms: Terms) {
    const f = await seedEmployee(pool, fixtures, 'tsb refusal', 20_000);
    await updatePayrollEmployee(f.employee, f.company, terms);
    const id = await newRun(pool, f, 3);
    await calculatePayrollRun(id, f.company);
    return { f, refusal: await runLinesRefusal(f.company, id) };
  }

  it('an hourly employee with no hours (EMPLOYMENT_UNDETERMINED) blocks approval, naming the employee', async () => {
    const { f, refusal } = await refusalFor({ payBasis: 'hourly', hourlyRate: 50 });
    expect(refusal?.code).toBe('employment_terms_unresolved');
    expect(refusal?.detail).toContain(await number(f.employee));
  });

  it('employment type director with tax status employee (DIRECTOR_STATUS_NOT_SET) blocks approval', async () => {
    expect((await refusalFor({ employmentType: 'director' })).refusal?.code).toBe('employment_terms_unresolved');
  });

  it('a director with the tax status set, a standard employee, and a contractor on default earnings are not refused', async () => {
    for (const terms of [{ employmentType: 'director', taxStatus: 'director' }, { hoursPerWeek: 40 }, { taxStatus: 'independent_contractor' }] as Terms[]) {
      expect((await refusalFor(terms)).refusal).toBeNull();
    }
  });
});

describe('the stale-run gate: every work term sends the run back', () => {
  const MOVES: Array<[string, Terms]> = [
    ['tax_status', { taxStatus: 'director' }],
    ['pay_basis', { payBasis: 'daily' }],
    ['hours_per_week', { hoursPerWeek: 30 }],
    ['hours_per_day', { hoursPerDay: 5 }],
    ['hourly_rate', { hourlyRate: 80 }],
    ['daily_rate', { dailyRate: 450 }],
    ['employment_type', { employmentType: 'casual' }],
  ];
  it.each(MOVES)('a changed %s after calculation forces a recalc', async (column, change) => {
    const f = await seedEmployee(pool, fixtures, `tsb gate ${column}`, 20_000);
    // A daily employee with a day rate and the hours, so a pay basis or rate change is a real move away from it.
    await updatePayrollEmployee(f.employee, f.company, { payBasis: 'monthly', dailyRate: 500, hourlyRate: 70, hoursPerWeek: 14, hoursPerDay: 6 });
    const id = await newRun(pool, f, 3);
    await calculatePayrollRun(id, f.company);
    expect(await payrollTermsChangedSinceCalculation(f.company, id, [f.employee])).toEqual([]);
    await updatePayrollEmployee(f.employee, f.company, change);
    expect(await payrollTermsChangedSinceCalculation(f.company, id, [f.employee])).toEqual([f.employee]);
  });
});

describe('a contractor is not remuneration (SDL s4(b)) and not a UIF contributor (UI-19)', () => {
  it('R400 000 of employees and R200 000 of contractor fees a year: the employer is under R500 000, so no SDL', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb sdl threshold', 33_333.33);
    const contractor = await addEmployee(pool, f, 'sdl-c', 16_666.67);
    await updatePayrollEmployee(contractor, f.company, { taxStatus: 'independent_contractor' });
    const id = await newRun(pool, f, 3);
    await calculatePayrollRun(id, f.company);
    const employee = (await pool.query('SELECT sdl::float8 AS sdl FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [id, f.employee])).rows[0]!;
    expect(employee.sdl).toBe(0);
    // The same pay with the second person an employee is R600 000: SDL is due (1% of 33 333.33).
    const g = await seedEmployee(pool, fixtures, 'tsb sdl threshold control', 33_333.33);
    await addEmployee(pool, g, 'sdl-e', 16_666.67);
    const controlRun = await newRun(pool, g, 3);
    await calculatePayrollRun(controlRun, g.company);
    expect((await pool.query('SELECT sdl::float8 AS sdl FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [controlRun, g.employee])).rows[0]!.sdl).toBe(333.33);
  });

  it('the history counts only employees too: a contractor month already approved does not lift a later month over R500 000', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb sdl history', 33_333.33);
    const contractor = await addEmployee(pool, f, 'sdl-h', 25_000);
    await run(pool, f, 3, { taxStatus: 'independent_contractor' }, contractor);
    const april = await newRun(pool, f, 4);
    await calculatePayrollRun(april, f.company);
    expect((await pool.query('SELECT sdl::float8 AS sdl FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [april, f.employee])).rows[0]!.sdl).toBe(0);
  });

  it('the UI-19 leaves the contractor off: one employee, his UIF, no line for the contractor', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb ui19', 20_000);
    const contractor = await addEmployee(pool, f, 'ui19-c', 10_000);
    await updatePayrollEmployee(contractor, f.company, { taxStatus: 'independent_contractor' });
    const id = await newRun(pool, f, 3);
    await calculatePayrollRun(id, f.company);
    await pool.query(`UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1`, [id]);
    const decl = await generateUifDeclaration(f.company, 2026, 3, f.approver);
    expect(decl.totalEmployees).toBe(1);
    const detail = await getUifDeclaration(f.company, decl.id);
    expect(detail!.lines.map(l => l.employeeId)).toEqual([f.employee]);
  });
});
