/**
 * Wave 7 PP (W14, RS1): the portal lists every final slip an employee has, whatever its kind or frequency, newest pay
 * first, and prints the run's real period. Real routes on two tenants with real approved runs (PS3 snapshots); the
 * runs are made weekly / off-cycle by flipping the approved header in the disposable fixture, the way
 * ss-employee-portal-reads does (a FINAL run is judged as at its approval, FQd). Nothing here can send mail.
 * Claims:
 *  - an employee's own weekly slip and bonus slip are listed, each under its own period, beside the monthly one;
 *  - another employee's weekly/off-cycle slip in the same company and another company's are neither listed nor served;
 *  - the weekly PDF prints the week's dates, not the calendar month; the bonus PDF says Bonus;
 *  - a weekly off-cycle run (a kind the render refuses) is still not listed, so no listed slip 404s;
 *  - a reopened weekly slip leaves the list.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import list from '../../pages/api/employee-portal/payslips/index';
import slip from '../../pages/api/employee-portal/payslips/[runId]';
import { rig } from './brkr.helpers';
import { approvedRun } from './pe-payslip-email.helpers';
import { cleanup, doAccept, invite, lastToken, person, portal, putSetting, setPlatform, type R } from './ss-employee-portal.helpers';

vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 'w7-pp-portal-secret-for-tests-0123456789abcdef'; });

let a: R;
let b: R;
const emp = { one: '', two: '' };
const jars: Record<string, Record<string, string>> = {};
let monthly = '';
let weekly = '';
let bonus = '';
let bWeekly = '';

type Listed = { runId: string; periodLabel: string };
const listed = async (jar: Record<string, string>) => (await portal(list, 'GET', jar)).body.data as Listed[];
const getSlip = (jar: Record<string, string>, runId: string) =>
  portal(async (req: { query: Record<string, unknown> }, res: unknown) => {
    req.query = { runId };
    return (slip as unknown as (q: unknown, s: unknown) => Promise<unknown>)(req, res);
  }, 'GET', jar);
async function text(pdf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as { PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> } };
  return (await new PDFParse({ data: Buffer.from(pdf) }).getText()).text.replace(/\s+/g, ' ');
}
const year = async (r: R, runId: string) => Number((await r.pool.query('SELECT period_year FROM payroll_run_headers WHERE id = $1', [runId])).rows[0]!.period_year);

/** Lift 999n's freeze trigger for one header edit in the disposable fixture, and restore it ENABLE ALWAYS. */
async function setHeader(r: R, runId: string, set: string, values: unknown[]): Promise<void> {
  await r.pool.query('ALTER TABLE payroll_run_headers DISABLE TRIGGER trg_payroll_run_headers_final_frozen');
  try { await r.pool.query(`UPDATE payroll_run_headers SET ${set} WHERE id = $1`, [runId, ...values]); }
  finally { await r.pool.query('ALTER TABLE payroll_run_headers ENABLE ALWAYS TRIGGER trg_payroll_run_headers_final_frozen'); }
}
const makeWeekly = (r: R, runId: string, y: number, start: string, end: string) =>
  setHeader(r, runId, "pay_frequency = 'weekly', period_start = $2, period_end = $3", [`${y}-${start}`, `${y}-${end}`]);

async function onboard(r: R, employeeId: string, ip: string): Promise<Record<string, string>> {
  expect((await invite(r, employeeId)).statusCode).toBe(200);
  const jar: Record<string, string> = {};
  expect((await doAccept(jar, { token: lastToken(), password: 'correct horse battery' }, ip)).statusCode).toBe(200);
  return jar;
}

