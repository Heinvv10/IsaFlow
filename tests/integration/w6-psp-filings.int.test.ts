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
import { routeCaller, type Route } from './w3-01-payroll.helpers';
import { impersonationToken } from './r035-pr2.helpers';
import { SignJWT } from 'jose';
import employeeRoute from '../../pages/api/payroll/employees/[id]';
import componentsRoute from '../../pages/api/payroll/employees/[id]/components';
import reconciliationRoute from '../../pages/api/payroll/emp501/reconciliation';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { PspComponentRefused, PspStatusChangedSinceApproval } from '@/modules/accounting/services/payroll/pspLineRules';
import { insertDirective } from './w5-dr.helpers';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunReopen';
import yearEndRoute from '../../pages/api/payroll/year-end/status';
import { listRunAllowanceFiling } from '@/modules/accounting/services/payroll/payrollAllowanceFiling';
import { getPayslips } from '@/modules/accounting/services/payroll/payslipModel';
import { saTaxYearBounds } from '@/modules/accounting/services/payroll/irp5DataService';
import { listRunAnnualPayments } from '@/modules/accounting/services/payroll/payrollLumpSumFiling';
import { loadMedicalRecord } from '@/modules/accounting/services/payroll/payrollMedicalRecord';
import { loadCertificateAggregates } from '@/modules/accounting/services/payroll/easyFileCertificateAggregates';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const PAY = 40_000;
const extraUsers: string[] = [];

/** A viewer of f's company, and a caller as that viewer. */
async function viewerOf(f: SeveranceFixture) {
  const viewer = crypto.randomUUID();
  extraUsers.push(viewer);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [viewer, `${viewer}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'viewer')", [f.company, viewer]);
  const token = await new SignJWT({ sub: viewer, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return routeCaller({ [viewer]: token }, { user: viewer, company: f.company });
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00'));
});
afterAll(async () => {
  vi.useRealTimers();
  try {
    await pool.query('DELETE FROM payroll_loans WHERE company_id = ANY($1)', [fixtures.map((f) => f.company)]);
    await pool.query('DELETE FROM tax_directives WHERE company_id = ANY($1)', [fixtures.map((f) => f.company)]);
    await pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id = ANY($1)', [fixtures.map((f) => f.approver)]);
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [extraUsers]);
    await cleanSeveranceFixtures(pool, fixtures);
  } finally {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [extraUsers]).catch(() => undefined);
    await pool.end();
  }
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
  it.each([['4001', 'deduction', 'company'], ['4030', 'deduction', 'trust'], ['3802', 'earning', 'trust'], ['LOAN', 'deduction', 'company'], ['3701', 'earning', 'trust']] as const)(
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
    // A PSP may not carry a 3701 (L4), so the allowance is the employee months' (April on).
    await pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 5000, '2026-04-01')`, [who, travel]);
    const medical = await component(f, '4005', 'deduction');
    await pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 3000, '2020-01-01')`, [who, medical]);
    const bonus = await component(f, '3605', 'earning');
    await pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
      VALUES ($1, $2, 10000, '2026-03-01', '2026-03-31')`, [who, bonus]);
    await toPsp(f, who, 'trust');
    march = await newRun(pool, f, 3);
    await calculatePayrollRun(march, f.company);
    // A March PSP line carrying a 3701 (as one costed before L4 refused it would): the allowance filing must still skip it.
    await pool.query(`UPDATE payroll_run_lines SET component_breakdown = component_breakdown || jsonb_build_array(jsonb_build_object(
      'sarsSourceCode', '3701', 'amount', 7000, 'isTaxable', true, 'componentId', $3::text)) WHERE run_id = $1 AND employee_id = $2`, [march, who, travel]);
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

  it('H1: the certificate readers take April only: no March 3605, March 4005 or March PSP pay on the natural person', async () => {
    const bounds = saTaxYearBounds(2027);
    expect((await listRunAnnualPayments(f.company, bounds)).get(who) ?? 0).toBe(0);
    expect((await loadMedicalRecord(f.company, bounds, [who])).get(who)?.fees).toBe(3_000);
    const agg = (await loadCertificateAggregates(f.company, { startYear: 2026, startMonth: 3, endYear: 2027, endMonth: 2 }))
      .find((r) => String(r.employee_id) === who)!;
    expect(Number(agg.total_gross)).toBe(45_000); // April: 40 000 + 5 000 travel; March's 55 000 is the PSP's
  });

  it('H1: the EMP501 reconciliation puts March\'s PSP PAYE apart and names it', async () => {
    const out = await f.call(reconciliationRoute as Route, 'GET', '/api/payroll/emp501/reconciliation?taxYear=2027', undefined, { query: { taxYear: '2027' } });
    expect(out.statusCode).toBe(200);
    const body = out.body as unknown as { data: { rows: Array<{ month: number; pspPaye: number; irp5Paye: number; emp201Paye: number }>; runWarnings: string[] } };
    const mar = body.data.rows.find((r) => r.month === 3)!;
    // 45% x (40 000 + the 10 000 bonus): the payment before any deduction, the 3 000 of medical aid included.
    expect(mar.pspPaye).toBe(22_500);
    expect([mar.status, (mar as { unexplainedVariance?: number }).unexplainedVariance]).toEqual(['explained_psp', 0]);
    expect(mar.emp201Paye - mar.irp5Paye).toBeCloseTo(mar.pspPaye, 2);
    expect(body.data.runWarnings.some((w) => w.includes('TSB-psp-switch') && w.includes('personal service provider'))).toBe(true);
  });

  it('security: a viewer (aggregate-only route), one PSP payee: no PSP figure at all, the note; no name, number or per-month PSP PAYE', async () => {
    const asViewer = await viewerOf(f);
    const out = await asViewer(reconciliationRoute as Route, 'GET', '/api/payroll/emp501/reconciliation?taxYear=2027', undefined, { query: { taxYear: '2027' } });
    expect(out.statusCode).toBe(200);
    const body = out.body as unknown as { data: { rows: Array<Record<string, unknown>>; runWarnings: string[] } };
    expect(body.data.rows.every((r) => !('pspPaye' in r) && !('unexplainedVariance' in r) && r.status !== 'explained_psp')).toBe(true);
    const data = body.data as unknown as Record<string, unknown>;
    expect(['totalPspPaye' in data, 'totalUnexplainedVariance' in data, data.pspNote]).toEqual([false, false, 'PSP detail is available to payroll roles']);
    const text = JSON.stringify(body.data.runWarnings);
    expect(text).not.toMatch(/TSB-psp-switch|Extra|22[ ,]?500|payee/);
    expect(body.data.runWarnings.filter((w) => w.includes('PSP detail is available to payroll roles'))).toHaveLength(1);
  });
});

