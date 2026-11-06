/**
 * Wave 4 PS: payslips from the pay run, through the real routes (withAuth, app_user, RLS)
 * against the disposable fixture. Who may download (payroll-detail roles, a person's own
 * session; Login-as for one employee only), tenancy, no-store on every answer, one audit
 * row per download in the request transaction, the bank account's last four digits only,
 * final versus DRAFT by the R-035 guard, and the year to date tied to the IRP5 totals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import payslips from '../../pages/api/payroll/runs/[id]/payslips';
import employeePayslips from '../../pages/api/payroll/employees/[id]/payslips';
import createRun from '../../pages/api/payroll/runs';
import { rig, type Route } from './brkr.helpers';
import { impersonationToken } from './r035-pr2.helpers';
import { callRoute } from './r035-approval.helpers';
import { outsideRls } from './k1-employee-bank-details.helpers';
import { getIrp5EmployeeTotals } from '../../src/modules/accounting/services/payroll/irp5DataService';
import { getPayslips } from '../../src/modules/accounting/services/payroll/payslipModel';

const ACCOUNT = '62000123456';
let r: Awaited<ReturnType<typeof rig>>;
let emp = '', other = '', viewer = '', otherCompany = '', otherRun = '';
const runs: Record<string, string> = {};

async function pdfText(pdf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
  };
  return (await new PDFParse({ data: pdf }).getText()).text.replace(/\s+/g, ' ');
}

async function run(year: number, month: number, approve: boolean): Promise<string> {
  const made = await r.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year } });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const id = String(made.body.data!.id);
  expect((await r.api.calculate(id)).statusCode).toBe(200);
  if (approve) {
    const approved = await r.api.approve(id);
    expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
  }
  return id;
}

const slip = (token: string, runId: string, query: Record<string, string> = {}) =>
  callRoute(payslips as never, token, r.company, 'GET', undefined, `/api/payroll/runs/${runId}/payslips`, { id: runId, ...query });
const audits = async (runId: string) => (await r.pool.query(
  `SELECT user_id::text AS user_id, changes->'metadata' AS meta FROM audit_log
    WHERE company_id = $1 AND entity_type = 'payroll_payslips' AND entity_id = $2 ORDER BY created_at`,
  [r.company, runId])).rows as Array<{ user_id: string; meta: Record<string, string> }>;

beforeAll(async () => {
  r = await rig('payslips');
  await r.setup();
  emp = (await r.employee(30000)).employee;
  other = (await r.employee(24000)).employee;
  await r.pool.query(
    `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, branch_code)
     VALUES ($1, $2, 'FNB', $3, '250655')`, [r.company, emp, ACCOUNT]);
  viewer = await r.addUser('viewer');
  runs.feb25 = await run(2025, 2, true); // the tax year before: in neither year to date
  runs.dec = await run(2025, 12, true);
  runs.jan = await run(2026, 1, true);
  runs.feb = await run(2026, 2, true);
  runs.mar = await run(2026, 3, false); // calculated: DRAFT
  otherCompany = crypto.randomUUID();
  await r.pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [otherCompany, 'PS other company']);
  otherRun = (await r.pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status) VALUES ($1, 2, 2026, 'calculated') RETURNING id`,
    [otherCompany])).rows[0]!.id;
  const otherEmp = (await r.pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
     VALUES ($1, 'PS-OTHER', 'Other', 'Company', '2020-01-01') RETURNING id`, [otherCompany])).rows[0]!.id;
  await r.pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, net_pay) VALUES ($1, $2, 10000, 9000)`, [otherRun, otherEmp]);
}, 240000);

afterAll(async () => {
  await r.pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = $1', [r.admin]).catch(() => undefined);
  await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
  await r.pool.query('DELETE FROM payroll_bank_details WHERE company_id = $1', [r.company]).catch(() => undefined);
  await r.teardown([otherCompany]);
});

describe('who may download', () => {
  it('another company\'s run is 404, with no audit row', async () => {
    const res = await slip(r.tokens[r.admin]!, otherRun);
    expect(res.state.statusCode).toBe(404);
    expect(await audits(otherRun)).toEqual([]);
  });

  it('the model\'s own company predicate: with no RLS behind it, another company\'s run is not found', async () => {
    await expect(outsideRls(r.pool, r.company, () => getPayslips(r.company, otherRun))).rejects.toThrow('Pay run not found');
  });

  it('a viewer is 403', async () => {
    expect((await slip(r.tokens[viewer]!, runs.feb!, { employeeId: emp })).state.statusCode).toBe(403);
  });

  it('a token channel (claims with no session id) is 403', async () => {
    const token = await new SignJWT({ sub: r.admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const res = await slip(token, runs.feb!, { employeeId: emp });
    expect(res.state.statusCode).toBe(403);
    expect((res.state.body as { error: { details: { reason: string } } }).error.details.reason).toBe('AGENT_FORBIDDEN');
  });

  it('an employee not on the run is 404', async () => {
    expect((await slip(r.tokens[r.admin]!, runs.feb!, { employeeId: crypto.randomUUID() })).state.statusCode).toBe(404);
  });
});

describe('Login-as', () => {
  it('may download one employee\'s payslip: 200, and the audit row says impersonated', async () => {
    const token = await impersonationToken(r.pool, r.admin, r.approver);
    const before = (await audits(runs.jan!)).length;
    const res = await slip(token, runs.jan!, { employeeId: emp });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const rows = await audits(runs.jan!);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!.meta).toMatchObject({ impersonated: 'true', employeeIds: emp });
  });

  it('is refused the all-employees export: 403, and no audit row', async () => {
    const token = await impersonationToken(r.pool, r.admin, r.approver);
    const before = (await audits(runs.dec!)).length;
    const res = await slip(token, runs.dec!);
    expect(res.state.statusCode).toBe(403);
    expect((res.state.body as { error: { details: { reason: string } } }).error.details.reason).toBe('IMPERSONATION_FORBIDDEN');
    expect(await audits(runs.dec!)).toHaveLength(before);
  });
});

describe('every answer', () => {
  it('carries Cache-Control: no-store, success or refusal, on both routes', async () => {
    const answers = [
      await slip(r.tokens[r.admin]!, runs.feb!, { employeeId: emp }),
      await slip(r.tokens[r.admin]!, otherRun),
      await slip(r.tokens[viewer]!, runs.feb!),
      await slip(r.tokens[r.admin]!, runs.feb!, { disposition: 'nope' }),
      await callRoute(employeePayslips as never, r.tokens[r.admin]!, r.company, 'GET', undefined, `/api/payroll/employees/${emp}/payslips`, { id: emp }),
      await callRoute(employeePayslips as never, r.tokens[viewer]!, r.company, 'GET', undefined, `/api/payroll/employees/${emp}/payslips`, { id: emp }),
    ];
    expect(answers.map((a) => a.state.statusCode)).toEqual([200, 404, 403, 400, 200, 403]);
    for (const a of answers) expect(a.headers.get('cache-control')).toBe('no-store');
  });

  it('writes exactly one audit row per download', async () => {
    const before = (await audits(runs.feb!)).length;
    await slip(r.tokens[r.admin]!, runs.feb!, { employeeId: emp });
    await slip(r.tokens[r.admin]!, runs.feb!, { disposition: 'inline' });
    const rows = (await audits(runs.feb!)).slice(before);
    expect(rows.map((a) => [a.user_id, a.meta.employees, a.meta.impersonated])).toEqual([[r.admin, '1', 'false'], [r.admin, '2', 'false']]);
  });
});

describe('what the PDF says', () => {
  it('is a PDF with the stored net, the last four digits of the bank account and never the whole number', async () => {
    const res = await slip(r.tokens[r.admin]!, runs.feb!, { employeeId: emp });
    const pdf = res.state.body as Buffer;
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    const net = Number((await r.pool.query('SELECT net_pay FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [runs.feb, emp])).rows[0]!.net_pay);
    const text = await pdfText(pdf);
    expect(text).toContain(net.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    expect(text).toContain('account ending 3456');
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain('DRAFT');
  });

  it('a calculated run is DRAFT', async () => {
    expect(await pdfText((await slip(r.tokens[r.admin]!, runs.mar!, { employeeId: emp })).state.body as Buffer)).toContain('DRAFT');
  });

  it('an approved row the R-035 guard never cleared, not grandfathered, is DRAFT', async () => {
    const id = await run(2026, 4, false);
    await r.pool.query(`UPDATE payroll_run_headers SET status = 'approved', approved_plan_hash = 'never-reviewed' WHERE id = $1`, [id]);
    expect(await pdfText((await slip(r.tokens[r.admin]!, id, { employeeId: emp })).state.body as Buffer)).toContain('DRAFT');
  });
});

describe('year to date', () => {
  it('on the February run equals the IRP5 year totals for the employee, to the cent', async () => {
    const irp5 = (await outsideRls(r.pool, r.company, () => getIrp5EmployeeTotals(r.company, 2026, { employeeId: emp }))).rows[0]!;
    const ytd = (await outsideRls(r.pool, r.company, () => getPayslips(r.company, runs.feb!, [emp]))).payslips[0]!.yearToDate;
    expect(irp5.runsIncluded).toBe(3);
    expect(ytd).toEqual({
      grossPay: irp5.grossSalary, taxableIncome: irp5.taxableIncome, paye: irp5.paye, uifEmployee: irp5.uifEmployee, netPay: irp5.netPay,
    });
  });

  it('the history lists each run with its final state and stored net', async () => {
    const res = await callRoute(employeePayslips as never, r.tokens[r.admin]!, r.company, 'GET', undefined, `/api/payroll/employees/${emp}/payslips`, { id: emp });
    const entries = (res.state.body as { data: Array<{ periodYear: number; periodMonth: number; final: boolean }> }).data;
    expect(entries.slice(0, 2).map((e) => [e.periodYear, e.periodMonth, e.final])).toEqual([[2026, 4, false], [2026, 3, false]]);
    expect(entries.find((e) => e.periodYear === 2026 && e.periodMonth === 2)!.final).toBe(true);
    const otherCo = await callRoute(employeePayslips as never, r.tokens[r.admin]!, otherCompany, 'GET', undefined, `/api/payroll/employees/${emp}/payslips`, { id: emp });
    expect([401, 403, 404]).toContain(otherCo.state.statusCode);
  });
});

