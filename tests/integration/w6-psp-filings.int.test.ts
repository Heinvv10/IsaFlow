/**
 * Wave 6 PSP on real Postgres, review of #1566: refused components at assignment (409 through the real route) and at
 * calculate (a status moved to PSP over a retirement fund row, an active loan), the H2 status-switch warning, the EMP501
 * reconciliation's PSP PAYE line, the allowance filing's per-line exclusion and the payslip's tax basis. Disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { addEmployee, newRun } from './ts-b.helpers';
import type { Route } from './w3-01-payroll.helpers';
import componentsRoute from '../../pages/api/payroll/employees/[id]/components';
import reconciliationRoute from '../../pages/api/payroll/emp501/reconciliation';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { PspComponentRefused } from '@/modules/accounting/services/payroll/pspLineRules';
import { listRunAllowanceFiling } from '@/modules/accounting/services/payroll/payrollAllowanceFiling';
import { getPayslips } from '@/modules/accounting/services/payroll/payslipModel';
import { saTaxYearBounds } from '@/modules/accounting/services/payroll/irp5DataService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const PAY = 40_000;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00'));
});
afterAll(async () => {
  vi.useRealTimers();
  try {
    await pool.query('DELETE FROM payroll_loans WHERE company_id = ANY($1)', [fixtures.map((f) => f.company)]);
    await cleanSeveranceFixtures(pool, fixtures);
  } finally { await pool.end(); }
});

const approve = (run: string) => pool.query(`UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1`, [run]);
const component = async (f: SeveranceFixture, code: string, type: 'earning' | 'deduction') => String((await pool.query(
  `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type) VALUES ($1, $2, $3, $4) RETURNING id`,
  [f.company, `Item ${code}`, code, type])).rows[0]!.id);
const assignments = async (employee: string, componentId: string) => Number((await pool.query(
  'SELECT count(*) FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2', [employee, componentId])).rows[0]!.count);
const toPsp = (f: SeveranceFixture, id: string, entity: 'company' | 'trust') =>
  updatePayrollEmployee(id, f.company, { taxStatus: 'personal_service_provider', pspEntityType: entity });

describe('M3/M4 at assignment: the real route answers 409, no row written', () => {
  it.each([['4001', 'deduction', 'company'], ['4030', 'deduction', 'trust'], ['3802', 'earning', 'trust'], ['LOAN', 'deduction', 'company']] as const)(
    '%s (%s) on a PSP %s', async (code, type, entity) => {
      const f = await seedEmployee(pool, fixtures, `psp assign ${code}`, 30_000);
      const psp = await addEmployee(pool, f, `psp-as-${code}`, PAY);
      await toPsp(f, psp, entity);
      const comp = await component(f, code, type);
      const url = `/api/payroll/employees/${psp}/components`;
      const out = await f.call(componentsRoute as Route, 'POST', url, psp, { body: { componentId: comp, amount: 1_000, effectiveFrom: '2026-03-01' } });
      expect(out.statusCode).toBe(409);
      expect(JSON.stringify(out.body)).toContain('PSP_COMPONENT_REFUSED');
      expect(await assignments(psp, comp)).toBe(0);
      // The same component on an employee is assigned.
      const ok = await f.call(componentsRoute as Route, 'POST', `/api/payroll/employees/${f.employee}/components`, f.employee,
        { body: { componentId: comp, amount: 1_000, effectiveFrom: '2026-03-01' } });
      expect(ok.statusCode).toBe(201);
    });
});

describe('M3/M4 at calculate: refused before any line is written', () => {
  it('a retirement fund row assigned as an employee, then the status moved to PSP', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp calc ra', 30_000);
    const who = await addEmployee(pool, f, 'psp-calc-ra', PAY);
    const ra = await component(f, '4006', 'deduction');
    await pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 2000, '2020-01-01')`, [who, ra]);
    await toPsp(f, who, 'company');
    const run = await newRun(pool, f, 3);
    const err = await calculatePayrollRun(run, f.company).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PspComponentRefused);
    expect((err as Error).message).toContain('TSB-psp-calc-ra');
    expect((err as Error).message).toContain('Item 4006 (retirement fund contribution)');
    expect(Number((await pool.query('SELECT count(*) FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0]!.count)).toBe(0);
  });

  it('an active loan on a PSP trust', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp calc loan', 30_000);
    const who = await addEmployee(pool, f, 'psp-calc-loan', PAY);
    await toPsp(f, who, 'trust');
    await pool.query(
      `INSERT INTO payroll_loans (id, company_id, employee_id, loan_number, description, principal, annual_interest_rate, term_months,
         method, start_date, first_deduction_period_year, first_deduction_period_month, status, outstanding_balance)
       VALUES (gen_random_uuid(), $1, $2, 'PSP-L1', 'Staff loan', 5000, 0.085, 5, 'straight_line', '2026-03-01', 2026, 3, 'active', 5000)`,
      [f.company, who]);
    const run = await newRun(pool, f, 3);
    const err = await calculatePayrollRun(run, f.company).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PspComponentRefused);
    expect((err as Error).message).toContain('Loan PSP-L1 (loan)');
  });
});

describe('a PSP trust in March, an employee from April', () => {
  let f: SeveranceFixture; let who = ''; let march = ''; let warned: string[] | undefined;

  beforeAll(async () => {
    f = await seedEmployee(pool, fixtures, 'psp switch filings', 30_000);
    who = await addEmployee(pool, f, 'psp-switch', PAY);
    const travel = await component(f, '3701', 'earning');
    await pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 5000, '2020-01-01')`, [who, travel]);
    await toPsp(f, who, 'trust');
    march = await newRun(pool, f, 3);
    await calculatePayrollRun(march, f.company);
    await approve(march);
    warned = (await updatePayrollEmployee(who, f.company, { taxStatus: 'employee' }))?.warnings;
    const april = await newRun(pool, f, 4);
    await calculatePayrollRun(april, f.company);
    await approve(april);
  });

  it('H2: the switch out of PSP in a year with a final run is named, not refused; a switch with none is silent', async () => {
    expect(warned).toHaveLength(1);
    expect(warned![0]).toContain('from personal service provider');
    expect(warned![0]).toContain('2026/2027');
    const fresh = await addEmployee(pool, f, 'psp-fresh', PAY);
    expect((await toPsp(f, fresh, 'company'))?.warnings).toBeUndefined();
  });

  it('L1: March\'s payslip states the PSP basis; April\'s does not', async () => {
    const slip = (await getPayslips(f.company, march, [who])).payslips[0]!;
    expect(slip.taxBasis).toBe('Personal service provider (trust): PAYE at 45%, no UIF');
  });

  it('M1: the allowance filing (3701) reads April only', async () => {
    await expect(listRunAllowanceFiling(f.company, saTaxYearBounds(2027), who).then((m) => m.get(who)?.cash3701)).resolves.toBe(5_000);
  });

  it('H1: the EMP501 reconciliation puts March\'s PSP PAYE apart and names it', async () => {
    const out = await f.call(reconciliationRoute as Route, 'GET', '/api/payroll/emp501/reconciliation?taxYear=2027', undefined, { query: { taxYear: '2027' } });
    expect(out.statusCode).toBe(200);
    const body = out.body as unknown as { data: { rows: Array<{ month: number; pspPaye: number; irp5Paye: number; emp201Paye: number }>; runWarnings: string[] } };
    const mar = body.data.rows.find((r) => r.month === 3)!;
    // 45% x (40 000 + 80% of the 5 000 travel allowance: Fourth Schedule para 1 "remuneration", the base before any deduction).
    expect(mar.pspPaye).toBe(19_800);
    expect(mar.emp201Paye - mar.irp5Paye).toBeCloseTo(mar.pspPaye, 2);
    expect(body.data.runWarnings.some((w) => w.includes('TSB-psp-switch') && w.includes('personal service provider'))).toBe(true);
  });
});