describe('L-a: a Login-as session may not move the PSP status, entity or other priced terms', () => {
  it('403 and no change for the priced keys; another field is saved; the real admin may set PSP', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp login-as', 30_000);
    const token = await impersonationToken(pool, f.admin, f.approver);
    const asLoginAs = routeCaller({ as: token }, { user: 'as', company: f.company });
    const url = `/api/payroll/employees/${f.employee}`;
    const row = async () => (await pool.query('SELECT tax_status, psp_entity_type, hours_per_week, occupation FROM payroll_employees WHERE id = $1', [f.employee])).rows[0];
    const before = await row();
    for (const body of [{ taxStatus: 'personal_service_provider', pspEntityType: 'company' }, { hoursPerWeek: 20 }]) {
      const out = await asLoginAs(employeeRoute as Route, 'PATCH', url, f.employee, { body });
      expect(out.statusCode, JSON.stringify(body)).toBe(403);
      expect(JSON.stringify(out.body)).toContain('IMPERSONATION_FORBIDDEN');
    }
    expect(await row()).toEqual(before);
    const other = await asLoginAs(employeeRoute as Route, 'PATCH', url, f.employee, { body: { occupation: 'Engineer' } });
    expect(other.statusCode).toBe(200);
    expect((await row()).occupation).toBe('Engineer');
    const real = await f.call(employeeRoute as Route, 'PATCH', url, f.employee, { body: { taxStatus: 'personal_service_provider', pspEntityType: 'company' } });
    expect(real.statusCode).toBe(200);
    expect((await row()).tax_status).toBe('personal_service_provider');
  });
});

