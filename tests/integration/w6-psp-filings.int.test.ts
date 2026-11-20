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
import runInputsRoute from '../../pages/api/payroll/runs/[id]/inputs';
import { assignEmployeeComponentTool } from '@/lib/mcp/tools/writeEmployees';
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
import { loadFinalLineTotals } from '@/modules/accounting/services/payroll/preValidationReads';
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

/**
 * Security ruling 2026-11-19: a role without payroll-detail access NEVER sees a PSP split, on either aggregate-only route.
 * Every figure is on the old basis (IRP5 PAYE with PSP lines in), so with no other difference each month's variance and
 * the totals are nil and balanced holds, whatever the PSP payees; no PSP field, status or line exists for it.
 */
async function expectViewerSeesNoPspSplit(f: SeveranceFixture): Promise<void> {
  const asViewer = await viewerOf(f);
  const q = { query: { taxYear: '2027' } };
  type Recon = { rows: Array<Record<string, unknown> & { variance: number; irp5Paye: number; emp201Paye: number }>; totalVariance: number; totalIrp5: number; totalEmp201: number; runWarnings: string[] } & Record<string, unknown>;
  const r = ((await asViewer(reconciliationRoute as Route, 'GET', '/api/payroll/emp501/reconciliation?taxYear=2027', undefined, q)).body as unknown as { data: Recon }).data;
  for (const row of r.rows) {
    expect(['pspPaye' in row, 'unexplainedVariance' in row, row.status === 'explained_psp']).toEqual([false, false, false]);
    expect(row.variance).toBeCloseTo(0, 2);
    expect(row.irp5Paye).toBeCloseTo(row.emp201Paye, 2);
  }
  expect(['totalPspPaye' in r, 'totalUnexplainedVariance' in r, 'pspNote' in r]).toEqual([false, false, false]);
  expect(r.totalVariance).toBeCloseTo(0, 2);
  expect(r.totalIrp5).toBeCloseTo(r.totalEmp201, 2);
  expect(JSON.stringify(r.runWarnings)).not.toMatch(/personal service provider|PSP/i);
  type YearEnd = { emp501: Record<string, unknown> & { totalVariance: number; totalIrp5: number; totalEmp201: number; balanced: boolean }; payrollRuns: { totalPaye: number }; runWarnings: string[] };
  const y = ((await asViewer(yearEndRoute as Route, 'GET', '/api/payroll/year-end/status?taxYear=2027', undefined, q)).body as unknown as { data: YearEnd }).data;
  expect(['pspPaye' in y.emp501, 'unexplainedVariance' in y.emp501, 'pspNote' in y.emp501]).toEqual([false, false, false]);
  expect(y.emp501.totalVariance).toBeCloseTo(0, 2);
  expect(y.emp501.totalIrp5).toBeCloseTo(y.emp501.totalEmp201, 2);
  expect(y.payrollRuns.totalPaye).toBeCloseTo(y.emp501.totalEmp201, 2);
  expect(y.emp501.balanced).toBe(true);
  expect(JSON.stringify(y.runWarnings)).not.toMatch(/personal service provider|PSP/i);
}

