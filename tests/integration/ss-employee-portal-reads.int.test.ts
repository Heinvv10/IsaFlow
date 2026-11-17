/**
 * Wave 6 SS: what a signed-in employee reads in the portal, through the real routes on two tenants, with real
 * approved runs (PS3 snapshots). Nothing here can send: see ss-employee-portal.helpers.ts.
 * Claims:
 *  - an employee lists and downloads only their own final slips; another employee's run in the same company, and
 *    another company's run, are the same 404; the PDF is theirs alone;
 *  - a reopened run's slip disappears from the list and its PDF is 404; re-approved, it is back;
 *  - a final slip not frozen at its current approval (PS3 snapshot missing or stale) is neither listed nor served;
 *  - leave balances are the employee's own only;
 *  - every answer is no-store, and nothing answers without a portal session.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import list from '../../pages/api/employee-portal/payslips/index';
import slip from '../../pages/api/employee-portal/payslips/[runId]';
import leave from '../../pages/api/employee-portal/leave';
import { rig } from './brkr.helpers';
import { approvedRun } from './pe-payslip-email.helpers';
import { captured, cleanup, doAccept, invite, lastToken, person, portal, putSetting, setPlatform, type R } from './ss-employee-portal.helpers';

vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 'ss-employee-portal-secret-for-tests-0123456789abcdef'; });

let a: R;
let b: R;
const emp = { one: '', two: '' };
const jars: Record<string, Record<string, string>> = {};
let run1 = '';
let run2 = '';
let bRun = '';

const getSlip = (jar: Record<string, string>, runId: string) =>
  portal(async (req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { runId };
    return (slip as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }, 'GET', jar);
const runs = async (jar: Record<string, string>) => ((await portal(list, 'GET', jar)).body.data as Array<{ runId: string }>).map((r) => r.runId);
async function text(pdf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as { PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> } };
  return (await new PDFParse({ data: Buffer.from(pdf) }).getText()).text;
}
const number = async (r: R, id: string) => String((await r.pool.query('SELECT employee_number FROM payroll_employees WHERE id = $1', [id])).rows[0]!.employee_number);

async function onboard(r: R, employeeId: string, ip: string): Promise<Record<string, string>> {
  expect((await invite(r, employeeId)).statusCode).toBe(200);
  const jar: Record<string, string> = {};
  expect((await doAccept(jar, { token: lastToken(), password: 'correct horse battery' }, ip)).statusCode).toBe(200);
  return jar;
}

beforeAll(async () => {
  a = await rig('employee-portal-reads-a');
  b = await rig('employee-portal-reads-b');
  await a.setup();
  await b.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'employee-portal-%' OR key LIKE 'send:employee-portal-invite:%'");
  for (const r of [a, b]) { await setPlatform(r, true); expect((await putSetting(r, true)).statusCode).toBe(200); }
  emp.one = await person(a, 'one@example.invalid', 'One');
  emp.two = await person(a, 'two@example.invalid', 'Two');
  // One leaves after January: on run 1, not on run 2 (and still inside the leaver window).
  await a.pool.query("UPDATE payroll_employees SET end_date = '2026-01-31', status = 'terminated' WHERE id = $1", [emp.one]);
  await person(b, 'b@example.invalid', 'Bee');
  run1 = await approvedRun(a, 1);
  run2 = await approvedRun(a, 2);
  bRun = await approvedRun(b, 1);
  jars.one = await onboard(a, emp.one, '198.18.1.1');
  jars.two = await onboard(a, emp.two, '198.18.1.2');
  const lt = (await a.pool.query("INSERT INTO payroll_leave_types (company_id, name, bcea_type) VALUES ($1, 'Annual', 'annual') RETURNING id", [a.company])).rows[0]!.id;
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric' }).format(new Date()));
  await a.pool.query('INSERT INTO payroll_leave_balances (company_id, employee_id, leave_type_id, balance_year, accrued, taken) VALUES ($1,$2,$4,$5,15,3),($1,$3,$4,$5,21,1)',
    [a.company, emp.one, emp.two, lt, year]);
}, 240_000);
afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_leave_balances WHERE company_id = $1', [a.company]);
  await a.pool.query('DELETE FROM payroll_leave_types WHERE company_id = $1', [a.company]);
  for (const r of [a, b]) await cleanup(r);
  expect(captured.every((m) => [m.to].flat().every((to) => String(to).endsWith('@example.invalid')))).toBe(true);
});

describe('employee portal reads', () => {
  it('an employee sees and downloads only their own final slips', async () => {
    expect(await runs(jars.one!)).toEqual([run1]);
    expect(await runs(jars.two!)).toEqual([run2, run1]);
    const own = await getSlip(jars.one!, run1);
    expect([own.statusCode, own.headers.get('cache-control'), own.headers.get('content-type')]).toEqual([200, 'no-store', 'application/pdf']);
    const body = await text(own.body as unknown as Buffer);
    expect(body).toContain(await number(a, emp.one));
    expect(body).not.toContain(await number(a, emp.two));
    // Run 2 is another employee's slip in the same company (One has no line on it), and bRun is another company's.
    expect((await getSlip(jars.one!, run2)).statusCode).toBe(404);
    expect((await getSlip(jars.one!, bRun)).statusCode).toBe(404);
    expect((await getSlip({}, run1)).statusCode).toBe(401);
    expect((await portal(list, 'GET', {})).statusCode).toBe(401);
  });

  it('a reopened run\'s slip disappears, and comes back when re-approved', async () => {
    expect((await a.api.reopen(run1)).statusCode).toBe(200);
    expect(await runs(jars.two!)).toEqual([run2]);
    expect((await getSlip(jars.two!, run1)).statusCode).toBe(404);
    expect((await a.api.calculate(run1)).statusCode).toBe(200);
    await a.authorise(run1);
    expect((await a.api.approve(run1)).statusCode).toBe(200);
    expect(await runs(jars.two!)).toEqual([run2, run1]);
    expect((await getSlip(jars.two!, run1)).statusCode).toBe(200);
  });

  it('a final slip whose details were not frozen at this approval (a run approved before PS3) is not shown', async () => {
    expect(await runs(jars.two!)).toContain(run2);
    await a.pool.query('ALTER TABLE payroll_run_lines DISABLE TRIGGER USER');
    try {
      await a.pool.query('UPDATE payroll_run_lines SET payslip_snapshot = NULL WHERE run_id = $1', [run2]);
    } finally {
      await a.pool.query('ALTER TABLE payroll_run_lines ENABLE TRIGGER USER');
    }
    expect(await runs(jars.two!)).toEqual([run1]);
    expect((await getSlip(jars.two!, run2)).statusCode).toBe(404);
  });

  it('leave balances are the employee\'s own only', async () => {
    const one = await portal(leave, 'GET', jars.one!);
    expect([one.statusCode, one.headers.get('cache-control')]).toEqual([200, 'no-store']);
    expect(one.body.data).toEqual([expect.objectContaining({ leaveType: 'Annual', accrued: 15, taken: 3, balance: 12 })]);
    expect((await portal(leave, 'GET', jars.two!)).body.data).toEqual([expect.objectContaining({ accrued: 21, balance: 20 })]);
  });
});