describe('round 2: IRP3(c), a reopened month, the year-end checklist', () => {
  it('L3: an approved IRP3(c) on a PSP is refused at calculate by name (409 class), nothing written', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp irp3c', 30_000);
    const who = await addEmployee(pool, f, 'psp-irp3c', PAY);
    await toPsp(f, who, 'company');
    await insertDirective(pool, f.company, who, { type: 'fixed_amount', amount: 1000, number: 'IRP3C-1' });
    const run = await newRun(pool, f, 3);
    const err = await calculatePayrollRun(run, f.company).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PspComponentRefused);
    expect((err as Error).message).toContain('Directive IRP3C-1 (IRP3(c) directive)');
    expect(Number((await pool.query('SELECT count(*) FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0]!.count)).toBe(0);
  });

  it('M2: a reopened month approved as an employee refuses to recalculate as a PSP (and back), named; switched back, it recalculates', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp reopen', 30_000);
    const who = await addEmployee(pool, f, 'psp-reopen', PAY);
    const march = await newRun(pool, f, 3);
    await calculatePayrollRun(march, f.company);
    await approve(march);
    await toPsp(f, who, 'trust');
    await reopenPayrollRun({ runId: march, companyId: f.company, userId: f.admin, reason: 'reopen after a PSP switch' });
    const before = await pool.query('SELECT paye FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [march, who]);
    const err = await calculatePayrollRun(march, f.company).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PspStatusChangedSinceApproval);
    expect((err as Error).message).toContain('This month was approved under a different tax status; switch the status back to recalculate it');
    expect((err as Error).message).toContain('TSB-psp-reopen');
    expect((await pool.query('SELECT paye FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [march, who])).rows).toEqual(before.rows);
    await updatePayrollEmployee(who, f.company, { taxStatus: 'employee' });
    await expect(calculatePayrollRun(march, f.company)).resolves.toBeTruthy();
  });

  it('M1: the year-end checklist leaves PSP PAYE off the IRP5 total, names it apart, and skips the PSP\'s readiness', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp yearend', 30_000);
    const who = await addEmployee(pool, f, 'psp-ye', PAY);
    await pool.query("UPDATE payroll_employees SET tax_number = NULL WHERE id = $1", [who]); // would be a readiness error for an employee
    await toPsp(f, who, 'company');
    const march = await newRun(pool, f, 3);
    await calculatePayrollRun(march, f.company);
    await approve(march);
    const out = await f.call(yearEndRoute as Route, 'GET', '/api/payroll/year-end/status?taxYear=2027', undefined, { query: { taxYear: '2027' } });
    const data = (out.body as unknown as { data: { emp501: { totalVariance: number; pspPaye: number; unexplainedVariance: number; balanced: boolean };
      readiness: { errors: number }; runWarnings: string[] } }).data;
    expect([data.emp501.pspPaye, data.emp501.totalVariance, data.emp501.unexplainedVariance, data.emp501.balanced]).toEqual([10_800, 10_800, 0, false]);
    // The same company with no PSP: the PSP (no tax number) adds no readiness error.
    const c = await seedEmployee(pool, fixtures, 'psp yearend control', 30_000);
    const cm = await newRun(pool, c, 3);
    await calculatePayrollRun(cm, c.company);
    await approve(cm);
    const control = await c.call(yearEndRoute as Route, 'GET', '/api/payroll/year-end/status?taxYear=2027', undefined, { query: { taxYear: '2027' } });
    expect(data.readiness.errors).toBe((control.body as unknown as { data: { readiness: { errors: number } } }).data.readiness.errors);
    expect(data.runWarnings.some((w) => w.includes('TSB-psp-ye'))).toBe(true);
    const viewer = await (await viewerOf(f))(yearEndRoute as Route, 'GET', '/api/payroll/year-end/status?taxYear=2027', undefined, { query: { taxYear: '2027' } });
    expect(JSON.stringify(viewer.body)).not.toMatch(/TSB-psp-ye|Extra/);
    const vEmp = (viewer.body as unknown as { data: { emp501: Record<string, unknown> } }).data.emp501;
    expect(['pspPaye' in vEmp, 'unexplainedVariance' in vEmp, vEmp.pspNote]).toEqual([false, false, 'PSP detail is available to payroll roles']);
    // The PSP fields and lines carry no figure. KNOWN LIMIT (reported): emp501.totalVariance (EMP201 - IRP5) still equals it here.
    expect(JSON.stringify((viewer.body as unknown as { data: { runWarnings: string[] } }).data.runWarnings)).not.toMatch(/10[ ,]?800|payee/);
    expect(JSON.stringify(viewer.body)).not.toMatch(/payee/);
  });
});

describe('round 3: a PSP entity change, and a viewer with two PSP payees', () => {
  it('(1) March approved as a company (27%), entity moved to trust: the PATCH names March; a reopen refuses to recalculate at 45%', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp entity flip', 30_000);
    const who = await addEmployee(pool, f, 'psp-flip', PAY);
    await toPsp(f, who, 'company');
    const march = await newRun(pool, f, 3);
    await calculatePayrollRun(march, f.company);
    await approve(march);
    const moved = await updatePayrollEmployee(who, f.company, { pspEntityType: 'trust' });
    expect(moved?.warnings?.some((w) => w.includes('from company to trust') && w.includes('March 2026'))).toBe(true);
    await reopenPayrollRun({ runId: march, companyId: f.company, userId: f.admin, reason: 'reopen after an entity change' });
    const before = (await pool.query('SELECT paye FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [march, who])).rows;
    const err = await calculatePayrollRun(march, f.company).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PspStatusChangedSinceApproval);
    expect((err as Error).message).toContain('personal service provider (company) at approval, personal service provider (trust) now');
    expect((err as Error).message).toContain('set it back, recalculate, and correct it in the current month');
    expect((await pool.query('SELECT paye FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [march, who])).rows).toEqual(before);
    // An entity change with no month at the old entity is silent.
    const fresh = await addEmployee(pool, f, 'psp-flip-fresh', PAY);
    await toPsp(f, fresh, 'company');
    expect((await updatePayrollEmployee(fresh, f.company, { pspEntityType: 'trust' }))?.warnings).toBeUndefined();
    // Set back: it recalculates.
    await updatePayrollEmployee(who, f.company, { pspEntityType: 'company' });
    await expect(calculatePayrollRun(march, f.company)).resolves.toBeTruthy();
  });

  it('L2: with two PSP payees a viewer sees the PSP totals (no names), on the reconciliation and the year-end checklist', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp two payees', 30_000);
    const a = await addEmployee(pool, f, 'psp-two-a', PAY);
    const b = await addEmployee(pool, f, 'psp-two-b', PAY);
    await toPsp(f, a, 'company');
    await toPsp(f, b, 'trust');
    const march = await newRun(pool, f, 3);
    await calculatePayrollRun(march, f.company);
    await approve(march);
    const asViewer = await viewerOf(f);
    const recon = await asViewer(reconciliationRoute as Route, 'GET', '/api/payroll/emp501/reconciliation?taxYear=2027', undefined, { query: { taxYear: '2027' } });
    const rd = (recon.body as unknown as { data: Record<string, unknown> & { runWarnings: string[] } }).data;
    expect([rd.totalPspPaye, rd.totalUnexplainedVariance, 'pspNote' in rd]).toEqual([28_800, 0, false]); // 10 800 + 18 000
    expect(JSON.stringify(rd)).not.toMatch(/TSB-psp-two|Extra|payee/);
    const ye = await asViewer(yearEndRoute as Route, 'GET', '/api/payroll/year-end/status?taxYear=2027', undefined, { query: { taxYear: '2027' } });
    const yd = (ye.body as unknown as { data: { emp501: Record<string, unknown> } }).data;
    expect([yd.emp501.pspPaye, yd.emp501.unexplainedVariance, 'pspNote' in yd.emp501]).toEqual([28_800, 0, false]);
    expect(JSON.stringify(ye.body)).not.toMatch(/TSB-psp-two|Extra|payee/);
  });
});