describe('M3/M4 at assignment: the real route answers 409, no row written', () => {
  it.each([['4001', 'deduction', 'company'], ['4030', 'deduction', 'trust'], ['3802', 'earning', 'trust'], ['LOAN', 'deduction', 'company'], ['3701', 'earning', 'trust'],
    // RI (review of #1580 M1): reimbursive travel is s8(1)(b)'s, refused as 3701 is.
    ['3702', 'earning', 'company'], ['3703', 'earning', 'trust'], ['3722', 'earning', 'company']] as const)(
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

describe('RI (review of #1580 M1): a PSP takes no reimbursive travel on MCP, the run grid or calculate', () => {
  it('assign_employee_component refuses a 3703 for a PSP, no row written', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp mcp travel', 30_000);
    const psp = await addEmployee(pool, f, 'psp-mcp-tr', PAY);
    await toPsp(f, psp, 'company');
    const comp = await component(f, '3703', 'earning');
    const r = await assignEmployeeComponentTool.handler({ employee_id: psp, component_id: comp, amount: 1000, effective_from: '2026-03-01',
      idempotency_key: crypto.randomUUID() }, { companyId: f.company, userId: f.admin, scopes: ['write:payroll'], companyRole: 'owner', tokenJti: null, oauthAppId: null } as never) as
      { isError?: boolean; content: Array<{ text: string }> };
    expect([r.isError, r.content[0]!.text]).toEqual([true, expect.stringMatching(/personal service provider.*travel allowance/)]);
    expect(await assignments(psp, comp)).toBe(0);
  });

  it('the run grid refuses travel km for a PSP (409 PSP_COMPONENT_REFUSED), no row written', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp grid km', 30_000);
    const psp = await addEmployee(pool, f, 'psp-grid-km', PAY);
    await toPsp(f, psp, 'trust');
    await component(f, '3703', 'earning'); // the company's travel earning exists: only the PSP rule refuses
    const run = await newRun(pool, f, 3);
    const out = await f.call(runInputsRoute as Route, 'PUT', `/api/payroll/runs/${run}/inputs`, run,
      { body: { employeeId: psp, units: { kind: 'travel', multiplier: null, quantity: 1000, ratePerKm: 6, expectedQuantity: null } } });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(409);
    expect(JSON.stringify(out.body)).toContain('PSP_COMPONENT_REFUSED');
    expect(Number((await pool.query("SELECT count(*) FROM payroll_employee_components WHERE employee_id = $1 AND quantity_unit = 'km'", [psp])).rows[0]!.count)).toBe(0);
  });

  it('calculate refuses a PSP whose row carries travel km, whatever its code (written directly)', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp calc km', 30_000);
    const who = await addEmployee(pool, f, 'psp-calc-km', PAY);
    const fee = await component(f, '3601', 'earning');
    await pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, quantity, quantity_unit, effective_from, effective_to, is_recurring)
      VALUES ($1, $2, 6000, 1000, 'km', '2026-03-01', '2026-03-31', FALSE)`, [who, fee]);
    await toPsp(f, who, 'company');
    const run = await newRun(pool, f, 3);
    const err = await calculatePayrollRun(run, f.company).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PspComponentRefused);
    expect((err as Error).message).toContain('Item 3601 (travel allowance)');
    expect(Number((await pool.query('SELECT count(*) FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0]!.count)).toBe(0);
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

  it('H1: IRP5 pre-validation (wave 6 PV, merged after PSP) reads April only, never March\'s PSP line', async () => {
    const [row] = (await loadFinalLineTotals(f.company, 2027, who, null)) as Array<{ gross?: unknown }>;
    expect(Number(row!.gross)).toBe(45_000); // April: 40 000 + 5 000 travel; March's 50 000 is the PSP's
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

  it('security: a viewer, one PSP payee: no PSP split on either route (old basis, no PSP field or line)', async () => {
    await expectViewerSeesNoPspSplit(f);
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
    await expectViewerSeesNoPspSplit(f);
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

  it('security: with two PSP payees a viewer still sees no PSP split; a detail role sees 28 800', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp two payees', 30_000);
    const a = await addEmployee(pool, f, 'psp-two-a', PAY);
    const b = await addEmployee(pool, f, 'psp-two-b', PAY);
    await toPsp(f, a, 'company');
    await toPsp(f, b, 'trust');
    const march = await newRun(pool, f, 3);
    await calculatePayrollRun(march, f.company);
    await approve(march);
    await expectViewerSeesNoPspSplit(f);
    const d = (await f.call(reconciliationRoute as Route, 'GET', '/api/payroll/emp501/reconciliation?taxYear=2027', undefined, { query: { taxYear: '2027' } }))
      .body as unknown as { data: { totalPspPaye: number; totalUnexplainedVariance: number } };
    expect([d.data.totalPspPaye, d.data.totalUnexplainedVariance]).toEqual([28_800, 0]); // 10 800 + 18 000
  });
});

describe('security ruling 2026-11-19: differing PSP payee sets by month', () => {
  it('two PSPs in March, one alone in April: a viewer sees no PSP split in any month; a detail role sees 21 600 and 10 800', async () => {
    const f = await seedEmployee(pool, fixtures, 'psp per-month viewer', 30_000);
    const a = await addEmployee(pool, f, 'psp-pm-a', PAY);
    const b = await addEmployee(pool, f, 'psp-pm-b', PAY);
    await toPsp(f, a, 'company');
    await toPsp(f, b, 'company');
    const march = await newRun(pool, f, 3);
    await calculatePayrollRun(march, f.company);
    await approve(march);
    await pool.query("UPDATE payroll_employees SET end_date = '2026-03-31' WHERE id = $1", [b]); // B leaves: April has A alone
    const april = await newRun(pool, f, 4);
    await calculatePayrollRun(april, f.company);
    await approve(april);
    await expectViewerSeesNoPspSplit(f);
    type Recon = { data: { rows: Array<{ month: number; variance: number }> } };
    const d = ((await f.call(reconciliationRoute as Route, 'GET', '/api/payroll/emp501/reconciliation?taxYear=2027', undefined, { query: { taxYear: '2027' } })).body as unknown as Recon).data;
    expect([3, 4].map((m) => Math.round(d.rows.find((r) => r.month === m)!.variance * 100) / 100)).toEqual([21_600, 10_800]);
  });
});
