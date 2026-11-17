/**
 * Wave 6 PSP on real Postgres (migration 999r): personal service providers. The CHECKs (the status widened as a superset,
 * the entity pair), the PATCH route through the real chain (withAuth, app_user, RLS) for two tenants, the run's figures
 * at 10x amounts (SARS PAYE-GEN-01-G01-A06 row 6: 27% company, 45% trust; no UIF, UIC Act s1 "remuneration" (b); SDL
 * levied, G21 p. 12; no ETI, ETI Act s6(b)), the stale-run gate on the entity, a later-dated month on the tables with no
 * PSP month in its year to date, and the guard: a PSP is costed, but refused for the IRP5 by name. Disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { addEmployee, lineOf, newRun } from './ts-b.helpers';
import type { Route } from './w3-01-payroll.helpers';
import employeeRoute from '../../pages/api/payroll/employees/[id]';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { payrollTermsChangedSinceCalculation } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { assertRunKindSupported, RunKindUnsupportedError } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const PSP_PAY = 400_000; // 10x the oracle's R40 000

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00'));
});
afterAll(async () => {
  vi.useRealTimers();
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const row = async (id: string) => (await pool.query('SELECT tax_status, psp_entity_type FROM payroll_employees WHERE id = $1', [id])).rows[0];

describe('999r: the CHECKs', () => {
  it('the old three statuses still hold; a PSP needs an entity, nobody else may have one, and only company or trust', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp checks', 20_000);
    const set = (status: string, entity: string | null) =>
      pool.query('UPDATE payroll_employees SET tax_status = $2, psp_entity_type = $3 WHERE id = $1', [f.employee, status, entity]);
    for (const s of ['employee', 'director', 'independent_contractor']) expect(await code(set(s, null)), s).toBeNull();
    expect(await code(set('personal_service_provider', null))).toBe('23514');
    expect(await code(set('employee', 'company'))).toBe('23514');
    expect(await code(set('personal_service_provider', 'partnership'))).toBe('23514');
    expect(await code(set('labour_broker', null))).toBe('23514');
    expect(await code(set('personal_service_provider', 'trust'))).toBeNull();
    const defs = (await pool.query(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'payroll_employees'::regclass
      AND conname IN ('payroll_employees_tax_status_check', 'payroll_employees_psp_entity_type_check', 'payroll_employees_psp_entity_pair')`)).rows;
    expect(defs.map((d) => [d.conname, d.convalidated]).sort()).toEqual([
      ['payroll_employees_psp_entity_pair', true], ['payroll_employees_psp_entity_type_check', true], ['payroll_employees_tax_status_check', true],
    ]);
  });
});

describe('the PATCH route, two tenants', () => {
  it('an admin sets PSP + trust on their own employee; the other tenant cannot touch it; a PSP with no entity is refused, no row changed', async () => {
    const a = await seedEmployee(pool, fixtures, 'psp route A', 20_000);
    const b = await seedEmployee(pool, fixtures, 'psp route B', 20_000);
    const url = `/api/payroll/employees/${a.employee}`;
    const bare = await a.call(employeeRoute as Route, 'PATCH', url, a.employee, { body: { taxStatus: 'personal_service_provider' } });
    expect(bare.statusCode).toBe(400);
    expect(await row(a.employee)).toEqual({ tax_status: 'employee', psp_entity_type: null });

    const ok = await a.call(employeeRoute as Route, 'PATCH', url, a.employee, { body: { taxStatus: 'personal_service_provider', pspEntityType: 'trust' } });
    expect(ok.statusCode).toBe(200);
    expect(await row(a.employee)).toEqual({ tax_status: 'personal_service_provider', psp_entity_type: 'trust' });

    // Company B's admin, on company B, naming A's employee: not found, nothing moves.
    const cross = await b.call(employeeRoute as Route, 'PATCH', url, a.employee, { body: { pspEntityType: 'company' } });
    expect(cross.statusCode).toBe(404);
    expect(await row(a.employee)).toEqual({ tax_status: 'personal_service_provider', psp_entity_type: 'trust' });

    // Moving off PSP clears the entity in the same write.
    const off = await a.call(employeeRoute as Route, 'PATCH', url, a.employee, { body: { taxStatus: 'employee' } });
    expect(off.statusCode).toBe(200);
    expect(await row(a.employee)).toEqual({ tax_status: 'employee', psp_entity_type: null });
  });
});

describe('a run with PSPs of two tenants', () => {
  let a: SeveranceFixture; let b: SeveranceFixture; let pspA = ''; let pspB = ''; let runA = ''; let runB = '';

  beforeAll(async () => {
    a = await seedEmployee(pool, fixtures, 'psp run A', 30_000);
    b = await seedEmployee(pool, fixtures, 'psp run B', 30_000);
    pspA = await addEmployee(pool, a, "psp-a", PSP_PAY);
    pspB = await addEmployee(pool, b, "psp-b", PSP_PAY);
    await updatePayrollEmployee(pspA, a.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    await updatePayrollEmployee(pspB, b.company, { taxStatus: 'personal_service_provider', pspEntityType: 'trust' });
    runA = await newRun(pool, a, 3);
    runB = await newRun(pool, b, 3);
    await calculatePayrollRun(runA, a.company);
    await calculatePayrollRun(runB, b.company);
  });

  it('company: 27% of R400 000 = R108 000, no UIF, SDL 1% = R4 000, no ETI, flagged flat_psp', async () => {
    const l = await lineOf(pool, runA, pspA);
    expect([l.paye, l.uif, l.sdl, l.eti]).toEqual([108_000, 0, 4_000, 0]);
    expect(l.results.filter((r) => r.code === 'PAYE_OUTSIDE_TABLES').map((r) => r.treatment)).toEqual(['flat_psp']);
  });

  it('trust (the other tenant): 45% = R180 000; each run holds only its own company\'s people', async () => {
    const l = await lineOf(pool, runB, pspB);
    expect([l.paye, l.uif, l.sdl]).toEqual([180_000, 0, 4_000]);
    const people = async (run: string) => (await pool.query('SELECT employee_id FROM payroll_run_lines WHERE run_id = $1', [run])).rows.map((r) => r.employee_id).sort();
    expect(await people(runA)).toEqual([a.employee, pspA].sort());
    expect(await people(runB)).toEqual([b.employee, pspB].sort());
  });

  it('a changed entity after calculation sends the run back (stale-run gate)', async () => {
    await pool.query('UPDATE payroll_run_headers SET calculated_at = clock_timestamp() WHERE id = $1', [runA]);
    expect(await payrollTermsChangedSinceCalculation(a.company, runA, [pspA])).toEqual([]);
    await updatePayrollEmployee(pspA, a.company, { pspEntityType: 'trust' });
    expect(await payrollTermsChangedSinceCalculation(a.company, runA, [pspA])).toEqual([pspA]);
    await updatePayrollEmployee(pspA, a.company, { pspEntityType: 'company' });
  });

  it('a later month on the tables carries no PSP month in its year to date', async () => {
    await pool.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1`, [runB]);
    await updatePayrollEmployee(pspB, b.company, { taxStatus: 'employee' });
    const april = await newRun(pool, b, 4);
    await calculatePayrollRun(april, b.company);
    // Control: a fresh employee on the same pay in April has no year to date either.
    const c = await seedEmployee(pool, fixtures, 'psp control', 30_000);
    const fresh = await addEmployee(pool, c, "psp-c", PSP_PAY);
    await pool.query("UPDATE payroll_employees SET start_date = '2026-04-01' WHERE id = $1", [fresh]);
    const control = await newRun(pool, c, 4);
    await calculatePayrollRun(control, c.company);
    const after = await lineOf(pool, april, pspB);
    expect(after.paye).toBeGreaterThan(0);
    expect(after.paye).toBe((await lineOf(pool, control, fresh)).paye);
  });

  it('the guard costs a PSP, but refuses its company\'s IRP5 by name; another tenant\'s run is no refusal (not found)', async () => {
    await pool.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1`, [runA]);
    for (const action of ['calculate', 'approve', 'post', 'payslip', 'emp201', 'bank_file'] as const) {
      expect(await code(assertRunKindSupported(a.company, runA, action)), action).toBeNull();
    }
    const refused = await getIrp5EmployeeTotals(a.company, 2027).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(RunKindUnsupportedError);
    const number = String((await pool.query('SELECT employee_number FROM payroll_employees WHERE id = $1', [pspA])).rows[0]!.employee_number);
    expect((refused as Error).message).toContain(number);
    expect((refused as Error).message).toContain('personal service provider');
    expect(await code(assertRunKindSupported(b.company, runA, 'irp5'))).toBeNull();
  });
});