beforeAll(async () => {
  a = await rig('w7-pp-portal-a');
  b = await rig('w7-pp-portal-b');
  await a.setup();
  await b.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'employee-portal-%' OR key LIKE 'send:employee-portal-invite:%'");
  for (const r of [a, b]) { await setPlatform(r, true); expect((await putSetting(r, true)).statusCode).toBe(200); }
  emp.one = await person(a, 'pp-one@example.invalid', 'One');
  emp.two = await person(a, 'pp-two@example.invalid', 'Two');
  await a.pool.query("UPDATE payroll_employees SET end_date = '2026-01-31', status = 'terminated' WHERE id = $1", [emp.one]);
  await person(b, 'pp-b@example.invalid', 'Bee');
  weekly = await approvedRun(a, 1);   // One and Two: made a weekly run below
  monthly = await approvedRun(a, 2);  // Two only
  bonus = await approvedRun(a, 3);    // Two only: made a bonus run below
  bWeekly = await approvedRun(b, 1);
  jars.one = await onboard(a, emp.one, '198.18.7.1');
  jars.two = await onboard(a, emp.two, '198.18.7.2');
  await makeWeekly(a, weekly, await year(a, weekly), '01-19', '01-25');
  await setHeader(a, bonus, "run_kind = 'off_cycle', off_cycle_reason = 'bonus', run_date = period_start + 14", []);
  await makeWeekly(b, bWeekly, await year(b, bWeekly), '01-19', '01-25');
}, 240_000);
afterAll(async () => { for (const r of [a, b]) await cleanup(r); });

describe('portal payslips beyond monthly regular (wave 7 PP)', () => {
  it('lists the employee\'s weekly and bonus slips beside the monthly one, under their own periods, newest pay first', async () => {
    const y = await year(a, weekly);
    const rows = await listed(jars.two!);
    expect(rows.map((r) => [r.runId, r.periodLabel])).toEqual([
      [bonus, `Bonus, Mar ${y}`],
      [monthly, `February ${y}`],
      [weekly, `Week 19–25 Jan ${y}`],
    ]);
  });

  it('another employee\'s weekly or off-cycle slip, and another company\'s, are neither listed nor served', async () => {
    expect((await listed(jars.one!)).map((r) => r.runId)).toEqual([weekly]);
    for (const id of [monthly, bonus, bWeekly]) expect((await getSlip(jars.one!, id)).statusCode, id).toBe(404);
    expect((await getSlip(jars.two!, bWeekly)).statusCode).toBe(404);
    expect((await portal(list, 'GET', {})).statusCode).toBe(401);
  });

  it('the weekly PDF prints the week, not the calendar month; the bonus PDF says Bonus', async () => {
    const y = await year(a, weekly);
    const w = await getSlip(jars.two!, weekly);
    expect([w.statusCode, w.headers.get('content-type')]).toEqual([200, 'application/pdf']);
    const t = await text(w.body as unknown as Buffer);
    expect(t).toContain(`Pay period: Week 19–25 Jan ${y}`);
    expect(t).not.toContain(`01 Jan ${y} to 31 Jan ${y}`);
    expect(String(w.headers.get('content-disposition'))).toContain(`${y}-01-19`);
    expect(await text((await getSlip(jars.two!, bonus)).body as unknown as Buffer)).toContain(`Pay period: Bonus, Mar ${y}`);
  });

  it('a weekly off-cycle run (the render refuses it) is not listed, so no listed slip 404s', async () => {
    await setHeader(a, bonus, "pay_frequency = 'weekly'", []);
    try {
      expect((await getSlip(jars.two!, bonus)).statusCode).toBe(404);
      expect((await listed(jars.two!)).map((r) => r.runId)).not.toContain(bonus);
    } finally {
      await setHeader(a, bonus, "pay_frequency = 'monthly'", []);
    }
    expect((await listed(jars.two!)).map((r) => r.runId)).toContain(bonus);
  });

  it('a reopened weekly run leaves the list and its PDF is 404', async () => {
    await setHeader(a, weekly, "pay_frequency = 'monthly'", []);
    expect((await a.api.reopen(weekly)).statusCode).toBe(200);
    expect((await listed(jars.two!)).map((r) => r.runId)).not.toContain(weekly);
    expect((await getSlip(jars.two!, weekly)).statusCode).toBe(404);
  });
});
